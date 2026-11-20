import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve, isAbsolute } from "node:path"
import { homedir, tmpdir } from "node:os"
import { createHash } from "node:crypto"
import {
  buildVisionRequest,
  parseVisionResponse,
  resolveVisionEndpoint,
  resolveVisionApiKey,
  postVisionRequest,
} from "./src/vision-http.ts"
import { prepareVisionImage, VisionCropError } from "./src/vision-crop.ts"

// Resolve the data dir (the skills.paths entry pointing at SKILL.md) relative
// to the bundle. When run from source, `import.meta.url` is plugin.ts and
// SKILL.md sits next to it. When run from the built dist/index.js, the
// package root (one level up from dist/) has SKILL.md. Plugin-directory
// installs (a lone dist/index.js copied into ~/.config/opencode/plugin/) have
// no SKILL.md sibling, so the lookup falls back to bundleDir harmlessly: the
// skills.paths scan finds no SKILL.md there and the manual copy documented
// in the README is the discovery mechanism for that install mode.
const bundleDir = dirname(fileURLToPath(import.meta.url))
const candidateDirs = [bundleDir, join(bundleDir, "..")]
const dataDir =
  candidateDirs.find((d) => existsSync(join(d, "SKILL.md"))) ?? bundleDir

// Inlined vision-agent prompt (previously subagent-body.md). Placeholder-free.
const bodyTpl: string = `You are a vision subagent. Your model is configured by the user through the opencode agent model override. Read each image file listed in the prompt, analyze only those images against the visual task, and respond with exactly one JSON object matching the response template.

## Input

The prompt contains a Visual Task (the exact visual question), Images to Inspect (local image paths and why each matters), a Response Template (the exact JSON shape to return), and Response Rules (task-specific constraints).

## Rules

- Report what you actually observe; do not guess. Be specific: positions, colors, sizes, alignment, visibility, ordering, etc.
- Include visual evidence wherever the template provides an evidence field; use \`null\` for facts that cannot be determined when the template permits null.
- For fine detail (small text, tiny UI elements) that your native view of an image cannot resolve, you MAY call the \`vision_analyze\` tool with a \`region\` crop [x1, y1, x2, y2] to zoom into that area before answering.
- If an image cannot be analyzed (corrupted, wrong format, file not found, or unsupported image modality), fill the template's uncertainty/failure fields honestly, preserving the exact template shape.
- Choose one concrete value for enum-like placeholders such as \`"pass | fail | inconclusive"\`.
- Emit exactly one JSON object: no prose, markdown fences, commentary, or extra keys.
- Do not spawn subagents. You are a leaf in the execution tree.`

type VisionModelEntry = {
  provider: string
  model_id: string
  name: string
  supportsImage: boolean
}

type RawModel = {
  id?: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
  }
}

type RawProvider = {
  env?: string[]
  models?: Record<string, RawModel>
}

type ProviderConfig = {
  whitelist?: string[]
  blacklist?: string[]
  models?: Record<string, RawModel>
  options?: { baseURL?: string }
}

type ConfigLike = {
  model?: string
  disabled_providers?: string[]
  enabled_providers?: string[]
  provider?: Record<string, ProviderConfig>
  providers?: Record<string, ProviderConfig>
}

type ModelsCatalog = Record<string, RawProvider>

let registeredModels = new Map<string, VisionModelEntry>()
// Folded (toLowerCase) "provider/model" keys of registered vision models;
// agent-name -> vision-capable map; top-level default capability. Populated
// in the config hook and read by the messages/system transforms. The state
// lives in a parameterizable object so the v2 setup path can run the SAME
// RV-1/RV-2 resolution helpers over its own instance (RB-2: the two entries
// share no mutable state) — v1 populates `v1Capability` in its config hook.
type VisionCapabilityState = {
  keys: Set<string>
  agents: Map<string, boolean>
  default: boolean
}
const v1Capability: VisionCapabilityState = {
  keys: new Set<string>(),
  agents: new Map<string, boolean>(),
  default: false,
}
const IMAGE_TMP_DIR = join(tmpdir(), "opencode-vision-delegate")

const PERMISSION = {
  edit: "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  external_directory: {
    [join(IMAGE_TMP_DIR, "*")]: "allow",
  },
}

// vision_analyze tool state: the tool's model source is the user's
// agent["vision-agent"].model override captured at config time. The plugin
// never writes `model` or `disable`; `disable: true` on vision-agent removes
// the tool from the registry.
const VISION_TOOL_NAME = "vision_analyze"
// 300s default — thinking-enabled vision models on real endpoints measured
// 20s+ per lightweight call; 60s ceilings them out. Override with
// OPENCODE_VISION_TIMEOUT_MS (>0 sets the ceiling, <=0 disables the timeout).
const DEFAULT_VISION_TOOL_TIMEOUT_MS = 300_000
function resolveVisionToolTimeoutMs(): number {
  const raw = process.env.OPENCODE_VISION_TIMEOUT_MS
  if (raw === undefined || raw.trim() === "") return DEFAULT_VISION_TOOL_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return DEFAULT_VISION_TOOL_TIMEOUT_MS
  return parsed
}
let visionToolModel: string | undefined
let visionToolDisabled = false
let visionToolTemperature: number | undefined
let visionToolExtraBody: Record<string, unknown> | undefined
let visionToolConfig: ConfigLike = {}
let visionToolCatalog: ModelsCatalog = {}

function homeDir(): string {
  return process.env.OPENCODE_TEST_HOME ?? homedir()
}

function xdgPath(kind: string, fallback: string): string {
  return process.env[kind] ?? join(homeDir(), fallback)
}

function opencodeConfigDir(): string {
  return resolve(
    process.env.OPENCODE_CONFIG_DIR ??
      join(xdgPath("XDG_CONFIG_HOME", ".config"), "opencode")
  )
}

function opencodeCacheDir(): string {
  return resolve(join(xdgPath("XDG_CACHE_HOME", ".cache"), "opencode"))
}

function opencodeDataDir(): string {
  return resolve(
    process.env.OPENCODE_DATA_DIR ??
      join(xdgPath("XDG_DATA_HOME", ".local/share"), "opencode")
  )
}

function opencodeModelsFile(): string {
  if (process.env.OPENCODE_MODELS_PATH) return resolve(process.env.OPENCODE_MODELS_PATH)
  const source = process.env.OPENCODE_MODELS_URL ?? "https://models.dev"
  const file =
    source === "https://models.dev"
      ? "models.json"
      : `models-${createHash("sha1").update(source).digest("hex")}.json`
  return join(opencodeCacheDir(), file)
}

function readModelsCatalog(): ModelsCatalog {
  try {
    const file = opencodeModelsFile()
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, "utf8")) as ModelsCatalog
  } catch {
    return {}
  }
}

function readAuthData(): Record<string, unknown> {
  try {
    if (process.env.OPENCODE_AUTH_CONTENT) {
      return JSON.parse(process.env.OPENCODE_AUTH_CONTENT) as Record<string, unknown>
    }
    const file = join(opencodeDataDir(), "auth.json")
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function mergeModel(existing: RawModel | undefined, override: RawModel): RawModel {
  if (!existing) return override
  return {
    ...existing,
    ...override,
    modalities: {
      ...existing.modalities,
      ...override.modalities,
    },
    limit: {
      ...existing.limit,
      ...override.limit,
    },
  }
}

function providerConfig(config: ConfigLike, providerID: string): ProviderConfig {
  const folded = providerID.toLowerCase()
  for (const section of [config.provider, config.providers]) {
    if (!section) continue
    for (const key of Object.keys(section)) {
      if (key.toLowerCase() === folded) return section[key] ?? {}
    }
  }
  return {}
}

// Canonicalize a provider id against the catalog: return the first catalog
// provider key whose lowercase form matches (catalog casing wins), falling
// back to the input id when the provider is absent from the catalog (e.g.
// config-only providers).
function canonicalProviderID(catalog: ModelsCatalog, id: string): string {
  const folded = id.toLowerCase()
  const existing = Object.keys(catalog).find((key) => key.toLowerCase() === folded)
  return existing ?? id
}

function configuredProviderIDs(config: ConfigLike, catalog: ModelsCatalog): string[] {
  const disabled = new Set(
    stringArray(config.disabled_providers).map((id) => id.toLowerCase())
  )
  const enabled = stringArray(config.enabled_providers)
  const explicit = Object.keys({
    ...(config.providers ?? {}),
    ...(config.provider ?? {}),
  })
  const envConfigured = Object.entries(catalog)
    .filter(([, provider]) => stringArray(provider.env).some((key) => Boolean(process.env[key])))
    .map(([id]) => id)
  const authConfigured = Object.entries(readAuthData())
    .filter(([, value]) => value !== null && typeof value === "object" && typeof (value as any).type === "string")
    .map(([id]) => id.replace(/\/+$/, ""))
  const ids =
    enabled.length > 0
      ? enabled
      : [...explicit, ...envConfigured, ...authConfigured]
  return Array.from(
    new Set(ids.map((id) => canonicalProviderID(catalog, id)))
  ).filter((id) => !disabled.has(id.toLowerCase()))
}

function modelInputModalities(model: RawModel): string[] {
  return stringArray(model.modalities?.input)
}

function isVisionModel(model: RawModel): boolean {
  const input = modelInputModalities(model)
  if (input.includes("image")) return true
  return input.length === 0 && model.attachment === true
}

function modelCapabilities(model: RawModel): { supportsImage: boolean } {
  const input = modelInputModalities(model)
  const supportsImage = input.includes("image") || (input.length === 0 && model.attachment === true)
  return { supportsImage }
}

// Case-insensitive id matching: the cached catalog
// (~/.cache/opencode/models.json) and opencode configs may use different
// casings for the same provider/model id (e.g. catalog stores `MiniMax-M3`
// while the config writes `minimax-m3`). All lookups fold ids to lowercase;
// outputs (registeredModels keys, subagent names) keep the catalog's
// canonical casing.

function foldKey(record: Record<string, unknown>, key: string): string {
  const folded = key.toLowerCase()
  const existing = Object.keys(record).find((k) => k.toLowerCase() === folded)
  return existing ?? key
}

function providerModels(
  providerID: string,
  catalog: ModelsCatalog,
  config: ConfigLike,
): Record<string, RawModel> {
  const configured = providerConfig(config, providerID)
  const catalogProvider =
    catalog[providerID] ?? catalog[String(providerID).toLowerCase()] ?? {}
  const models: Record<string, RawModel> = {
    ...(catalogProvider.models ?? {}),
  }

  for (const [key, override] of Object.entries(configured.models ?? {})) {
    const id = override.id ?? key
    const targetKey = foldKey(models, id)
    models[targetKey] = mergeModel(models[targetKey], override)
  }

  return models
}

function modelAllowed(providerConfig: ProviderConfig, modelID: string): boolean {
  const folded = modelID.toLowerCase()
  const blacklist = stringArray(providerConfig.blacklist).map((id) => id.toLowerCase())
  const whitelist = stringArray(providerConfig.whitelist).map((id) => id.toLowerCase())
  if (blacklist.includes(folded)) return false
  if (whitelist.length > 0 && !whitelist.includes(folded)) return false
  return true
}

function discoverVisionModels(catalog: ModelsCatalog, config: ConfigLike): VisionModelEntry[] {
  const result: VisionModelEntry[] = []
  for (const provider of configuredProviderIDs(config, catalog)) {
    const configured = providerConfig(config, provider)
    for (const [modelKey, model] of Object.entries(providerModels(provider, catalog, config))) {
      const modelID = modelKey
      if (!modelAllowed(configured, modelKey)) continue
      if (model.status === "deprecated") continue
      if (!isVisionModel(model)) continue
      result.push({
        provider,
        model_id: modelID,
        name: model.name ?? modelID,
        ...modelCapabilities(model),
      })
    }
  }
  result.sort((a, b) => `${a.provider}/${a.model_id}`.localeCompare(`${b.provider}/${b.model_id}`))
  return result
}

function splitModel(value: string): { provider: string; modelID: string } | undefined {
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return
  return {
    provider: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  }
}

// Capability-RESOLUTION key set: every catalog provider (merged with config
// provider model overrides) filtered by image-input capability. Unlike
// discoverVisionModels above, this is deliberately NOT gated by provider
// availability (enabled_providers / config provider blocks / env keys /
// auth.json): deciding whether the model ALREADY serving a request can see
// images must trust catalog metadata alone, because keyless providers
// (opencode Zen, `OPENCODE_API_KEY` unset, no auth.json entry) satisfy no
// availability signal yet are fully usable — gating here dropped their
// multimodal sessions' images into delegation markers (verified on
// opencode/space-bunny-free, 2026-09-25). Deprecated models are included:
// capability reflects the model actually handling the request, while RB-5's
// deprecated filter governs only the discovery/suggestion path.
function buildVisionModelKeys(
  catalog: ModelsCatalog,
  config: ConfigLike,
): Set<string> {
  const keys = new Set<string>()
  const providerIDs = new Set([
    ...Object.keys(catalog),
    ...Object.keys(config.provider ?? {}),
    ...Object.keys(config.providers ?? {}),
  ])
  for (const providerID of providerIDs) {
    const models = providerModels(providerID, catalog, config)
    for (const [modelKey, model] of Object.entries(models)) {
      if (isVisionModel(model)) keys.add(`${providerID}/${modelKey}`.toLowerCase())
    }
  }
  return keys
}

function configuredModelVisionCapable(
  model: string | undefined,
  catalog: ModelsCatalog,
  config: ConfigLike,
): boolean {
  if (!model) return false
  const parts = splitModel(model)
  if (!parts) return false
  const models = providerModels(parts.provider, catalog, config)
  const match = models[foldKey(models, parts.modelID)]
  return Boolean(match && isVisionModel(match))
}

// Resolve whether a user message's handling model is vision-capable.
// Order: (1) message info.model (providerID/modelID) folded vs visionModelKeys;
// (2) message info.agent vs agentVisionCapable; (3) defaultVisionCapable.
// UserMessage.model.modelID is the inline message type's field (NOT the Model
// type, which uses `id`).
function userMessageVisionCapable(
  info: {
    role: string
    agent?: string
    model?: { providerID?: string; modelID?: string }
  },
  state: VisionCapabilityState = v1Capability,
): boolean {
  const m = info.model
  if (
    m &&
    typeof m.providerID === "string" &&
    typeof m.modelID === "string" &&
    (m.providerID !== "" || m.modelID !== "")
  ) {
    return state.keys.has(`${m.providerID}/${m.modelID}`.toLowerCase())
  }
  if (typeof info.agent === "string" && state.agents.has(info.agent)) {
    return Boolean(state.agents.get(info.agent))
  }
  return state.default
}

// Request-level capability check (the system transform's input.model is the
// Model shape with providerID + id). Reuses the folded key set of the given
// capability state — same lookup as userMessageVisionCapable above.
function requestModelVisionCapable(
  model: { providerID?: unknown; id?: unknown } | undefined,
  state: VisionCapabilityState = v1Capability,
): boolean {
  return Boolean(
    model &&
      typeof model.providerID === "string" &&
      typeof model.id === "string" &&
      state.keys.has(`${model.providerID}/${model.id}`.toLowerCase()),
  )
}

function saveImagePart(
  url: string,
  sessionID: string,
  partID: string,
  ext: string,
): string {
  mkdirSync(IMAGE_TMP_DIR, { recursive: true })
  const stableID = createHash("sha256")
    .update(sessionID)
    .update("\0")
    .update(partID)
    .digest("hex")
    .slice(0, 24)
  const out = join(IMAGE_TMP_DIR, `vision-${stableID}.${ext}`)

  if (url.startsWith("data:")) {
    const comma = url.indexOf(",")
    if (comma < 0) throw new Error("Malformed image data URL")
    const payload = url.slice(comma + 1)
    if (!payload) throw new Error("Empty image data URL")
    writeFileSync(out, Buffer.from(payload, "base64"))
    return out
  }

  const src = url.startsWith("file://") ? fileURLToPath(url) : url
  copyFileSync(src, out)
  return out
}

function isImageMime(mime: string): boolean {
  if (mime.startsWith("image/")) return true
  return false
}

function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "png"
}

// Source D rewrite (RV-1): materialize user-dropped images as stable paths
// that the orchestrator can pass to the vision_analyze tool (or the
// vision-agent subagent fallback). Host-agnostic — called by the v1
// messages transform and the v2 session context hook with their own
// capability state instances.
function rewriteDroppedImages(
  messages: unknown[],
  state: VisionCapabilityState = v1Capability,
): void {
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const message = m as {
      info?: { role?: string }
      parts?: unknown[]
    }
    if (message.info?.role !== "user") continue
    // A vision-capable user message keeps image parts untouched (native
    // path). The rewrite loop below then runs only for text-only messages.
    if (userMessageVisionCapable(message.info as Parameters<typeof userMessageVisionCapable>[0], state)) continue
    for (const p of message.parts ?? []) {
      if (!p || typeof p !== "object") continue
      const part = p as {
        type?: string
        mime?: string
        url?: string
        id?: string
        filename?: string
      }
      if (part.type !== "file") continue
      if (!part.mime) continue
      if (!isImageMime(part.mime)) continue
      const originalFilename = part.filename ?? "image"
      let text: string
      try {
        const path = saveImagePart(
          part.url ?? "",
          (message.info as { sessionID?: string }).sessionID ?? "unknown-session",
          part.id ?? "unknown-part",
          mimeToExt(part.mime),
        )
        text = `[vision:dropped-image] ${JSON.stringify({
          mime: part.mime,
          path,
          originalFilename,
        })}`
      } catch (error) {
        text = `[vision:dropped-image-error] ${JSON.stringify({
          mime: part.mime,
          originalFilename,
          error: error instanceof Error ? error.message : String(error),
        })}`
      }
      ;(part as any).type = "text"
      ;(part as any).text = text
      ;(part as any).synthetic = true
    }
  }
}

// The [vision:native] system instruction (RV-2): injected only for
// vision-capable handling models; shared verbatim by the v1 system transform
// and the v2 session context hook.
const NATIVE_INSTRUCTION =
  "[vision:native] You receive image parts natively in this session. " +
  "Inspect images directly from the message. Do NOT use the vision skill for plain reading " +
  "and do NOT delegate visual tasks to a vision-* subagent. Exception: when small text or " +
  "fine detail is beyond native resolution, you MAY call vision_analyze WITH a `region` " +
  "argument to zoom into that area of an image FILE on disk."

// Host-agnostic vision_analyze execute core (change v2-plugin-api-port task
// 1.1): file reading, region crop, endpoint + key resolution, HTTP, parsing.
// Called by the v1 `tool()` wrapper (knobs snapshotted from the config-hook
// module state) and by the v2 `ctx.tool.transform` registration (knobs from
// the vision-agent agent record). Error categories are encoded in the message
// prefix so the skill can branch: "model not configured" (never falls back),
// "provider error" (falls back to the vision-agent subagent), "invalid
// response" (skill Step 6 retry), "crop error" / "missing image" (no request).
const VISION_TOOL_DESCRIPTION =
  "Performs a visual judgment on local image files with the configured vision model. " +
  "Pass `images` as [{id, path, region?}] (short contract ids plus local image paths), the exact visual " +
  "`question`, a `response_template` (JSON string defining the required response shape), and " +
  "optional `response_rules` for task-specific constraints. Returns exactly one JSON object " +
  "matching the response template. Optional per-image `region: [x1, y1, x2, y2]` (integer pixel " +
  "coordinates in the ORIGINAL image, x2/y2 exclusive, PNG only) crops that region in memory at " +
  "full resolution — load the full image first, then re-call with a region to zoom into small " +
  "text or fine detail."

type VisionAnalyzeArgs = {
  images: { id: string; path: string; region?: number[] }[]
  question: string
  response_template: string
  response_rules?: string
}

type VisionAnalyzeCtx = { directory?: string; abort?: AbortSignal }

// Everything execute needs beyond args: knob snapshot (model/disable/
// temperature/extraBody — the plugin never WRITES these, only reads) plus the
// config/catalog pair used for capability and endpoint/key resolution.
type VisionToolKnobs = {
  disabled: boolean
  model: string | undefined
  temperature: number | undefined
  extraBody: Record<string, unknown> | undefined
  config: ConfigLike
  catalog: ModelsCatalog
}

function v1VisionToolKnobs(): VisionToolKnobs {
  return {
    disabled: visionToolDisabled,
    model: visionToolModel,
    temperature: visionToolTemperature,
    extraBody: visionToolExtraBody,
    config: visionToolConfig,
    catalog: visionToolCatalog,
  }
}

async function runVisionAnalyze(
  args: VisionAnalyzeArgs,
  ctx: VisionAnalyzeCtx,
  knobs: VisionToolKnobs,
): Promise<string> {
  if (knobs.disabled) {
    throw new Error(
      'vision_analyze: vision-agent is disabled: set disable: false on agent["vision-agent"] to use this tool',
    )
  }
  if (!knobs.model) {
    throw new Error(
      'vision_analyze: model not configured: set agent["vision-agent"].model to a vision-capable ' +
        'provider/model (e.g. "minimax-cn-coding-plan/MiniMax-M3")',
    )
  }
  const parts = splitModel(knobs.model)
  if (!parts) {
    throw new Error(
      `vision_analyze: model not configured: invalid model id "${knobs.model}" (expected "provider/model")`,
    )
  }
  const models = providerModels(parts.provider, knobs.catalog, knobs.config)
  const match = models[foldKey(models, parts.modelID)]
  if (!match || !isVisionModel(match)) {
    throw new Error(
      `vision_analyze: model not configured: ${knobs.model} is not image-capable; set ` +
        'agent["vision-agent"].model to a vision-capable model',
    )
  }
  const endpoint = resolveVisionEndpoint(parts.provider, knobs.catalog, knobs.config, process.env)
  if (!endpoint.ok) throw new Error(`vision_analyze: provider error: ${endpoint.error}`)
  const apiKey = resolveVisionApiKey(
    parts.provider,
    knobs.catalog,
    knobs.config,
    readAuthData(),
    process.env,
  )
  if (!apiKey.ok) throw new Error(`vision_analyze: provider error: ${apiKey.error}`)
  const images: { id: string; path: string; base64: string; mime?: string }[] = []
  const disclosures: string[] = []
  for (const image of args.images) {
    const path = isAbsolute(image.path)
      ? image.path
      : typeof ctx.directory === "string"
        ? join(ctx.directory, image.path)
        : image.path
    if (!existsSync(path)) {
      throw new Error(`vision_analyze: missing image: ${path}`)
    }
    // Region crop (VT-8) runs inside the existing read loop — error
    // precedence (disabled -> model not configured -> provider error ->
    // missing image -> crop error) is unchanged for region-free calls.
    let prepared
    try {
      prepared = prepareVisionImage({ id: image.id, path, region: image.region })
    } catch (error) {
      if (error instanceof VisionCropError) {
        throw new Error(`vision_analyze: crop error: ${error.message}`)
      }
      throw error
    }
    if (prepared.disclosure) disclosures.push(prepared.disclosure)
    images.push({
      id: prepared.id,
      path: prepared.path,
      base64: prepared.base64,
      ...(prepared.mime ? { mime: prepared.mime } : {}),
    })
  }
  // Coordinate disclosure rides the prompt (VT-8): cropped images come
  // back with coordinates already in original-image space; the tool's
  // response contract stays exactly one template-matching JSON object.
  const question = disclosures.length
    ? `${args.question}\n\nRegion crop coordinate mapping:\n${disclosures.join("\n")}`
    : args.question
  const request = buildVisionRequest(
    parts.modelID,
    endpoint.value,
    images,
    question,
    args.response_template,
    args.response_rules,
    apiKey.value,
    { temperature: knobs.temperature, extraBody: knobs.extraBody },
  )
  const result = await postVisionRequest(request, {
    signal: ctx.abort,
    timeoutMs: resolveVisionToolTimeoutMs(),
  })
  if (!result.ok) throw new Error(`vision_analyze: provider error: ${result.error}`)
  const parsed = parseVisionResponse(result.text)
  if (!parsed.ok) throw new Error(`vision_analyze: invalid response: ${parsed.error}`)
  return parsed.text
}

function visionAnalyzeTool() {
  return tool({
    description: VISION_TOOL_DESCRIPTION,
    args: {
      images: tool.schema.array(
        tool.schema.object({
          id: tool.schema.string(),
          path: tool.schema.string(),
          region: tool.schema.optional(
            tool.schema.array(tool.schema.number().int()).min(4).max(4),
          ),
        }),
      ),
      question: tool.schema.string(),
      response_template: tool.schema.string(),
      response_rules: tool.schema.optional(tool.schema.string()),
    },
    async execute(args, ctx) {
      return runVisionAnalyze(args, ctx, v1VisionToolKnobs())
    },
  })
}

const plugin: Plugin = async () => ({
  config: async (cfg) => {
  const catalog = readModelsCatalog()
  const dynamicModels = discoverVisionModels(catalog, cfg as ConfigLike)
  registeredModels = new Map(
    dynamicModels.map((m) => [`${m.provider}/${m.model_id}`, m])
  )

  // Capability-resolution keys: the FULL catalog (see buildVisionModelKeys)
  // — availability-ungated so keyless-provider sessions resolve correctly.
  // The per-agent and default capability state below reuses the same
  // catalog+config source; agent entries are captured BEFORE the single
  // vision-agent registration so user-configured agents are included (the
  // subagent's own messages carry a vision info.model that wins first in
  // the transform).
  v1Capability.keys = buildVisionModelKeys(catalog, cfg as ConfigLike)
  v1Capability.default = configuredModelVisionCapable(cfg.model, catalog, cfg as ConfigLike)
  v1Capability.agents = new Map()
  const agentsSection = (cfg as ConfigLike & {
    agent?: Record<string, { model?: string } | undefined>
  }).agent ?? {}
  for (const [name, entry] of Object.entries(agentsSection)) {
    if (entry && typeof entry.model === "string") {
      v1Capability.agents.set(
        name,
        configuredModelVisionCapable(entry.model, catalog, cfg as ConfigLike),
      )
    }
  }

  // Register the skill for discovery: push the package data dir (which
  // contains SKILL.md) onto config.skills.paths. opencode scans **/SKILL.md
  // under each path, reading the live merged config at scan time
  // (packages/opencode/src/skill/index.ts: cfg.skills.paths -> scan, absolute
  // paths allowed, no trust gating — opencode has no skill_path_origins
  // mechanism, so there is nothing extra to mark). Every package install
  // mode (npm, github spec, file://) is covered by this single channel;
  // single-file installs use the manual SKILL.md copy from the README.
  const cfgAny = cfg as ConfigLike & {
    skills?: { paths?: string[] }
  }
  cfgAny.skills ??= {}
  cfgAny.skills.paths ??= []
  if (!cfgAny.skills.paths.includes(dataDir)) {
    cfgAny.skills.paths.push(dataDir)
  }

  // Register the single vision-agent subagent WITHOUT a default model. The
  // user supplies the model via the opencode agent model override
  // (`agent["vision-agent"].model`); the plugin never writes `model` or
  // `disable`, so user overrides and disable stay effective. opencode falls
  // back to the default model when none is set.
  cfg.agent ??= {}
  cfg.agent["vision-agent"] ??= {}
  // Register defaults WITHOUT clobbering user-set fields. temperature is a
  // native opencode agent option — keep the user's value if present and only
  // fall back to the plugin's 0.1 default.
  const existingVisionAgent = cfg.agent["vision-agent"] as
    | { temperature?: number }
    | undefined
  Object.assign(cfg.agent["vision-agent"], {
    description: "Visual judgment subagent. Consumes a prompt-authored visual task with image paths and a task-specific JSON response template. Not coupled to any screenshot tool or UI framework - works with locally stored images supported by the model. Configure its model via the opencode agent model override.",
    mode: "subagent",
    temperature: existingVisionAgent?.temperature ?? 0.1,
    prompt: bodyTpl,
    permission: PERMISSION,
  })

  // Capture the tool's model source and request knobs (and the disable flag)
  // from the user's vision-agent override. Read-only: the plugin never
  // writes these.
  const visionAgent = cfg.agent["vision-agent"] as
    | { model?: string; disable?: boolean; temperature?: number; extraBody?: Record<string, unknown> }
    | undefined
  visionToolModel =
    typeof visionAgent?.model === "string" && visionAgent.model ? visionAgent.model : undefined
  visionToolDisabled = visionAgent?.disable === true
  visionToolTemperature =
    typeof visionAgent?.temperature === "number" && Number.isFinite(visionAgent.temperature)
      ? visionAgent.temperature
      : undefined
  visionToolExtraBody =
    visionAgent?.extraBody && typeof visionAgent.extraBody === "object" && !Array.isArray(visionAgent.extraBody)
      ? visionAgent.extraBody
      : undefined
  visionToolConfig = cfg as ConfigLike
  visionToolCatalog = catalog
  },

  // Register vision_analyze natively. A getter keeps the registry view honest
  // when the user disables vision-agent (disable: true -> the tool is absent
  // from the registry, matching the subagent being hidden). execute()
  // additionally guards against a disabled/absent state.
  get tool(): Record<string, import("@opencode-ai/plugin").ToolDefinition> {
    return visionToolDisabled ? {} : { [VISION_TOOL_NAME]: visionAnalyzeTool() }
  },

  // Upgrade ask -> allow for vision_analyze permission requests only. An
  // explicit user deny (permission.vision_analyze = "deny") resolves before
  // this hook and is never overwritten. opencode's Permission object is
  // { id, type, pattern?, metadata, ... }; the tool name may appear in
  // `metadata.tool`, `permission`, `id`, or `type` depending on the runtime
  // version, so they are checked as a first-hit priority chain (not a set
  // membership): the most specific field wins, matching the kilo original's
  // `permission ?? id ?? type` semantics with metadata.tool preferred when
  // present.
  "permission.ask": async (input, output) => {
    const meta = (input.metadata ?? {}) as Record<string, unknown>
    const permissionField = (input as unknown as { permission?: unknown }).permission
    const name =
      (typeof meta.tool === "string" ? meta.tool : undefined) ??
      (typeof permissionField === "string" ? permissionField : undefined) ??
      input.id ??
      input.type
    if (name === VISION_TOOL_NAME && output.status === "ask") {
      output.status = "allow"
    }
  },

  // Source D: materialize user-dropped images as stable paths that the
  // orchestrator can pass to the vision_analyze tool (or the vision-agent
  // subagent fallback). Delegates to the shared RV-1 rewrite helper.
  "experimental.chat.messages.transform": async (_input, output) => {
    rewriteDroppedImages(output.messages, v1Capability)
  },

  // The system transform tells the orchestrator how images are routed in
  // this session: a vision-capable model handles them natively, while a
  // text-only model sees [vision:dropped-image] markers and delegates via
  // the vision_analyze tool (falling back to the vision-agent subagent).
  // The model is configured by the user via the opencode agent model
  // override on vision-agent. No model script or picker is involved.
  "experimental.chat.system.transform": async (input, output) => {
    // input.model is Model (has providerID + id, NOT modelID). Reuses the
    // folded key set lookup (shared with the v2 context hook).
    if (requestModelVisionCapable(input.model, v1Capability)) {
      output.system.push(NATIVE_INSTRUCTION)
      return
    }
    // Text-only path: inject nothing. The vision skill (SKILL.md) instructs
    // the orchestrator to call the vision_analyze tool first and fall back
    // to the vision-agent subagent on provider errors; the model is
    // configured by the user via the opencode agent model override.
  },
})

// ---------------------------------------------------------------------------
// v2 plugin entry (full V2 parity per change v2-plugin-api-port).
//
// opencode's v2 plugin architecture loads `setup(ctx)` from the same default
// export (the v1 loader only reads `server` and ignores `setup`; the v2
// loader only reads `setup` and ignores `server`). The v2 PluginContext now
// exposes every domain the v1 feature set needs — ctx.tool.transform (the
// vision_analyze tool), ctx.permission.hook("evaluate") (VT-3 auto-allow),
// ctx.session.hook("context") (RV-1/RV-2 routing), ctx.agent / ctx.skill
// (the subagent + skill registrations). The shared cores (runVisionAnalyze,
// rewriteDroppedImages, requestModelVisionCapable) are extracted above and
// reused by both entries, so V2 parity is wiring, not a second
// implementation. The two entries keep disjoint registration targets and
// share no mutable state (RB-2).
//
// Typed structurally (no import from `@opencode-ai/plugin/v2/*`): the stable
// 1.18 package does not ship v2 types, and the v2 surface is still moving.
// Domain access and the draft methods are guarded (`?.` plus typeof checks)
// so an older host without a domain — or a newer host with a changed domain
// shape — makes that registration a no-op instead of throwing.
type V2AgentDraft = {
  list(): Array<{ id: string }>
  get(id: string): unknown
  update(id: string, update: (agent: Record<string, unknown>) => void): void
  remove(id: string): void
}
type V2SkillDraft = {
  source?(source: { type: "directory"; path: string }): void
  add?(skill: {
    id: string
    name: string
    description?: string
    path: string
    content: string
  }): void
  list(): unknown[]
}
type V2ToolEditor = {
  add?(definition: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (args: unknown, ctx: unknown) => Promise<unknown>
  }): unknown
}
type V2AgentRecord = Record<string, unknown>
type V2AgentDomainHandle = {
  transform?(cb: (draft: V2AgentDraft) => void | Promise<void>): Promise<unknown>
  // Post-merge observation point (fix-v2-knob-capture-timing): if the host
  // domain exposes get/list OUTSIDE transform, they observe the MERGED agent
  // record (user config agent entries are merged after plugin transforms —
  // verified live on 2.3.2, see design.md). All uses are typeof-guarded.
  get?(id: string): unknown
  list?(): Array<{ id: string }>
}
type V2PluginContext = {
  agent?: V2AgentDomainHandle
  skill?: {
    transform?(cb: (draft: V2SkillDraft) => void | Promise<void>): Promise<unknown>
  }
  tool?: {
    transform?(cb: (editor: V2ToolEditor) => void | Promise<void>): Promise<unknown>
  }
  permission?: {
    hook?(name: "evaluate", cb: (event: unknown) => void | Promise<void>): unknown
  }
  session?: {
    hook?(name: "context", cb: (event: unknown) => void | Promise<void>): unknown
  }
  options?: unknown
}

// JSON Schema input contract for the v2 tool registration (task 2.1): the
// literal equivalent of the v1 tool.schema.* chain — images array of
// {id, path, region?} with region exactly 4 integers, required
// images/question/response_template, optional response_rules.
const VISION_ANALYZE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          path: { type: "string" },
          region: {
            type: "array",
            items: { type: "integer" },
            minItems: 4,
            maxItems: 4,
          },
        },
        required: ["id", "path"],
      },
    },
    question: { type: "string" },
    response_template: { type: "string" },
    response_rules: { type: "string" },
  },
  required: ["images", "question", "response_template"],
} as const

// Wrap the shared execute core's result text in the host's structured-content
// shape. VERIFIED against 2.3.2 (task 3.4): Tool.Result.content is
// `string | Array<{type:"text",text} | {type:"file",uri,mime,name?}>` — a bare
// string content is valid and consumed by the host (observed live: a probe
// tool returning {content:"..."} executed and its result reached the model).
function wrapV2ToolResult(text: string): { content: string } {
  return { content: text }
}

// VERIFIED against 2.3.2 (task 3.4, live observation + @opencode/schema
// 2.3.2 Agent.Info): the agent-domain record carries `model` as an OBJECT
// `{ id, providerID }` (a config string "providerID/modelID" under the
// `agents` map is folded by the host — observed in `debug agents`), request
// knobs under `request.settings` / `request.body` (config `request.body`
// propagates verbatim; observed: `thinking` landed in request.body), and the
// config-level disable flag lives in ConfigAgent.Info (`disabled`) — a
// disabled config agent is excluded from the domain before plugins see it,
// so the disable read stays a defensive leg. Legacy flat fields
// (model as string / temperature / extraBody) are kept as drift fallbacks.
function readV2AgentKnobs(record: unknown): {
  model: string | undefined
  disabled: boolean
  temperature: number | undefined
  extraBody: Record<string, unknown> | undefined
} {
  const agent = (record ?? {}) as {
    model?: unknown
    disable?: unknown
    disabled?: unknown
    temperature?: unknown
    extraBody?: unknown
    request?: {
      settings?: { temperature?: unknown }
      body?: unknown
    }
  }
  // model: object form {id, providerID} folds to "providerID/id"; a plain
  // string (older/flat shape) passes through.
  let model: string | undefined
  const m = agent.model
  if (typeof m === "string" && m) model = m
  else if (
    m &&
    typeof m === "object" &&
    typeof (m as { id?: unknown }).id === "string" &&
    typeof (m as { providerID?: unknown }).providerID === "string"
  ) {
    model = `${(m as { providerID: string }).providerID}/${(m as { id: string }).id}`
  }
  const temperatureCandidate = agent.request?.settings?.temperature
  return {
    model,
    disabled: agent.disable === true || agent.disabled === true,
    temperature:
      typeof temperatureCandidate === "number" && Number.isFinite(temperatureCandidate)
        ? temperatureCandidate
        : typeof agent.temperature === "number" && Number.isFinite(agent.temperature)
          ? agent.temperature
          : undefined,
    extraBody:
      agent.request?.body && typeof agent.request.body === "object" && !Array.isArray(agent.request.body)
        ? (agent.request.body as Record<string, unknown>)
        : agent.extraBody && typeof agent.extraBody === "object" && !Array.isArray(agent.extraBody)
          ? (agent.extraBody as Record<string, unknown>)
          : undefined,
  }
}

// --- fix-v2-knob-capture-timing: lazy execute-time knob resolution ---------
//
// Root cause (verified live on 2.3.2, 2026-11-20): the config → agent merge
// is the built-in plugin "opencode.agent"'s agent.transform, which runs AFTER
// ordinary plugin transforms. A plugin reading draft.get("vision-agent")
// inside its own transform sees `undefined` for config-defined entries while
// the FINAL merged record carries the config's model/variant. By the time any
// tool EXECUTES, all transforms have long finished and the merged record is
// settled in the agent domain — so knobs are resolved lazily at execute time
// instead of snapshotted at transform time.

// Module-state seams the v2 setup entry publishes for the lazy resolver.
let v2AgentDomain: V2AgentDomainHandle | undefined
let v2CatalogRef: ModelsCatalog = {}
let v2OptionsConfigRef: ConfigLike = {}
// Knobs observed inside the agent transform (kept as a middle source: on
// hosts where the draft DOES carry the record — e.g. a domain-created entry
// or a host that merges config before plugin transforms — this is a valid
// observation; on the broken ordering it is simply absent).
let v2TransformKnobs: ReturnType<typeof readV2AgentKnobs> | undefined

// Minimal JSONC tolerance for the config-file fallback: strip // and /* */
// comments and trailing commas, skipping string literals (a naive regex would
// eat "//" inside URLs). READ-ONLY path — nothing here ever writes.
export function stripJsoncForParse(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      out += c
      i++
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") {
          out += text[i]
          i++
        }
        out += text[i]
        i++
      }
      out += text[i] ?? ""
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

type OpencodeFileConfig = ConfigLike & {
  agent?: Record<string, V2AgentRecord | undefined>
}

// Config-file fallback (task 2.3): discover the host's global config the same
// way the host documents (OPENCODE_CONFIG_DIR, else XDG ~/.config/opencode),
// try opencode.json then opencode.jsonc, JSONC-tolerant parse. Returns
// undefined when no readable config exists. NEVER writes.
function readOpencodeConfigFile(): OpencodeFileConfig | undefined {
  const dir = opencodeConfigDir()
  for (const file of [join(dir, "opencode.json"), join(dir, "opencode.jsonc")]) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(stripJsoncForParse(readFileSync(file, "utf8")))
      if (parsed && typeof parsed === "object") return parsed as OpencodeFileConfig
    } catch {
      continue
    }
  }
  return undefined
}

// resolveV2Knobs (task 2.1): lazy, execute-time knob resolution. Source order:
//   1. agent-domain getter (ctx.agent.get("vision-agent")) — the merged record,
//      the primary post-merge observation point.
//   2. transform-time snapshot — valid wherever the draft carried the record.
//   3. config-file fallback — the host's own discovery, read-only.
//   4. unset — runVisionAnalyze keeps the byte-identical
//      "model not configured" error (incl. the agent["vision-agent"].model
//      guidance); no default model is ever invented.
export function resolveV2Knobs(): VisionToolKnobs {
  const base = { config: v2OptionsConfigRef, catalog: v2CatalogRef }
  try {
    if (typeof v2AgentDomain?.get === "function") {
      const record = v2AgentDomain.get("vision-agent")
      if (record !== undefined) {
        return { ...readV2AgentKnobs(record), ...base }
      }
    }
  } catch {
    // Domain drift/thrown getter degrades to the next source, never throws.
  }
  if (v2TransformKnobs) return { ...v2TransformKnobs, ...base }
  const fileConfig = readOpencodeConfigFile()
  if (fileConfig) {
    const entry = fileConfig.agent?.["vision-agent"]
    if (entry !== undefined) {
      const knobs = readV2AgentKnobs(entry)
      if (knobs.model !== undefined || knobs.disabled || knobs.temperature !== undefined || knobs.extraBody !== undefined) {
        return { ...knobs, config: { ...v2OptionsConfigRef, ...fileConfig }, catalog: v2CatalogRef }
      }
    }
  }
  return {
    disabled: false,
    model: undefined,
    temperature: undefined,
    extraBody: undefined,
    ...base,
  }
}

// Capability-map lazy refresh (task 2.2): the agent-name → vision-capability
// map was previously built ONLY from draft.list() at transform time, which
// cannot see config-merged agents on this host ordering. Wherever the domain
// exposes list/get OUTSIDE transform, the map is refreshed post-merge at
// context-hook time. On hosts without a post-merge list the transform-time map
// (possibly incomplete) is kept and the limitation is documented in README —
// the v2 routing decision is driven by the request MODEL first, so the map is
// a secondary signal there anyway.
export function refreshV2AgentsMap(state: VisionCapabilityState): void {
  try {
    if (typeof v2AgentDomain?.list !== "function") return
    const entries = v2AgentDomain.list() ?? []
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string") continue
      const record =
        typeof v2AgentDomain.get === "function" ? v2AgentDomain.get(entry.id) : undefined
      const model = (record as { model?: unknown } | undefined)?.model
      let modelStr: string | undefined
      if (typeof model === "string") modelStr = model
      else if (
        model &&
        typeof model === "object" &&
        typeof (model as { id?: unknown }).id === "string" &&
        typeof (model as { providerID?: unknown }).providerID === "string"
      ) {
        modelStr = `${(model as { providerID: string }).providerID}/${(model as { id: string }).id}`
      }
      if (modelStr !== undefined) {
        state.agents.set(entry.id, configuredModelVisionCapable(modelStr, v2CatalogRef, v2OptionsConfigRef))
      }
    }
  } catch {
    // Drift degrades to the existing map, never throws.
  }
}

// Permission evaluate guard (task 2.2). VERIFIED against 2.3.2 (task 3.4,
// live capture with an ask rule + a write-tool call): the evaluate event is
// PermissionEvaluation `{ sessionID, agent?, action, resources[], metadata?,
// source?: {type:"tool", messageID, id}, effect, message? }` — the tool
// identity is `action` and the decision is `effect` ("allow" | "deny" |
// "ask"). Only `ask` is upgraded to `allow`; an explicit `deny` is never
// touched. The v1-style chain (metadata.tool -> permission -> id -> type) is
// kept as a drift fallback for other host shapes.
function v2PermissionEvaluate(event: unknown): void {
  try {
    const e = (event ?? {}) as {
      action?: unknown
      metadata?: { tool?: unknown }
      permission?: unknown
      id?: unknown
      type?: unknown
      effect?: unknown
      decision?: { status?: unknown }
      status?: unknown
    }
    const name =
      (typeof e.action === "string" ? e.action : undefined) ??
      (typeof e.metadata?.tool === "string" ? e.metadata.tool : undefined) ??
      (typeof e.permission === "string" ? e.permission : undefined) ??
      (typeof e.id === "string" ? e.id : undefined) ??
      (typeof e.type === "string" ? e.type : undefined)
    if (name !== VISION_TOOL_NAME) return
    if (e.effect === "ask") e.effect = "allow"
    else if (e.decision && typeof e.decision === "object") {
      if (e.decision.status === "ask") e.decision.status = "allow"
    } else if (e.status === "ask") {
      e.status = "allow"
    }
  } catch {
    // Host-shape drift degrades to a no-op, never throws.
  }
}

// V2 media-part rewrite (RV-1 on v2). VERIFIED against 2.3.2 (task 3.4, live
// capture with an attached image): context-event messages are
// `{ id, role, content: parts[] }` (NOT the v1 `{info, parts}` shape) and an
// image part is `{ type:"media", media:{ source:{ type:"base64", data,
// mediaType } }, filename? }` (NOT v1's `{type:"file", mime, url}`). The
// per-request capability comes from event.model ({id, providerID} — verified
// matching requestModelVisionCapable); v2 messages carry no per-message
// model, so the request model decides for every user message. Materializes
// base64 image parts to the plugin temp dir and replaces them with the same
// [vision:dropped-image] marker JSON as v1.
function rewriteDroppedImagesV2(
  messages: unknown[],
  capable: boolean,
  sessionID: string,
): void {
  if (capable) return
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const message = m as { role?: unknown; content?: unknown; id?: unknown }
    if (message.role !== "user") continue
    if (!Array.isArray(message.content)) continue
    for (const p of message.content) {
      if (!p || typeof p !== "object") continue
      const part = p as {
        type?: unknown
        media?: {
          source?: { type?: unknown; data?: unknown; mediaType?: unknown; url?: unknown }
          mediaType?: unknown
        }
        filename?: unknown
      }
      if (part.type !== "media" || !part.media?.source) continue
      const mediaType =
        typeof part.media.source.mediaType === "string"
          ? part.media.source.mediaType
          : typeof part.media.mediaType === "string"
            ? part.media.mediaType
            : ""
      if (!isImageMime(mediaType)) continue
      const originalFilename = typeof part.filename === "string" ? part.filename : "image"
      // Base64 inline payload (verified shape) or a plain URL fallback.
      const payload =
        part.media.source.type === "base64" && typeof part.media.source.data === "string"
          ? `data:${mediaType};base64,${part.media.source.data}`
          : typeof part.media.source.url === "string"
            ? part.media.source.url
            : ""
      let text: string
      try {
        const path = saveImagePart(
          payload,
          sessionID,
          `${message.id ?? "msg"}-${originalFilename}-${message.content.indexOf(p)}`,
          mimeToExt(mediaType),
        )
        text = `[vision:dropped-image] ${JSON.stringify({
          mime: mediaType,
          path,
          originalFilename,
        })}`
      } catch (error) {
        text = `[vision:dropped-image-error] ${JSON.stringify({
          mime: mediaType,
          originalFilename,
          error: error instanceof Error ? error.message : String(error),
        })}`
      }
      const mutable = part as Record<string, unknown>
      mutable.type = "text"
      mutable.text = text
      delete mutable.media
    }
  }
}

// Session context hook (task 2.3): the RV-1/RV-2 routing seam on v2. Edits
// event.system (the [vision:native] instruction for vision-capable handling
// models) and event.messages (image materialization + marker rewrite for
// text-only models), reusing the same resolution helpers as the v1
// transforms with the v2 entry's own capability state. Any drift (missing
// arrays, alien shapes) degrades to pass-through.
// VERIFIED against 2.3.2 (task 3.4): event.model is `{ id, providerID }`
// (matches requestModelVisionCapable), event.system is an array of
// `{type:"text", text}` OBJECTS (a bare string push would corrupt it — the
// object form is used, with a string-form drift leg), and event.messages use
// the {id, role, content} shape handled by rewriteDroppedImagesV2.
function v2SessionContext(event: unknown, state: VisionCapabilityState): void {
  try {
    const e = (event ?? {}) as {
      system?: unknown
      messages?: unknown
      model?: { providerID?: unknown; id?: unknown }
      sessionID?: unknown
    }
    const capable = requestModelVisionCapable(e.model, state)
    if (Array.isArray(e.system) && capable) {
      // Observed shape: array of {type:"text", text} objects. If the array
      // holds bare strings (host drift), keep the string form.
      if (e.system.length === 0 || typeof e.system[0] === "object") {
        ;(e.system as unknown[]).push({ type: "text", text: NATIVE_INSTRUCTION })
      } else {
        ;(e.system as unknown[]).push(NATIVE_INSTRUCTION)
      }
    }
    if (Array.isArray(e.messages)) {
      rewriteDroppedImagesV2(
        e.messages as unknown[],
        capable,
        typeof e.sessionID === "string" ? e.sessionID : "unknown-session",
      )
    }
  } catch {
    // Host-shape drift degrades to pass-through, never throws.
  }
}

async function v2Setup(ctx: V2PluginContext): Promise<void> {
  // Knob + capability sources. V2 has no mutable global config object, so
  // the tool knobs resolve from the vision-agent agent record via the agent
  // domain (design decision 3) and capability resolution uses the cached
  // models catalog plus ctx.options as the config stand-in.
  // VERIFIED against 2.3.2 (task 3.4): ctx.options was observed as an EMPTY
  // object even with a populated opencode.json — it is not the user config.
  // Endpoint/key resolution therefore falls through to provider env vars and
  // the models catalog (the same priority chain, minus the config leg).
  const catalog = readModelsCatalog()
  const optionsConfig =
    ctx.options && typeof ctx.options === "object"
      ? (ctx.options as ConfigLike)
      : {}
  const v2Capability: VisionCapabilityState = {
    keys: buildVisionModelKeys(catalog, optionsConfig),
    agents: new Map<string, boolean>(),
    default: configuredModelVisionCapable(optionsConfig.model, catalog, optionsConfig),
  }
  // Lazy-resolution seams (fix-v2-knob-capture-timing): the domain handle and
  // the config/catalog pair are published to module state so resolveV2Knobs()
  // can read the MERGED vision-agent record at tool-execute time.
  v2AgentDomain = ctx.agent
  v2CatalogRef = catalog
  v2OptionsConfigRef = optionsConfig
  v2TransformKnobs = undefined

  // Same registration contract as the v1 config hook: register the
  // vision-agent subagent only when absent (the user's own config and the
  // core's config-agent plugin own it once it exists) and never write
  // `model`/`disabled`. v2 agent field names differ from v1: `system` (not
  // `prompt`), `mode`, `hidden`, `permissions`.
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform(async (draft) => {
      // Knob capture (fix-v2-knob-capture-timing): the transform-time read is
      // kept as a MIDDLE source for hosts whose drafts already carry the
      // record — but on hosts that merge user config AFTER plugin transforms
      // (observed 2.3.2) this is undefined here and the merged record is read
      // lazily at execute time via resolveV2Knobs().
      if (typeof draft.get === "function") {
        const record = draft.get("vision-agent")
        if (record !== undefined) {
          v2TransformKnobs = readV2AgentKnobs(record)
        }
      }
      // Agent-name -> capability map for message routing (RV-1 order step 2):
      // read each draft record's model if the host exposes list().
      if (typeof draft.list === "function") {
        for (const entry of draft.list() ?? []) {
          if (!entry || typeof entry.id !== "string") continue
          const record = typeof draft.get === "function" ? draft.get(entry.id) : undefined
          const model = (record as { model?: unknown } | undefined)?.model
          if (typeof model === "string") {
            v2Capability.agents.set(
              entry.id,
              configuredModelVisionCapable(model, catalog, optionsConfig),
            )
          }
        }
      }
      if (typeof draft.get !== "function" || typeof draft.update !== "function") return
      if (draft.get("vision-agent") !== undefined) return
      draft.update("vision-agent", (agent) => {
        agent.description =
          "Visual judgment subagent. Consumes a prompt-authored visual task with image paths and a task-specific JSON response template. Not coupled to any screenshot tool or UI framework - works with locally stored images supported by the model. Configure its model via the opencode agent model override."
        agent.system = bodyTpl
        agent.mode = "subagent"
      })
    })
  }
  // Expose the bundled skill as a v2 skill registration. VERIFIED against
  // 2.3.2 (task 3.4): SkillEditor has list/get/add/update/remove — there is
  // NO `source` method (the assumed directory-source call is a silent no-op
  // there, kept guarded for hosts that do expose it). The 2.3.2 path embeds
  // the bundled SKILL.md via draft.add(Skill.Info) — the exact shape the
  // skill list serves (`{id, name, description?, path, content}`).
  if (typeof ctx.skill?.transform === "function") {
    await ctx.skill.transform(async (draft) => {
      if (typeof draft.source === "function") {
        draft.source({ type: "directory", path: dataDir })
        return
      }
      if (typeof draft.add !== "function") return
      const skillPath = join(dataDir, "SKILL.md")
      try {
        const content = readFileSync(skillPath, "utf8")
        draft.add({
          id: "vision",
          name: "vision",
          description:
            "Visual intent detection and delegation routing (vision_analyze tool first, vision-agent subagent fallback) for text-only models.",
          path: skillPath,
          content,
        })
      } catch {
        // No bundled SKILL.md (single-file install) — degrade to no-op.
      }
    })
  }
  // Register vision_analyze via ctx.tool.transform (task 2.1): same shared
  // execute core and error-category prefixes as the v1 tool; the JSON Schema
  // input mirrors the v1 tool.schema chain. A disabled vision-agent record
  // suppresses the registration entirely (VT-2/RV-6) — the gate resolves
  // lazily too, so a config-merged disable that was invisible at transform
  // time is still observed here via the domain getter / config-file fallback.
  // The execute core independently guards the disabled state.
  if (!resolveV2Knobs().disabled && typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform(async (editor) => {
      if (typeof editor?.add !== "function") return
      editor.add({
        name: VISION_TOOL_NAME,
        description: VISION_TOOL_DESCRIPTION,
        input: VISION_ANALYZE_INPUT_SCHEMA as unknown as Record<string, unknown>,
        async execute(args: unknown, toolCtx: unknown) {
          const text = await runVisionAnalyze(
            args as VisionAnalyzeArgs,
            (toolCtx ?? {}) as VisionAnalyzeCtx,
            resolveV2Knobs(),
          )
          return wrapV2ToolResult(text)
        },
      })
    })
  }
  // Auto-allow vision_analyze permission requests (task 2.2): upgrade ask ->
  // allow for this tool only; explicit deny wins (VT-3).
  if (typeof ctx.permission?.hook === "function") {
    ctx.permission.hook("evaluate", (event) => v2PermissionEvaluate(event))
  }
  // RV-1/RV-2 routing seam (task 2.3): system instruction + image
  // materialization via one context hook. The agent-name capability map is
  // refreshed post-merge first (fix-v2-knob-capture-timing task 2.2) wherever
  // the domain exposes list/get outside transform.
  if (typeof ctx.session?.hook === "function") {
    ctx.session.hook("context", (event) => {
      refreshV2AgentsMap(v2Capability)
      v2SessionContext(event, v2Capability)
    })
  }
}

export default { id: "vision", server: plugin, setup: v2Setup }
