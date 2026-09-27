// Tests for src/vision-http.ts (pure core of the vision_analyze tool).
// Run with: node --test tests/ (node >= 22.6 type stripping; verified on
// node 24). fetch is stubbed via globalThis.fetch for postVisionRequest.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildVisionRequest,
  parseVisionResponse,
  resolveVisionEndpoint,
  resolveVisionApiKey,
  postVisionRequest,
  inferImageMime,
  visionShapeFor,
  visionRequestURL,
  mergeExtraBody,
} from "../src/vision-http.ts"

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64").toString("base64")

const images = [
  { id: "a", path: "/tmp/shot.png", base64: PNG },
  { id: "b", path: "/tmp/ref.jpeg", base64: PNG },
]

test("visionShapeFor detects anthropic-style URLs", () => {
  assert.equal(visionShapeFor("https://api.minimaxi.com/anthropic/v1"), "anthropic")
  assert.equal(visionShapeFor("https://api.openai.com/v1"), "openai")
})

test("visionRequestURL normalizes endpoints", () => {
  assert.equal(visionRequestURL("https://api.minimaxi.com/anthropic/v1"), "https://api.minimaxi.com/anthropic/v1/messages")
  // A bare host has no /anthropic/ marker -> openai shape (env-host overrides
  // should use the anthropic-style URL for image-capable minimax providers).
  assert.equal(visionRequestURL("https://api.minimaxi.com"), "https://api.minimaxi.com/v1/chat/completions")
  assert.equal(visionRequestURL("https://api.minimaxi.com/anthropic"), "https://api.minimaxi.com/anthropic/v1/messages")
  assert.equal(visionRequestURL("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions")
  assert.equal(visionRequestURL("https://api.openai.com"), "https://api.openai.com/v1/chat/completions")
  assert.equal(visionRequestURL("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions")
  // Versioned bases (ai-sdk convention: the version segment belongs to the
  // base) are complete - append the endpoint directly, never inject /v1.
  assert.equal(visionRequestURL("https://open.bigmodel.cn/api/coding/paas/v4"), "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions")
  assert.equal(visionRequestURL("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/chat/completions")
  assert.equal(visionRequestURL("https://x.example/v1beta"), "https://x.example/v1beta/chat/completions")
})

test("inferImageMime maps path extensions", () => {
  assert.equal(inferImageMime("/tmp/a.png"), "image/png")
  assert.equal(inferImageMime("/tmp/a.jpg"), "image/jpeg")
  assert.equal(inferImageMime("/tmp/a.JPEG"), "image/jpeg")
  assert.equal(inferImageMime("/tmp/a.webp"), "image/webp")
  assert.equal(inferImageMime("/tmp/a.gif"), "image/gif")
  assert.equal(inferImageMime("/tmp/a.unknown"), "image/png")
})

test("buildVisionRequest: openai shape request", () => {
  const req = buildVisionRequest("MiniMax-M3", "https://api.openai.com/v1", images, "Is it centered?", '{"isCentered": true}', "no prose", "sk-123")
  assert.equal(req.shape, "openai")
  assert.equal(req.url, "https://api.openai.com/v1/chat/completions")
  assert.equal(req.headers["Authorization"], "Bearer sk-123")
  assert.equal(req.headers["Content-Type"], "application/json")
  const body = JSON.parse(req.body)
  assert.equal(body.model, "MiniMax-M3")
  assert.equal(body.temperature, 0.1)
  assert.equal(body.messages.length, 2)
  const first = body.messages[0]
  assert.equal(first.role, "user")
  assert.equal(first.content.length, 2)
  assert.equal(first.content[0].type, "text")
  assert.ok(first.content[0].text.includes("Is it centered?"))
  assert.ok(first.content[0].text.includes('{"isCentered": true}'))
  assert.ok(first.content[0].text.includes("no prose"))
  assert.deepEqual(first.content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } })
  const second = body.messages[1]
  assert.equal(second.content.length, 1)
  assert.deepEqual(second.content[0], { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG}` } })
})

test("buildVisionRequest: anthropic shape request", () => {
  const req = buildVisionRequest("MiniMax-M3", "https://api.minimaxi.com/anthropic/v1", images, "What color?", "{}", undefined, "sk-123")
  assert.equal(req.shape, "anthropic")
  assert.equal(req.url, "https://api.minimaxi.com/anthropic/v1/messages")
  assert.equal(req.headers["x-api-key"], "sk-123")
  assert.equal(req.headers["anthropic-version"], "2023-06-01")
  const body = JSON.parse(req.body)
  assert.equal(body.model, "MiniMax-M3")
  assert.equal(body.max_tokens, 8192)
  assert.equal(body.messages.length, 2)
  const first = body.messages[0]
  assert.equal(first.content[0].type, "text")
  assert.deepEqual(first.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG },
  })
  assert.deepEqual(body.messages[1].content[0].source, { type: "base64", media_type: "image/jpeg", data: PNG })
})

test("buildVisionRequest: multi-image one per message, text only in first", () => {
  const three = [
    { id: "a", path: "/tmp/a.png", base64: PNG },
    { id: "b", path: "/tmp/b.png", base64: PNG },
    { id: "c", path: "/tmp/c.png", base64: PNG },
  ]
  const req = buildVisionRequest("m", "https://api.openai.com/v1", three, "Q?", '{"x": 1}')
  const body = JSON.parse(req.body)
  assert.equal(body.messages.length, 3)
  assert.ok(body.messages[0].content[0].type === "text")
  for (let i = 1; i < 3; i++) {
    assert.equal(body.messages[i].content.length, 1)
    assert.equal(body.messages[i].content[0].type, "image_url")
  }
})

test("buildVisionRequest: no images still carries the text", () => {
  const req = buildVisionRequest("m", "https://api.openai.com/v1", [], "Q?", '{"x": 1}')
  const body = JSON.parse(req.body)
  assert.equal(body.messages.length, 1)
  assert.equal(body.messages[0].content, "Q?\n\nReturn exactly one JSON object shaped like this. Keep these keys exactly, replace placeholder values with observed values, and do not add keys:\n\n{\"x\": 1}")
})

test("parseVisionResponse: openai shape", () => {
  const ok = parseVisionResponse({ choices: [{ message: { content: '{"isCentered": true}' } }] })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.text, '{"isCentered": true}')
  const str = parseVisionResponse(JSON.stringify({ choices: [{ message: { content: '{"a": 1}' } }] }))
  assert.equal(str.ok, true)
  if (str.ok) assert.equal(str.text, '{"a": 1}')
})

test("parseVisionResponse: anthropic shape", () => {
  const ok = parseVisionResponse({ content: [{ type: "text", text: '{"color": "red"}' }] })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.text, '{"color": "red"}')
})

test("parseVisionResponse: descriptive errors", () => {
  assert.equal(parseVisionResponse("not json").ok, false)
  assert.equal(parseVisionResponse({}).ok, false)
  assert.equal(parseVisionResponse({ choices: [{ message: {} }] }).ok, false)
  assert.equal(parseVisionResponse({ type: "error", error: { message: "bad key" } }).ok, false)
  const notJson = parseVisionResponse({ choices: [{ message: { content: "plain text answer" } }] })
  assert.equal(notJson.ok, false)
  if (!notJson.ok) assert.match(notJson.error, /not valid JSON/)
  const notObject = parseVisionResponse({ choices: [{ message: { content: "[1,2,3]" } }] })
  assert.equal(notObject.ok, false)
  if (!notObject.ok) assert.match(notObject.error, /not a single JSON object/)
  // scalar (JSON string) is also rejected via the strict fast-path
  const scalar = parseVisionResponse({ choices: [{ message: { content: '"just a string"' } }] })
  assert.equal(scalar.ok, false)
  if (!scalar.ok) assert.match(scalar.error, /not a single JSON object/)
})

// Wrap model text into an OpenAI-shaped response for parseVisionResponse.
const openaiContent = (content) => ({ choices: [{ message: { content } }] })

test("parseVisionResponse: tolerant of ```json code fence (VT-6)", () => {
  const fenced = "```json\n{\"isCentered\": true, \"evidence\": \"centered\"}\n```"
  const r = parseVisionResponse(openaiContent(fenced))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"isCentered\": true, \"evidence\": \"centered\"}")
})

test("parseVisionResponse: tolerant of bare code fence (no info string)", () => {
  const fenced = "```\n{\"x\": 1}\n```"
  const r = parseVisionResponse(openaiContent(fenced))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"x\": 1}")
})

test("parseVisionResponse: tolerant of leading/trailing prose", () => {
  const prose = "Sure, here is the result:\n{\"visible\": true}\nHope that helps."
  const r = parseVisionResponse(openaiContent(prose))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"visible\": true}")
})

test("parseVisionResponse: plain JSON still uses the fast path", () => {
  const r = parseVisionResponse(openaiContent("{\"color\": \"red\"}"))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"color\": \"red\"}")
})

test("parseVisionResponse: braces inside string values do not fool the extractor", () => {
  const prose = "Explanation:\n{\"a\": \"has } brace\"}\nDone."
  const r = parseVisionResponse(openaiContent(prose))
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"a\": \"has } brace\"}")
})

test("parseVisionResponse: fenced array is rejected (only objects are rescued)", () => {
  const fencedArray = "```json\n[1,2,3]\n```"
  const r = parseVisionResponse(openaiContent(fencedArray))
  assert.equal(r.ok, false)
})

test("parseVisionResponse: tolerant path works for anthropic text blocks too", () => {
  const r = parseVisionResponse({
    content: [{ type: "text", text: "```json\n{\"ok\": true}\n```" }],
  })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.text, "{\"ok\": true}")
})

test("resolveVisionEndpoint: config baseURL wins", () => {
  const catalog = { "minimax-cn-coding-plan": { env: ["MINIMAX_API_KEY"], api: "https://catalog.example/anthropic/v1" } }
  const config = { provider: { "Minimax-Cn-Coding-Plan": { options: { baseURL: "https://custom.example/v1" } } } }
  const env = { MINIMAX_API_HOST: "https://env.example" }
  const r = resolveVisionEndpoint("minimax-cn-coding-plan", catalog, config, env)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value, "https://custom.example/v1")
    assert.equal(r.source, "config")
  }
})

test("resolveVisionEndpoint: env host beats catalog/builtin", () => {
  const catalog = { p1: { env: ["P1_API_KEY", "P1_API_HOST"], api: "https://catalog.example/v1" } }
  const r = resolveVisionEndpoint("p1", catalog, {}, { P1_API_HOST: "https://env.example" })
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value, "https://env.example")
})

test("resolveVisionEndpoint: catalog api then builtin map then error", () => {
  const catalog = { p1: { env: [], api: "https://catalog.example/anthropic/v1" } }
  const r1 = resolveVisionEndpoint("p1", catalog, {}, {})
  assert.equal(r1.ok, true)
  if (r1.ok) assert.equal(r1.value, "https://catalog.example/anthropic/v1")

  const r2 = resolveVisionEndpoint("minimax-cn-coding-plan", {}, {}, {})
  assert.equal(r2.ok, true)
  if (r2.ok) {
    assert.equal(r2.value, "https://api.minimaxi.com/anthropic/v1")
    assert.equal(r2.source, "builtin")
  }

  const r3 = resolveVisionEndpoint("no-such-provider", {}, {}, {})
  assert.equal(r3.ok, false)
  if (!r3.ok) assert.match(r3.error, /no known endpoint/)
})

test("resolveVisionApiKey: auth.json api entry wins, then env", () => {
  const catalog = { p1: { env: ["P1_API_KEY"] } }
  const auth = { p1: { type: "api", key: "auth-key" } }
  const r1 = resolveVisionApiKey("p1", catalog, {}, auth, { P1_API_KEY: "env-key" })
  assert.equal(r1.ok, true)
  if (r1.ok) {
    assert.equal(r1.value, "auth-key")
    assert.equal(r1.source, "auth")
  }
  const r2 = resolveVisionApiKey("p1", catalog, {}, {}, { P1_API_KEY: "env-key" })
  assert.equal(r2.ok, true)
  if (r2.ok) {
    assert.equal(r2.value, "env-key")
    assert.equal(r2.source, "env")
  }
  const r3 = resolveVisionApiKey("p1", catalog, {}, {}, {})
  assert.equal(r3.ok, false)
  if (!r3.ok) assert.match(r3.error, /no API key/)
})

test("resolveVisionApiKey: case-insensitive auth provider match", () => {
  const auth = { "Minimax-Cn-Coding-Plan": { type: "api", key: "mixed-case-key" } }
  const r = resolveVisionApiKey("minimax-cn-coding-plan", {}, {}, auth, {})
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value, "mixed-case-key")
})

test("resolveVisionApiKey: opencode Zen gateway is keyless", () => {
  const catalog = { opencode: { env: ["OPENCODE_API_KEY"], api: "https://opencode.ai/zen/v1" } }
  const none = resolveVisionApiKey("opencode", catalog, {}, {}, {})
  assert.equal(none.ok, true)
  if (none.ok) {
    assert.equal(none.value, undefined)
    assert.equal(none.source, "keyless")
  }
  const fromEnv = resolveVisionApiKey("opencode", catalog, {}, {}, { OPENCODE_API_KEY: "zen-key" })
  assert.equal(fromEnv.ok, true)
  if (fromEnv.ok) {
    assert.equal(fromEnv.value, "zen-key")
    assert.equal(fromEnv.source, "env")
  }
  const folded = resolveVisionApiKey("OpenCode", catalog, {}, {}, {})
  assert.equal(folded.ok, true)
  if (folded.ok) assert.equal(folded.source, "keyless")
})

test("resolveVisionApiKey: non-Zen provider without a key still errors", () => {
  const catalog = { "minimax-cn-coding-plan": { env: ["MINIMAX_API_KEY"] } }
  const r = resolveVisionApiKey("minimax-cn-coding-plan", catalog, {}, {}, {})
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /no API key for provider "minimax-cn-coding-plan"/)
})

test("buildVisionRequest: omits auth headers without a key, keeps them with one", () => {
  const keyless = buildVisionRequest("space-bunny-free", "https://opencode.ai/zen/v1", images, "q", "{}")
  assert.equal(keyless.url, "https://opencode.ai/zen/v1/chat/completions")
  assert.equal(keyless.headers["Authorization"], undefined)
  assert.equal(keyless.headers["Content-Type"], "application/json")
  const keyed = buildVisionRequest("space-bunny-free", "https://opencode.ai/zen/v1", images, "q", "{}", undefined, "k1")
  assert.equal(keyed.headers["Authorization"], "Bearer k1")
  const keylessAnthropic = buildVisionRequest("m", "https://api.minimaxi.com/anthropic/v1", images, "q", "{}")
  assert.equal(keylessAnthropic.headers["x-api-key"], undefined)
  assert.equal(keylessAnthropic.headers["anthropic-version"], "2023-06-01")
  const keyedAnthropic = buildVisionRequest("m", "https://api.minimaxi.com/anthropic/v1", images, "q", "{}", undefined, "k2")
  assert.equal(keyedAnthropic.headers["x-api-key"], "k2")
})

test("postVisionRequest: success with stubbed globalThis.fetch", async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok": true}' } }] }),
    }
  }
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", images, "Q?", "{}", undefined, "k")
    const res = await postVisionRequest(req)
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.status, 200)
      assert.match(res.text, /choices/)
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, "https://api.example/v1/chat/completions")
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].init.headers.Authorization, "Bearer k")
  } finally {
    globalThis.fetch = original
  }
})

test("postVisionRequest: HTTP error mapping", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error": "unauthorized"}',
  })
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", [], "Q?", "{}", undefined, "bad")
    const res = await postVisionRequest(req)
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /HTTP 401/)
  } finally {
    globalThis.fetch = original
  }
})

test("postVisionRequest: network error mapping", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("fetch failed: ENOTFOUND")
  }
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", [], "Q?", "{}", undefined, "k")
    const res = await postVisionRequest(req)
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /network error: fetch failed/)
  } finally {
    globalThis.fetch = original
  }
})

test("postVisionRequest: abort signal propagates", async () => {
  const controller = new AbortController()
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    assert.ok(init.signal instanceof AbortSignal)
    controller.abort()
    assert.equal(init.signal.aborted, true)
    return { ok: true, status: 200, text: async () => "{}" }
  }
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", [], "Q?", "{}", undefined, "k")
    const res = await postVisionRequest(req, { signal: controller.signal, timeoutMs: 5000 })
    assert.equal(res.ok, true)
  } finally {
    globalThis.fetch = original
  }
})

// VT-7: request knobs — extraBody deep-merge, temperature passthrough,
// max_tokens semantics per shape.

test("buildVisionRequest: openai shape sets no max_tokens", () => {
  const req = buildVisionRequest("m", "https://api.example/v1", images, "Q?", "{}")
  const body = JSON.parse(req.body)
  assert.ok(!("max_tokens" in body))
})

test("buildVisionRequest: temperature opts passthrough", () => {
  const req = buildVisionRequest("m", "https://api.example/v1", images, "Q?", "{}", undefined, "k", {
    temperature: 0.3,
  })
  assert.equal(JSON.parse(req.body).temperature, 0.3)
  const anth = buildVisionRequest("m", "https://api.minimaxi.com/anthropic/v1", images, "Q?", "{}", undefined, "k", {
    temperature: 0.3,
  })
  assert.equal(JSON.parse(anth.body).temperature, 0.3)
})

test("buildVisionRequest: extraBody deep-merges into openai body", () => {
  const req = buildVisionRequest("m", "https://api.example/v1", images, "Q?", "{}", undefined, "k", {
    extraBody: { thinking: { type: "disabled" }, top_p: 0.9 },
  })
  const body = JSON.parse(req.body)
  assert.deepEqual(body.thinking, { type: "disabled" })
  assert.equal(body.top_p, 0.9)
  assert.equal(body.model, "m")
  assert.ok(Array.isArray(body.messages))
})

test("buildVisionRequest: extraBody overrides anthropic max_tokens", () => {
  const req = buildVisionRequest("m", "https://api.minimaxi.com/anthropic/v1", images, "Q?", "{}", undefined, "k", {
    extraBody: { max_tokens: 4096 },
  })
  assert.equal(JSON.parse(req.body).max_tokens, 4096)
})

test("buildVisionRequest: extraBody can override top-level model", () => {
  const req = buildVisionRequest("m", "https://api.example/v1", images, "Q?", "{}", undefined, "k", {
    extraBody: { model: "other-model" },
  })
  assert.equal(JSON.parse(req.body).model, "other-model")
})

test("mergeExtraBody: nested objects merge, arrays and scalars replace", () => {
  const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: "me" }
  mergeExtraBody(base, { a: { y: 9, z: 3 }, list: [3] })
  assert.deepEqual(base, { a: { x: 1, y: 9, z: 3 }, list: [3], keep: "me" })
})

test("postVisionRequest: timeout error is classified, not a network error", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("The operation timed out")
        e.name = "TimeoutError"
        reject(e)
      })
    })
  try {
    const req = buildVisionRequest("m", "https://slow.example/v1", [], "Q?", "{}", undefined, "k")
    const res = await postVisionRequest(req, { timeoutMs: 50 })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.match(res.error, /^timeout after 50ms posting https:\/\/slow\.example/)
      assert.doesNotMatch(res.error, /^network error/)
    }
  } finally {
    globalThis.fetch = original
  }
})

test("postVisionRequest: external abort is its own category", async () => {
  const controller = new AbortController()
  const original = globalThis.fetch
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")))
    })
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", [], "Q?", "{}", undefined, "k")
    setTimeout(() => controller.abort(), 20)
    const res = await postVisionRequest(req, { signal: controller.signal, timeoutMs: 10_000 })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /^aborted: /)
  } finally {
    globalThis.fetch = original
  }
})

test("postVisionRequest: timeoutMs <= 0 composes no timeout signal", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.signal, undefined)
    return { ok: true, status: 200, text: async () => "{}" }
  }
  try {
    const req = buildVisionRequest("m", "https://api.example/v1", [], "Q?", "{}", undefined, "k")
    const res = await postVisionRequest(req, { timeoutMs: 0 })
    assert.equal(res.ok, true)
  } finally {
    globalThis.fetch = original
  }
})

test("buildVisionRequest: per-image mime override (VT-8 cropped entries)", () => {
  const cropped = [
    { id: "c", path: "/tmp/actually-png.jpg", base64: PNG, mime: "image/png" },
  ]
  const openai = buildVisionRequest("m", "https://api.example.com/v1", cropped, "q", "{}")
  const body = JSON.parse(openai.body)
  assert.equal(body.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,"), true)

  const anthropic = buildVisionRequest("m", "https://api.example.com/anthropic/v1", cropped, "q", "{}")
  const abody = JSON.parse(anthropic.body)
  assert.equal(abody.messages[0].content[1].source.media_type, "image/png")

  // No mime field -> extension inference (pre-change behavior)
  const plain = buildVisionRequest("m", "https://api.example.com/v1", images, "q", "{}")
  const pbody = JSON.parse(plain.body)
  assert.equal(pbody.messages[0].content[1].image_url.url.startsWith("data:image/png;base64,"), true)
  assert.equal(pbody.messages[1].content[0].image_url.url.startsWith("data:image/jpeg;base64,"), true)
})

test("buildVisionRequest: region-free golden body (VT-8 backward compat)", () => {
  const req = buildVisionRequest(
    "MiniMax-M3",
    "https://api.minimaxi.com/anthropic/v1",
    [{ id: "a", path: "/tmp/shot.png", base64: "QUJD" }],
    "Is the button centered?",
    "{\n  \"isCentered\": true\n}",
    "Report evidence.",
    "k",
  )
  assert.equal(req.url, "https://api.minimaxi.com/anthropic/v1/messages")
  assert.equal(req.headers["x-api-key"], "k")
  assert.deepEqual(JSON.parse(req.body), {
    model: "MiniMax-M3",
    max_tokens: 8192,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Is the button centered?\n\nReturn exactly one JSON object shaped like this. Keep these keys exactly, replace placeholder values with observed values, and do not add keys:\n\n{\n  \"isCentered\": true\n}\n\nResponse rules:\nReport evidence.",
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    ],
  })
})
