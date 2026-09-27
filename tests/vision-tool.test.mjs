// Plugin-level tests for the vision_analyze tool's region support (openspec
// change vision-region-zoom, tasks 2.1-2.3). These exercise the REAL config
// hook and tool execute path (not a re-implementation) using the plugin's
// sandbox knobs: OPENCODE_MODELS_PATH (fixture catalog) and
// OPENCODE_AUTH_CONTENT (fixture auth). globalThis.fetch is stubbed.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "vision-tool-test-"))

const CATALOG = {
  fakeprov: {
    models: {
      vm: { name: "Fake Vision Model", modalities: { input: ["image", "text"] } },
    },
  },
}
const CATALOG_FILE = join(tmp, "models.json")
writeFileSync(CATALOG_FILE, JSON.stringify(CATALOG))
const AUTH = JSON.stringify({ fakeprov: { type: "api", key: "test-key" } })

const PREV = {
  models: process.env.OPENCODE_MODELS_PATH,
  auth: process.env.OPENCODE_AUTH_CONTENT,
  fetch: globalThis.fetch,
}

before(() => {
  process.env.OPENCODE_MODELS_PATH = CATALOG_FILE
  process.env.OPENCODE_AUTH_CONTENT = AUTH
})

after(() => {
  if (PREV.models === undefined) delete process.env.OPENCODE_MODELS_PATH
  else process.env.OPENCODE_MODELS_PATH = PREV.models
  if (PREV.auth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = PREV.auth
  globalThis.fetch = PREV.fetch
  rmSync(tmp, { recursive: true, force: true })
})

const { default: pluginEntry } = await import("../plugin.ts")
const server = pluginEntry.server

// Small deterministic PNG built with the crop module's encoder.
const { encodePng } = await import("../src/vision-crop.ts")
function solidPng(w, h, [r, g, b]) {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = 255
  }
  return encodePng(w, h, rgba)
}

const FULL_PNG = solidPng(20, 10, [200, 30, 30])
const PNG_PATH = join(tmp, "shot.png")
writeFileSync(PNG_PATH, FULL_PNG)
const JPEG_PATH = join(tmp, "photo.jpg")
writeFileSync(JPEG_PATH, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))

let captured
function stubFetch(payload = '{"ok":true}') {
  captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init.headers, body: init.body })
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: payload } }] }) }
  }
}

function getTool(config) {
  // `config` is the config hook's cfg object (mutated in place by the hook)
  return server().then(async (hooks) => {
    await hooks.config(config)
    return hooks.tool.vision_analyze
  })
}

const CTX = { directory: tmp, signal: undefined }

test("error precedence preserved: unresolvable endpoint beats missing image (no hoisting)", async () => {
  const tool = await getTool({
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    // no provider baseURL anywhere -> endpoint resolution fails
  })
  await assert.rejects(
    tool.execute(
      { images: [{ id: "a", path: join(tmp, "nope.png") }], question: "q", response_template: "{}" },
      CTX,
    ),
    /vision_analyze: provider error: no known endpoint/,
  )
})

test("crop error: JPEG with region, no HTTP request, id named", async () => {
  const tool = await getTool({
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    provider: { fakeprov: { options: { baseURL: "https://example.test/v1" } } },
  })
  stubFetch()
  await assert.rejects(
    tool.execute(
      {
        images: [{ id: "ref", path: JPEG_PATH, region: [0, 0, 5, 5] }],
        question: "q",
        response_template: "{}",
      },
      CTX,
    ),
    (err) => {
      assert.match(err.message, /^vision_analyze: crop error: image "ref"/)
      assert.match(err.message, /PNG/)
      return true
    },
  )
  assert.equal(captured.length, 0, "no HTTP request on crop error")
})

test("region call: cropped payload + disclosure in prompt, template JSON out", async () => {
  const tool = await getTool({
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    provider: { fakeprov: { options: { baseURL: "https://example.test/v1" } } },
  })
  stubFetch()
  const out = await tool.execute(
    {
      images: [{ id: "shot", path: PNG_PATH, region: [4, 2, 10, 6] }],
      question: "What exact text is at that spot?",
      response_template: '{\n  "text": "..."\n}',
    },
    CTX,
  )
  assert.equal(out, '{"ok":true}')
  assert.equal(captured.length, 1)
  const body = JSON.parse(captured[0].body)
  const dataUrl = body.messages[0].content[1].image_url.url
  assert.ok(dataUrl.startsWith("data:image/png;base64,"), "cropped entry submits image/png")
  const png = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64")
  assert.equal(png.readUInt32BE(16), 6, "crop width")
  assert.equal(png.readUInt32BE(20), 4, "crop height")
  const text = body.messages[0].content[0].text
  assert.match(text, /What exact text is at that spot\?/)
  assert.match(text, /Region crop coordinate mapping:/)
  assert.match(text, /Image "shot" is a crop/)
  assert.match(text, /origin \(4, 2\)/)
})

test("region-free call: whole-image passthrough, no disclosure (golden behavior)", async () => {
  const tool = await getTool({
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    provider: { fakeprov: { options: { baseURL: "https://example.test/v1" } } },
  })
  stubFetch()
  const out = await tool.execute(
    {
      images: [{ id: "a", path: PNG_PATH }],
      question: "describe",
      response_template: "{}",
    },
    CTX,
  )
  assert.equal(out, '{"ok":true}')
  const body = JSON.parse(captured[0].body)
  const dataUrl = body.messages[0].content[1].image_url.url
  assert.equal(dataUrl, `data:image/png;base64,${FULL_PNG.toString("base64")}`)
  assert.doesNotMatch(body.messages[0].content[0].text, /Region crop coordinate mapping/)
})

test("crop error precedence: fires after provider resolution, before fetch", async () => {
  const tool = await getTool({
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    provider: { fakeprov: { options: { baseURL: "https://example.test/v1" } } },
  })
  stubFetch()
  // missing image still beats crop (loop order: existsSync first)
  await assert.rejects(
    tool.execute(
      {
        images: [{ id: "gone", path: join(tmp, "missing.png"), region: [0, 0, 5, 5] }],
        question: "q",
        response_template: "{}",
      },
      CTX,
    ),
    /vision_analyze: missing image:/,
  )
  assert.equal(captured.length, 0)
})

test("[vision:native] instruction: no plain-reading delegation, region zoom assist allowed (RV-2)", async () => {
  const hooks = await server()
  const cfg = {
    agent: { "vision-agent": { model: "fakeprov/vm" } },
    provider: { fakeprov: { options: { baseURL: "https://example.test/v1" } } },
  }
  await hooks.config(cfg)
  const output = { system: [] }
  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "fakeprov", id: "vm" } },
    output,
  )
  const line = output.system.find((s) => s.startsWith("[vision:native]"))
  assert.ok(line, "native instruction present")
  assert.match(line, /Inspect images directly/)
  assert.match(line, /Do NOT use the vision skill for plain reading/)
  assert.match(line, /MAY call vision_analyze WITH a `region`/)
  // text-only model: no injection
  const textOnly = { system: [] }
  await hooks["experimental.chat.system.transform"](
    { model: { providerID: "fakeprov", id: "no-such-model" } },
    textOnly,
  )
  assert.equal(textOnly.system.length, 0)
})
