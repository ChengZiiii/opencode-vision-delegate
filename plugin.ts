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
// in the config hook and read by the messages/system transforms.
let visionModelKeys = new Set<string>()
let agentVisionCapable = new Map<string, boolean>()
let defaultVisionCapable = false
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
function userMessageVisionCapable(info: {
  role: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
}): boolean {
  const m = info.model
  if (
    m &&
    typeof m.providerID === "string" &&
    typeof m.modelID === "string" &&
    (m.providerID !== "" || m.modelID !== "")
  ) {
    return visionModelKeys.has(`${m.providerID}/${m.modelID}`.toLowerCase())
  }
  if (typeof info.agent === "string" && agentVisionCapable.has(info.agent)) {
    return Boolean(agentVisionCapable.get(info.agent))
  }
  return defaultVisionCapable
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

// The native vision_analyze tool. execute runs in-process: model configured
// (from agent["vision-agent"].model) -> endpoint + key resolution -> read
// images -> OpenAI-compatible or Anthropic-shaped chat completion (shape
// resolved from the endpoint URL, see src/vision-http.ts) -> return the
// model's raw JSON text. Error categories are encoded in the message prefix
// so the skill can branch: "model not configured" (never falls back),
// "provider error" (falls back to the vision-agent subagent), "invalid
// response" (skill Step 6 retry).
function visionAnalyzeTool() {
  return tool({
    description:
      "Performs a visual judgment on local image files with the configured vision model. " +
      "Pass `images` as [{id, path, region?}] (short contract ids plus local image paths), the exact visual " +
      "`question`, a `response_template` (JSON string defining the required response shape), and " +
      "optional `response_rules` for task-specific constraints. Returns exactly one JSON object " +
      "matching the response template. Optional per-image `region: [x1, y1, x2, y2]` (integer pixel " +
      "coordinates in the ORIGINAL image, x2/y2 exclusive, PNG only) crops that region in memory at " +
      "full resolution — load the full image first, then re-call with a region to zoom into small " +
      "text or fine detail.",
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
      if (visionToolDisabled) {
        throw new Error(
          'vision_analyze: vision-agent is disabled: set disable: false on agent["vision-agent"] to use this tool',
        )
      }
      if (!visionToolModel) {
        throw new Error(
          'vision_analyze: model not configured: set agent["vision-agent"].model to a vision-capable ' +
            'provider/model (e.g. "minimax-cn-coding-plan/MiniMax-M3")',
        )
      }
      const parts = splitModel(visionToolModel)
      if (!parts) {
        throw new Error(
          `vision_analyze: model not configured: invalid model id "${visionToolModel}" (expected "provider/model")`,
        )
      }
      const models = providerModels(parts.provider, visionToolCatalog, visionToolConfig)
      const match = models[foldKey(models, parts.modelID)]
      if (!match || !isVisionModel(match)) {
        throw new Error(
          `vision_analyze: model not configured: ${visionToolModel} is not image-capable; set ` +
            'agent["vision-agent"].model to a vision-capable model',
        )
      }
      const endpoint = resolveVisionEndpoint(parts.provider, visionToolCatalog, visionToolConfig, process.env)
      if (!endpoint.ok) throw new Error(`vision_analyze: provider error: ${endpoint.error}`)
      const apiKey = resolveVisionApiKey(
        parts.provider,
        visionToolCatalog,
        visionToolConfig,
        readAuthData(),
        process.env,
      )
      if (!apiKey.ok) throw new Error(`vision_analyze: provider error: ${apiKey.error}`)
      const images: { id: string; path: string; base64: string; mime?: string }[] = []
      const disclosures: string[] = []
      for (const image of args.images) {
        const path = isAbsolute(image.path) ? image.path : join(ctx.directory, image.path)
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
        { temperature: visionToolTemperature, extraBody: visionToolExtraBody },
      )
      const result = await postVisionRequest(request, {
        signal: ctx.abort,
        timeoutMs: resolveVisionToolTimeoutMs(),
      })
      if (!result.ok) throw new Error(`vision_analyze: provider error: ${result.error}`)
      const parsed = parseVisionResponse(result.text)
      if (!parsed.ok) throw new Error(`vision_analyze: invalid response: ${parsed.error}`)
      return parsed.text
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
  visionModelKeys = buildVisionModelKeys(catalog, cfg as ConfigLike)
  defaultVisionCapable = configuredModelVisionCapable(cfg.model, catalog, cfg as ConfigLike)
  agentVisionCapable = new Map()
  const agentsSection = (cfg as ConfigLike & {
    agent?: Record<string, { model?: string } | undefined>
  }).agent ?? {}
  for (const [name, entry] of Object.entries(agentsSection)) {
    if (entry && typeof entry.model === "string") {
      agentVisionCapable.set(
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
  // subagent fallback).
  "experimental.chat.messages.transform": async (_input, output) => {
    for (const m of output.messages) {
      if (m.info.role !== "user") continue
      // A vision-capable user message keeps image parts untouched (native
      // path). The rewrite loop below then runs only for text-only messages.
      if (userMessageVisionCapable(m.info)) continue
      for (const part of m.parts) {
        if (part.type !== "file") continue
        if (!part.mime) continue
        if (!isImageMime(part.mime)) continue
        const originalFilename = part.filename ?? "image"
        let text: string
        try {
          const path = saveImagePart(
            part.url,
            m.info.sessionID,
            part.id,
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
  },

  // The system transform tells the orchestrator how images are routed in
  // this session: a vision-capable model handles them natively, while a
  // text-only model sees [vision:dropped-image] markers and delegates via
  // the vision_analyze tool (falling back to the vision-agent subagent).
  // The model is configured by the user via the opencode agent model
  // override on vision-agent. No model script or picker is involved.
  "experimental.chat.system.transform": async (input, output) => {
    // input.model is Model (has providerID + id, NOT modelID). Reuse the
    // folded visionModelKeys lookup.
    const model = input.model
    const capable = Boolean(
      model &&
        typeof model.providerID === "string" &&
        typeof model.id === "string" &&
        visionModelKeys.has(`${model.providerID}/${model.id}`.toLowerCase()),
    )
    if (capable) {
      output.system.push(
        "[vision:native] You receive image parts natively in this session. " +
          "Inspect images directly from the message. Do NOT use the vision skill for plain reading " +
          "and do NOT delegate visual tasks to a vision-* subagent. Exception: when small text or " +
          "fine detail is beyond native resolution, you MAY call vision_analyze WITH a `region` " +
          "argument to zoom into that area of an image FILE on disk.",
      )
      return
    }
    // Text-only path: inject nothing. The vision skill (SKILL.md) instructs
    // the orchestrator to call the vision_analyze tool first and fall back
    // to the vision-agent subagent on provider errors; the model is
    // configured by the user via the opencode agent model override.
  },
})

// ---------------------------------------------------------------------------
// v2 plugin entry (forward compatibility).
//
// opencode's v2 plugin architecture loads `setup(ctx)` from the same default
// export (the v1 loader only reads `server` and ignores `setup`; the v2
// loader only reads `setup` and ignores `server`). As of opencode 1.18 the v2
// PluginContext has agent/skill/... domains but NO tool registration and NO
// chat message/system transforms, so the v2 path can only carry the
// vision-agent subagent + vision skill — the vision_analyze tool, image
// materialization, and native-vision gating remain v1-only until upstream
// adds them. The npm install (`opencode plugin`, which writes the v1
// `plugin` config array) loads the v1 entry, so the shipped experience is
// full-featured; this setup() keeps the package loadable and useful the day
// a v2 host becomes the default.
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
  source(source: { type: "directory"; path: string }): void
  list(): unknown[]
}
type V2PluginContext = {
  agent?: {
    transform(cb: (draft: V2AgentDraft) => void | Promise<void>): Promise<unknown>
  }
  skill?: {
    transform(cb: (draft: V2SkillDraft) => void | Promise<void>): Promise<unknown>
  }
}

async function v2Setup(ctx: V2PluginContext): Promise<void> {
  // Same registration contract as the v1 config hook: register the
  // vision-agent subagent only when absent (the user's own config and the
  // core's config-agent plugin own it once it exists) and never write
  // `model`/`disabled`. v2 agent field names differ from v1: `system` (not
  // `prompt`), `mode`, `hidden`, `permissions`.
  if (typeof ctx.agent?.transform === "function") {
    await ctx.agent.transform(async (draft) => {
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
  // Expose the bundled skill directory as a v2 skill source. Directory
  // sources are scanned for SKILL.md, same as the v1 skills.paths entry.
  if (typeof ctx.skill?.transform === "function") {
    await ctx.skill.transform(async (draft) => {
      if (typeof draft.source !== "function") return
      draft.source({ type: "directory", path: dataDir })
    })
  }
}

export default { id: "vision", server: plugin, setup: v2Setup }
