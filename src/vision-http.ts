// Pure, testable core for the vision_analyze tool: request building,
// response parsing, endpoint and API key resolution, and the HTTP call.
// No imports from @opencode-ai/* and no side effects — imported directly by
// plugin.ts (bundled) and by tests (node --test with type stripping).
//
// Request shapes (resolved from the endpoint URL):
//  - "anthropic": Anthropic-style POST <base>/messages with base64 image
//    blocks. Empirically verified (upstream kilo-vision-bridge spike 1.3) as the
//    shape that delivers images for minimax-cn-coding-plan / MiniMax-M3 on
//    the reference machine (https://api.minimaxi.com/anthropic/v1).
//  - "openai": OpenAI-compatible POST <base>/chat/completions with
//    `image_url` data: URLs. Works for genuine OpenAI-compatible providers.

export type VisionShape = "openai" | "anthropic"

export type VisionImage = {
  id: string
  path: string
  base64: string
  /**
   * Optional mime override. Absent on passthrough entries (mime inferred
   * from the path extension, pre-change behavior); region-cropped entries
   * always carry "image/png" regardless of the original extension, because
   * the crop payload is a re-encoded PNG even when the source path says
   * .jpg/.webp (PNG-ness is detected by signature, see src/vision-crop.ts).
   */
  mime?: string
}

export type VisionRequest = {
  shape: VisionShape
  url: string
  headers: Record<string, string>
  body: string
}

export type ResolutionResult<T> = { ok: true; value: T; source: string } | { ok: false; error: string }

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
}

/** Infer the mime type from a local image path's extension (default png). */
export function inferImageMime(path: string): string {
  const lower = path.toLowerCase()
  for (const [ext, mime] of Object.entries(MIME_BY_EXT)) {
    if (lower.endsWith(ext)) return mime
  }
  return "image/png"
}

/** Resolve the request shape from a base URL: /anthropic in the URL -> anthropic. */
export function visionShapeFor(baseURL: string): VisionShape {
  return /\/anthropic(?:\/|$)/i.test(baseURL) ? "anthropic" : "openai"
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * Full request URL for a resolved base URL + shape.
 * openai:   <base>/chat/completions when the base already ends in a version
 *           segment (/v1, /v4, /v1beta...) or a full path; a bare host gets
 *           the OpenAI-style /v1 injected.
 * anthropic: <base>/messages (or <base>/v1/messages when the base ends in
 *           /anthropic, or <base>/anthropic/v1/messages for a bare host).
 */
export function visionRequestURL(baseURL: string): string {
  const base = trimSlash(baseURL)
  if (base.endsWith("/messages") || base.endsWith("/chat/completions")) return base
  if (visionShapeFor(baseURL) === "anthropic") {
    if (base.endsWith("/v1")) return `${base}/messages`
    if (base.endsWith("/anthropic")) return `${base}/v1/messages`
    return `${base}/anthropic/v1/messages`
  }
  if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

export type VisionRequestOpts = {
  /** Sampling temperature from agent["vision-agent"].temperature (default 0.1). */
  temperature?: number
  /**
   * User-supplied extra body fields (agent["vision-agent"].extraBody),
   * deep-merged into the final body: top-level keys may override, nested
   * plain objects merge recursively, arrays replace wholesale. Delivers
   * provider-specific knobs (e.g. {"thinking":{"type":"disabled"}}) that
   * opencode's variant system would otherwise inject via its own runtime.
   */
  extraBody?: Record<string, unknown>
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** Deep-merge `extra` into `base` (in place): nested plain objects merge
 * recursively, everything else (arrays, scalars) replaces. Returns `base`. */
export function mergeExtraBody(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainRecord(value) && isPlainRecord(base[key])) {
      mergeExtraBody(base[key] as Record<string, unknown>, value)
    } else {
      base[key] = value
    }
  }
  return base
}

/**
 * Build the HTTP request descriptor for a vision call. `images` carry the
 * already-read base64 payloads; mime is inferred from each `path` extension.
 * The question, response template and response rules are combined into the
 * text part of the first user message; one image is placed per user content
 * message (multi-image via multiple messages). `apiKey` is OPTIONAL: when
 * absent (keyless gateways, see resolveVisionApiKey) the auth header is
 * omitted entirely. `opts` carries the temperature/extraBody knobs;
 * max_tokens is intentionally absent from the openai shape (server default)
 * and 8192 in the anthropic shape (protocol-required, extraBody-overridable).
 */
export function buildVisionRequest(
  model: string,
  baseURL: string,
  images: VisionImage[],
  question: string,
  responseTemplate: string,
  responseRules?: string,
  apiKey?: string,
  opts?: VisionRequestOpts,
): VisionRequest {
  const shape = visionShapeFor(baseURL)
  const url = visionRequestURL(baseURL)

  const textParts: string[] = []
  if (question) textParts.push(question)
  if (responseTemplate) {
    textParts.push(
      `Return exactly one JSON object shaped like this. Keep these keys exactly, replace placeholder values with observed values, and do not add keys:\n\n${responseTemplate}`,
    )
  }
  if (responseRules) textParts.push(`Response rules:\n${responseRules}`)
  const text = textParts.join("\n\n")

  const messages: unknown[] = []
  for (const image of images) {
    const mime = image.mime ?? inferImageMime(image.path)
    if (shape === "anthropic") {
      const content: unknown[] = []
      if (messages.length === 0 && text) {
        content.push({ type: "text", text })
      }
      content.push({
        type: "image",
        source: { type: "base64", media_type: mime, data: image.base64 },
      })
      messages.push({ role: "user", content })
    } else {
      const content: unknown[] = []
      if (messages.length === 0 && text) {
        content.push({ type: "text", text })
      }
      content.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${image.base64}` },
      })
      messages.push({ role: "user", content })
    }
  }
  if (messages.length === 0) {
    messages.push({ role: "user", content: text })
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const temperature = opts?.temperature ?? 0.1
  let body: Record<string, unknown>
  if (shape === "anthropic") {
    if (apiKey) headers["x-api-key"] = apiKey
    headers["anthropic-version"] = "2023-06-01"
    body = {
      model,
      max_tokens: 8192,
      temperature,
      messages,
    }
  } else {
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    body = {
      model,
      temperature,
      messages,
    }
  }
  if (opts?.extraBody && isPlainRecord(opts.extraBody)) {
    mergeExtraBody(body, opts.extraBody)
  }

  return { shape, url, headers, body: JSON.stringify(body) }
}

/**
 * Extract the model's text from a chat completion response and sanity-check
 * that it parses as a single JSON value. Accepts a raw string body or an
 * already-parsed object.
 */
export function parseVisionResponse(body: string | unknown): { ok: true; text: string } | { ok: false; error: string } {
  let parsed: unknown = body
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body)
    } catch {
      return { ok: false, error: "response is not valid JSON" }
    }
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: "response is not a JSON object" }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.type === "error") {
    const err = obj.error as Record<string, unknown> | undefined
    return { ok: false, error: `provider error: ${err?.message ?? JSON.stringify(err ?? obj)}` }
  }
  const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : []
  if (choices.length > 0) {
    const content = (choices[0]?.message as Record<string, unknown> | undefined)?.content
    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, error: "response has no choices[0].message.content text" }
    }
    return sanityCheckJSON(content)
  }
  const blocks = Array.isArray(obj.content) ? (obj.content as Array<Record<string, unknown>>) : []
  if (blocks.length > 0) {
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
    if (!text.trim()) {
      return { ok: false, error: "response has no anthropic text content block" }
    }
    return sanityCheckJSON(text)
  }
  return { ok: false, error: "response has neither choices[0].message.content nor content text blocks" }
}

/**
 * Tolerant extractor for the vision model's text response.
 *
 * Vision models occasionally wrap a valid JSON object in a markdown code fence
 * (```json … ```) or surround it with short prose, which would make a strict
 * `JSON.parse` fail and produce a spurious `invalid response` error. This
 * cleans common wrappers before validating that the output is a single JSON
 * object, in this order:
 *   1. Fast path: strict `JSON.parse` of the trimmed text (existing exact-JSON
 *      behavior). A successful parse that is an array / scalar / null is
 *      rejected immediately — we do NOT fall through to extraction, preserving
 *      the existing `[1,2,3]` → "not a single JSON object" behavior.
 *   2. If strict parse threw, strip one surrounding markdown code fence (only
 *      when the entire text is a single fenced block) and re-attempt.
 *   3. Locate the first brace-balanced `{ … }` substring (string- and
 *      escape-aware) and re-attempt.
 * The first step that yields a single JSON object wins; the cleaned JSON
 * object text is returned (a real JSON object, not the raw fenced text). If
 * every step fails, the same `model output is not valid JSON: …` error and
 * category as before this change are returned, so the SKILL.md Step 6 retry
 * routing and the subagent fallback predicate are unaffected.
 *
 * Pure: no @opencode-ai/* imports, no side effects.
 */
function sanityCheckJSON(text: string): { ok: true; text: string } | { ok: false; error: string } {
  const trimmed = text.trim()

  // (1) Fast path: strict parse of the whole text.
  const fast = tryParse(trimmed)
  if (fast.ok) {
    // Strict-parse success that is not a single object is rejected immediately;
    // do NOT fall through to extraction (preserves existing array/scalar/null
    // behavior). Extraction only runs when strict parse *threw*.
    if (!isNonArrayObject(fast.value)) {
      return { ok: false, error: "model output is not a single JSON object" }
    }
    return { ok: true, text: trimmed }
  }

  // (2) Strip one markdown code fence and re-attempt.
  const fenced = stripOneCodeFence(trimmed)
  if (fenced !== null) {
    const inner = fenced.trim()
    const parsed = tryParse(inner)
    if (parsed.ok && isNonArrayObject(parsed.value)) {
      return { ok: true, text: inner }
    }
  }

  // (3) First brace-balanced object substring (string/escape-aware).
  const obj = firstBalancedObject(trimmed)
  if (obj !== null) {
    const parsed = tryParse(obj)
    if (parsed.ok && isNonArrayObject(parsed.value)) {
      return { ok: true, text: obj }
    }
  }

  // (4) Nothing worked: same error/category as before this change.
  return {
    ok: false,
    error: `model output is not valid JSON: ${trimmed.length > 140 ? trimmed.slice(0, 140) + "…" : trimmed}`,
  }
}

/** Best-effort JSON.parse that reports success/failure instead of throwing. */
function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

/** True for a plain JSON object (excludes null, arrays, and primitives). */
function isNonArrayObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Match a single markdown code fence wrapping the entire text. Anchored to the
 * whole string so it only fires when the response is one code block (the
 * observed failure case); prose with a stray fence is left for
 * `firstBalancedObject`. Returns the captured inner text, or null.
 */
const SINGLE_FENCE_RE = /^\s*```[a-zA-Z0-9._+-]*\s*\n([\s\S]*?)\n?```\s*$/
function stripOneCodeFence(text: string): string | null {
  const match = SINGLE_FENCE_RE.exec(text)
  return match ? match[1] : null
}

/**
 * Scan for the first `{`, then track brace depth while honoring `"` strings
 * (including `\"` escapes) so braces inside string values don't fool it.
 * Returns the substring from that `{` to its matching `}`, or null. Only
 * objects (`{`); arrays are intentionally not handled — the response template
 * is always an object and the tool requires a single object.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
    } else if (ch === '"') {
      inString = true
    } else if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

// Built-in map of known OpenAI-compatible / Anthropic-compatible vision
// endpoints for providers absent from the local model catalog. The minimax
// family maps to the anthropic-style base URL: the upstream kilo-vision-bridge spike
// (1.3) verified that the OpenAI-compatible /chat/completions endpoint of
// api.minimaxi.com drops data: image_url parts (images never reach the
// model), while the anthropic-style /messages endpoint delivers them.
const VISION_ENDPOINTS: Record<string, string> = {
  "minimax": "https://api.minimax.io/anthropic/v1",
  "minimax-coding-plan": "https://api.minimax.io/anthropic/v1",
  "minimax-cn": "https://api.minimaxi.com/anthropic/v1",
  "minimax-cn-coding-plan": "https://api.minimaxi.com/anthropic/v1",
}

type ConfigLike = {
  provider?: Record<string, { options?: { baseURL?: string } }>
  providers?: Record<string, { options?: { baseURL?: string } }>
}

type RawProvider = {
  env?: string[]
  api?: string
}

type Catalog = Record<string, RawProvider>

function foldMatch(record: Record<string, unknown>, key: string): string | undefined {
  const folded = key.toLowerCase()
  return Object.keys(record).find((k) => k.toLowerCase() === folded)
}

/**
 * Resolve the vision provider's base URL in this order:
 *   1. provider.<id>.options.baseURL from config (user override wins)
 *   2. an endpoint from the provider's declared env vars (names ending in
 *      _HOST, e.g. MINIMAX_API_HOST)
 *   3. the provider's catalog `api` field, else the built-in endpoint map
 *   4. otherwise a descriptive error
 */
export function resolveVisionEndpoint(
  provider: string,
  catalog: Catalog,
  config: ConfigLike,
  env: Record<string, string | undefined>,
): ResolutionResult<string> {
  for (const section of [config.provider, config.providers]) {
    if (!section) continue
    const key = foldMatch(section as unknown as Record<string, unknown>, provider)
    if (key) {
      const baseURL = section[key]?.options?.baseURL
      if (typeof baseURL === "string" && baseURL.trim()) {
        return { ok: true, value: baseURL.trim(), source: "config" }
      }
    }
  }
  const catalogProvider = catalog[provider] ?? catalog[String(provider).toLowerCase()]
  if (catalogProvider) {
    for (const name of catalogProvider.env ?? []) {
      if (!/host/i.test(name)) continue
      const value = env[name]
      if (typeof value === "string" && value.trim()) {
        return { ok: true, value: value.trim(), source: "env" }
      }
    }
  }
  if (catalogProvider && typeof catalogProvider.api === "string" && /^https?:\/\//i.test(catalogProvider.api)) {
    return { ok: true, value: catalogProvider.api, source: "catalog" }
  }
  const folded = provider.toLowerCase()
  for (const [key, url] of Object.entries(VISION_ENDPOINTS)) {
    if (key.toLowerCase() === folded) return { ok: true, value: url, source: "builtin" }
  }
  return {
    ok: false,
    error: `no known endpoint for provider "${provider}": set provider.${provider}.options.baseURL in config`,
  }
}

/**
 * Gateway provider ids that serve models WITHOUT authentication. The
 * opencode Zen gateway (provider id "opencode") serves free models
 * anonymously (live-probed: keyless calls return 200 with "cost":"0", an
 * invalid Authorization header gets 401), so for these ids a missing key is
 * a valid state, not a configuration error. A configured key still wins and
 * is used normally.
 */
const KEYLESS_PROVIDER_IDS = new Set(["opencode"])

/**
 * Resolve the vision provider's API key: the provider's auth.json entry
 * (type "api") first, then the provider's declared env vars. For keyless
 * gateway providers (opencode Zen) a resolved "nothing found" returns
 * success WITHOUT a key; every other provider id keeps the strict error.
 */
export function resolveVisionApiKey(
  provider: string,
  catalog: Catalog,
  _config: ConfigLike,
  auth: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ResolutionResult<string | undefined> {
  const authKey = foldMatch(auth, provider)
  if (authKey) {
    const entry = auth[authKey] as Record<string, unknown> | undefined
    if (entry && typeof entry === "object" && entry.type === "api") {
      const key = typeof entry.key === "string" ? entry.key : typeof entry.apiKey === "string" ? entry.apiKey : undefined
      if (key && key.trim()) return { ok: true, value: key.trim(), source: "auth" }
    }
  }
  const catalogProvider = catalog[provider] ?? catalog[String(provider).toLowerCase()]
  for (const name of catalogProvider?.env ?? []) {
    const value = env[name]
    if (typeof value === "string" && value.trim()) {
      return { ok: true, value: value.trim(), source: "env" }
    }
  }
  if (KEYLESS_PROVIDER_IDS.has(provider.toLowerCase())) {
    return { ok: true, value: undefined, source: "keyless" }
  }
  return {
    ok: false,
    error: `no API key for provider "${provider}": authenticate via "opencode auth login ${provider}" or set ${(catalogProvider?.env ?? ["<provider>_API_KEY"]).join(", ")}`,
  }
}

export type PostResult = { ok: true; status: number; text: string } | { ok: false; error: string }

/**
 * POST a built VisionRequest. Injectable fetch (tests stub globalThis.fetch).
 * `signal` (e.g. ctx.abort) and `timeoutMs` are composed; non-2xx responses
 * and network failures map to descriptive provider errors.
 */
export async function postVisionRequest(
  request: VisionRequest,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 60_000
  const signals: AbortSignal[] = []
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  if (opts.signal) signals.push(opts.signal)
  if (timeoutSignal) signals.push(timeoutSignal)
  const signal = signals.length === 1 ? signals[0] : signals.length > 1 ? AbortSignal.any(signals) : undefined
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status} from ${request.url}: ${text.length > 300 ? text.slice(0, 300) + "…" : text}`,
      }
    }
    return { ok: true, status: response.status, text }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Distinguish timeout (ours), external abort, and network failure.
    // Bun/undici surface timeouts as TimeoutError with varying messages, so
    // key off our own timeout signal having fired.
    if (timeoutSignal?.aborted) {
      return { ok: false, error: `timeout after ${timeoutMs}ms posting ${request.url}: ${message}` }
    }
    if (opts.signal?.aborted) {
      return { ok: false, error: `aborted: ${message}` }
    }
    return { ok: false, error: `network error: ${message}` }
  }
}
