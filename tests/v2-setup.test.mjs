// V2 setup-entry tests (change v2-plugin-api-port, tasks 2.1-2.5). Per the
// shared conventions doc §6 test matrix, every V2 registration gets two
// legs: wired (mock ctx domains present, assert registration content) and
// drifted (missing domain/method -> no-op, no throw). The mock ctx shapes
// follow the OBSERVED 2.3.2 shapes (task 3.4 sandbox verification, probe
// plugin + live runs): agent records carry model as {id, providerID} with
// request knobs under request.settings/request.body, the permission
// evaluate event is {action, resources, effect, ...}, the context event
// system is an array of {type:"text",text} objects and messages are
// {id, role, content:[parts]} with media image parts
// {type:"media", media:{source:{type:"base64",data,mediaType}}}, and the
// skill draft has add() (no source()). Runs the REAL setup() export via
// OPENCODE_MODELS_PATH / OPENCODE_AUTH_CONTENT env seams; globalThis.fetch
// is stubbed.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const tmp = mkdtempSync(join(tmpdir(), "v2-setup-test-"))
// Isolated config dir (fix-v2-knob-capture-timing): the config-file fallback
// reads the host's global config — tests must not observe the developer's
// real ~/.config/opencode/opencode.json.
const configTmp = mkdtempSync(join(tmpdir(), "v2-setup-cfg-"))

const CATALOG = {
  fakeprov: {
    api: "https://example.test/v1",
    models: {
      vm: { name: "Fake Vision Model", modalities: { input: ["image", "text"] } },
      tm: { name: "Fake Text Model", modalities: { input: ["text"] } },
    },
  },
}
const CATALOG_FILE = join(tmp, "models.json")
writeFileSync(CATALOG_FILE, JSON.stringify(CATALOG))
const AUTH = JSON.stringify({ fakeprov: { type: "api", key: "test-key" } })

const PREV = {
  models: process.env.OPENCODE_MODELS_PATH,
  auth: process.env.OPENCODE_AUTH_CONTENT,
  configDir: process.env.OPENCODE_CONFIG_DIR,
  fetch: globalThis.fetch,
}

before(() => {
  process.env.OPENCODE_MODELS_PATH = CATALOG_FILE
  process.env.OPENCODE_AUTH_CONTENT = AUTH
  process.env.OPENCODE_CONFIG_DIR = configTmp
})

after(() => {
  if (PREV.models === undefined) delete process.env.OPENCODE_MODELS_PATH
  else process.env.OPENCODE_MODELS_PATH = PREV.models
  if (PREV.auth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = PREV.auth
  if (PREV.configDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = PREV.configDir
  globalThis.fetch = PREV.fetch
  rmSync(tmp, { recursive: true, force: true })
  rmSync(configTmp, { recursive: true, force: true })
})

const { default: pluginEntry, stripJsoncForParse } = await import("../plugin.ts")

// Small deterministic PNG for the execute path.
const { encodePng } = await import("../src/vision-crop.ts")
const FULL_PNG = encodePng(
  4,
  4,
  (() => {
    const rgba = new Uint8Array(4 * 4 * 4)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
    return rgba
  })(),
)
const PNG_PATH = join(tmp, "shot.png")
writeFileSync(PNG_PATH, FULL_PNG)

let captured
function stubFetch(payload = '{"ok":true}') {
  captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: init.headers, body: init.body })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: payload } }] }),
    }
  }
}

// Mock V2 ctx: every domain records what setup registered. The shapes mirror
// the OBSERVED 2.3.2 surfaces (task 3.4 sandbox verification).
function makeCtx(overrides = {}) {
  const state = {
    tools: [],
    agents: new Map(),
    addedSkills: [],
    permissionHooks: [],
    contextHooks: [],
  }
  const ctx = {
    agent: {
      transform: async (cb) =>
        cb({
          get: (id) => state.agents.get(id),
          update: (id, fn) => {
            const record = state.agents.get(id) ?? {}
            fn(record)
            state.agents.set(id, record)
          },
          list: () => [...state.agents.entries()].map(([id, record]) => ({ id, ...record })),
        }),
    },
    skill: {
      transform: async (cb) =>
        cb({
          add: (s) => state.addedSkills.push(s),
          list: () => [],
        }),
    },
    tool: {
      transform: async (cb) =>
        cb({
          add: (def) => state.tools.push(def),
        }),
    },
    permission: {
      hook: (name, cb) => state.permissionHooks.push({ name, cb }),
    },
    session: {
      hook: (name, cb) => state.contextHooks.push({ name, cb }),
    },
    ...overrides,
  }
  return { ctx, state }
}

async function setup(overrides) {
  const { ctx, state } = makeCtx(overrides)
  await pluginEntry.setup(ctx)
  return state
}

// --- 2.1 tool registration ------------------------------------------------

test("v2 tool wired: vision_analyze registered with JSON Schema + shared core executes", async () => {
  const { ctx, state } = makeCtx()
  // Pre-seed the user's vision-agent record in the OBSERVED 2.3.2 shape
  // (model as {id, providerID} object) so knob capture sees the model (the
  // create-only registration then skips, by design).
  state.agents.set("vision-agent", { model: { id: "vm", providerID: "fakeprov" } })
  await pluginEntry.setup(ctx)
  assert.equal(state.tools.length, 1, "exactly one tool registered")
  const tool = state.tools[0]
  assert.equal(tool.name, "vision_analyze")
  assert.ok(
    tool.description.startsWith("Performs a visual judgment on local image files"),
    "description matches the v1 tool",
  )
  // JSON Schema contract (VT-1 parity)
  assert.equal(tool.input.type, "object")
  assert.deepEqual(tool.input.required, ["images", "question", "response_template"])
  const region = tool.input.properties.images.items.properties.region
  assert.equal(region.minItems, 4)
  assert.equal(region.maxItems, 4)
  assert.equal(region.items.type, "integer")
  // Shared execute core: same behavior as the v1 tool (VT-1/VT-8)
  stubFetch()
  const result = await tool.execute(
    {
      images: [{ id: "a", path: PNG_PATH }],
      question: "describe",
      response_template: "{}",
    },
    { directory: tmp },
  )
  assert.deepEqual(result, { content: '{"ok":true}' }, "structured-content default shape")
  assert.equal(captured.length, 1, "one HTTP request through the shared core")
  const body = JSON.parse(captured[0].body)
  assert.equal(body.model, "vm", "model knob resolved from the vision-agent record")
})

test("v2 tool drifted: missing ctx.tool -> no-op, no throw, rest of setup runs", async () => {
  const state = await setup({ tool: undefined })
  assert.equal(state.tools.length, 0)
  // other registrations still ran
  assert.ok(state.agents.has("vision-agent"), "agent registration still ran")
  assert.equal(state.addedSkills.length, 1, "skill registration still ran")
  assert.equal(state.permissionHooks.length, 1, "permission hook still registered")
  assert.equal(state.contextHooks.length, 1, "context hook still registered")
})

test("v2 tool drifted: editor without add() -> no registration, no throw", async () => {
  const { ctx, state } = makeCtx()
  ctx.tool = { transform: async (cb) => cb({}) }
  await pluginEntry.setup(ctx)
  assert.equal(state.tools.length, 0)
})

// --- 2.2 permission hook (observed 2.3.2 evaluate event shape) -------------

test("v2 permission wired: ask upgraded to allow for vision_analyze (action + effect fields)", async () => {
  const state = await setup({})
  assert.equal(state.permissionHooks.length, 1)
  assert.equal(state.permissionHooks[0].name, "evaluate")
  // OBSERVED shape (live capture): { action, resources, effect, ... }
  const event = { action: "vision_analyze", resources: ["*"], effect: "ask" }
  await state.permissionHooks[0].cb(event)
  assert.equal(event.effect, "allow")
})

test("v2 permission: explicit deny is never overwritten", async () => {
  const state = await setup({})
  const event = { action: "vision_analyze", resources: ["*"], effect: "deny" }
  await state.permissionHooks[0].cb(event)
  assert.equal(event.effect, "deny")
})

test("v2 permission: other tools' ask outcomes untouched; legacy name chain + decision shape still guarded (drift legs)", async () => {
  const state = await setup({})
  const other = { action: "edit", resources: ["t.txt"], effect: "ask" }
  await state.permissionHooks[0].cb(other)
  assert.equal(other.effect, "ask", "non-vision_analyze requests untouched")
  // Legacy drift fallbacks (v1-style shapes, not 2.3.2 reality):
  const byId = { id: "vision_analyze", decision: { status: "ask" } }
  await state.permissionHooks[0].cb(byId)
  assert.equal(byId.decision.status, "allow")
})

test("v2 permission drifted: missing ctx.permission -> no-op, no throw", async () => {
  const state = await setup({ permission: undefined })
  assert.equal(state.permissionHooks.length, 0)
  assert.equal(state.tools.length, 1, "tool registration unaffected")
})

// --- 2.3 session context hook (observed 2.3.2 shapes) ----------------------

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// OBSERVED 2.3.2 message shape: { id, role, content: parts[] } with media
// image parts {type:"media", media:{source:{type:"base64",data,mediaType}}}.
function userMessage(providerID, modelID) {
  return {
    id: "msg-v2-test",
    role: "user",
    content: [
      {
        type: "media",
        media: { source: { type: "base64", data: PNG_B64, mediaType: "image/png" } },
        filename: "shot.png",
      },
    ],
  }
}

test("v2 context wired: text-only model gets materialized [vision:dropped-image] marker, no native instruction", async () => {
  const state = await setup({})
  assert.equal(state.contextHooks.length, 1)
  assert.equal(state.contextHooks[0].name, "context")
  const message = userMessage("fakeprov", "tm")
  const event = {
    sessionID: "v2-test-session",
    model: { providerID: "fakeprov", id: "tm" },
    system: [],
    messages: [message],
  }
  await state.contextHooks[0].cb(event)
  assert.equal(message.content[0].type, "text")
  assert.equal(message.content[0].media, undefined, "media payload dropped from the rewritten part")
  const marker = JSON.parse(message.content[0].text.replace(/^\[vision:dropped-image\] /, ""))
  assert.equal(marker.mime, "image/png")
  assert.ok(marker.path.includes("opencode-vision-delegate"), "materialized under the plugin temp dir")
  assert.equal(event.system.length, 0, "text-only model gets no injection")
})

test("v2 context wired: vision-capable model gets [vision:native] system OBJECT, image media parts pass through", async () => {
  const state = await setup({})
  const message = userMessage("fakeprov", "vm")
  const event = {
    sessionID: "v2-test-session",
    model: { providerID: "fakeprov", id: "vm" },
    system: [],
    messages: [message],
  }
  await state.contextHooks[0].cb(event)
  assert.equal(message.content[0].type, "media", "image media part untouched")
  assert.equal(event.system.length, 1)
  // OBSERVED: system entries are {type:"text", text} objects, not strings
  assert.equal(event.system[0].type, "text")
  assert.match(event.system[0].text, /^\[vision:native\]/)
  assert.match(event.system[0].text, /MAY call vision_analyze WITH a `region`/)
})

test("v2 context drift: string-system host (older shape) still gets the instruction as a bare string", async () => {
  const state = await setup({})
  const event = { model: { providerID: "fakeprov", id: "vm" }, system: ["existing"], messages: [] }
  await state.contextHooks[0].cb(event)
  assert.equal(event.system[1], event.system[1].toString(), "string form preserved")
  assert.match(String(event.system[1]), /^\[vision:native\]/)
})

test("v2 context drifted: missing ctx.session -> pass-through no-op, no throw", async () => {
  const state = await setup({ session: undefined })
  assert.equal(state.contextHooks.length, 0)
})

test("v2 context drifted: malformed event (no arrays) -> no throw, nothing injected", async () => {
  const state = await setup({})
  const event = { model: { providerID: "fakeprov", id: "vm" } }
  await state.contextHooks[0].cb(event)
  await state.contextHooks[0].cb(undefined)
  assert.equal(event.system, undefined)
})

// --- 2.4 knob resolution ---------------------------------------------------

test("v2 knobs: unset model -> exact VT-2 'model not configured' error, no HTTP request", async () => {
  const state = await setup({}) // no vision-agent record -> knobs unset
  assert.equal(state.tools.length, 1, "tool still registered (not disabled)")
  stubFetch()
  await assert.rejects(
    state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    ),
    /vision_analyze: model not configured: set agent\["vision-agent"\]\.model/,
  )
  assert.equal(captured.length, 0, "no HTTP request on unset model")
})

test("v2 knobs: disabled vision-agent suppresses tool registration (and agent registration stays skipped)", async () => {
  const { ctx, state } = makeCtx()
  // OBSERVED config-level flag name: `disabled` (ConfigAgent.Info); the
  // domain excludes disabled agents before plugins see them, so this leg
  // covers the defensive read.
  state.agents.set("vision-agent", { disabled: true, model: { id: "vm", providerID: "fakeprov" } })
  await pluginEntry.setup(ctx)
  assert.equal(state.tools.length, 0, "disabled -> no tool registration")
  assert.deepEqual(
    state.agents.get("vision-agent"),
    { disabled: true, model: { id: "vm", providerID: "fakeprov" } },
    "create-only registration leaves the user record untouched",
  )
})

test("v2 knobs: temperature + extraBody propagate into the request body (VT-7, observed request.settings/request.body shape)", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", {
    model: { id: "vm", providerID: "fakeprov" },
    request: {
      settings: { temperature: 0.4 },
      body: { thinking: { type: "disabled" } },
    },
  })
  await pluginEntry.setup(ctx)
  stubFetch()
  await state.tools[0].execute(
    { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
    { directory: tmp },
  )
  const body = JSON.parse(captured[0].body)
  assert.equal(body.temperature, 0.4)
  assert.deepEqual(body.thinking, { type: "disabled" })
})

test("v2 knobs: legacy flat record shape (string model + flat temperature/extraBody) still resolves (drift leg)", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", {
    model: "fakeprov/vm",
    temperature: 0.7,
    extraBody: { top_p: 0.9 },
  })
  await pluginEntry.setup(ctx)
  stubFetch()
  await state.tools[0].execute(
    { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
    { directory: tmp },
  )
  const body = JSON.parse(captured[0].body)
  assert.equal(body.model, "vm")
  assert.equal(body.temperature, 0.7)
  assert.equal(body.top_p, 0.9)
})

test("v2 knobs: not-image-capable model -> VT-2 error category", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", { model: { id: "tm", providerID: "fakeprov" } })
  await pluginEntry.setup(ctx)
  stubFetch()
  await assert.rejects(
    state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    ),
    /vision_analyze: model not configured: fakeprov\/tm is not image-capable/,
  )
  assert.equal(captured.length, 0)
})

// --- fix-knob-source-fallthrough: presence is not resolution ---------------

// Ground truth (probe 2026-11-22): the 2.3.2 agent-domain getter returns a
// PRESENT record with NO knobs for config-defined agents. The old resolver
// early-returned model:undefined on presence and starved the config-file
// fallback, producing the production tier-1 error. The override was one
// fall-through away.
test("v2 knobs fallthrough: model-less domain record -> config file fallback resolves the override", async () => {
  const { ctx, state } = makeCtx()
  // the observed 2.3.2 skeleton: present, enumerable-empty, model-less
  state.agents.set("vision-agent", {})
  const cfgFile = join(configTmp, "opencode.json")
  writeFileSync(cfgFile, JSON.stringify({ agent: { "vision-agent": { model: "fakeprov/vm" } } }))
  try {
    await pluginEntry.setup(ctx)
    stubFetch()
    await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    const body = JSON.parse(captured[0].body)
    assert.equal(body.model, "vm", "the file fallback resolved the override the domain record lacked")
    assert.equal(captured.length, 1, "exactly one HTTP request — no tier-1 error")
  } finally {
    rmSync(cfgFile, { force: true })
  }
})

test("v2 knobs fallthrough: model-less domain record + raw-config {providerID, modelID} file spelling also resolves", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", {})
  const cfgFile = join(configTmp, "opencode.json")
  writeFileSync(cfgFile, JSON.stringify({ agent: { "vision-agent": { model: { providerID: "fakeprov", modelID: "vm" } } } }))
  try {
    await pluginEntry.setup(ctx)
    stubFetch()
    await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    assert.equal(JSON.parse(captured[0].body).model, "vm")
  } finally {
    rmSync(cfgFile, { force: true })
  }
})

test("v2 knobs fallthrough: a disabled domain record wins instantly (file fallback cannot re-enable)", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", { disabled: true })
  const cfgFile = join(configTmp, "opencode.json")
  writeFileSync(cfgFile, JSON.stringify({ agent: { "vision-agent": { model: "fakeprov/vm" } } }))
  try {
    await pluginEntry.setup(ctx)
    assert.equal(state.tools.length, 0, "disabled record suppresses tool registration")
  } finally {
    rmSync(cfgFile, { force: true })
  }
})

test("v2 knobs precedence: a domain record WITH model still beats the config file", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", { model: { id: "vm", providerID: "fakeprov" } })
  const cfgFile = join(configTmp, "opencode.json")
  writeFileSync(cfgFile, JSON.stringify({ agent: { "vision-agent": { model: "fakeprov/tm" } } }))
  try {
    await pluginEntry.setup(ctx)
    stubFetch()
    await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    assert.equal(JSON.parse(captured[0].body).model, "vm", "domain record (merged truth) outranks the file")
  } finally {
    rmSync(cfgFile, { force: true })
  }
})

test("v2 knobs fallthrough: knob-less record + no config file -> exact unset error (honest degradation intact)", async () => {
  const { ctx, state } = makeCtx()
  state.agents.set("vision-agent", {})
  await pluginEntry.setup(ctx)
  stubFetch()
  await assert.rejects(
    state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    ),
    /vision_analyze: model not configured: set agent\["vision-agent"\]\.model/,
  )
  assert.equal(captured.length, 0)
})

// --- 2.5 agent + skill registrations kept ----------------------------------

test("v2 agent + skill kept: create-only vision-agent registration + embedded skill (observed draft.add shape)", async () => {
  const state = await setup({})
  const agent = state.agents.get("vision-agent")
  assert.ok(agent, "vision-agent registered when absent")
  assert.equal(agent.mode, "subagent")
  assert.equal(typeof agent.system, "string")
  assert.equal(agent.model, undefined, "plugin never writes model")
  assert.equal(agent.disable, undefined, "plugin never writes disable")
  assert.equal(state.addedSkills.length, 1)
  const skill = state.addedSkills[0]
  assert.equal(skill.id, "vision")
  assert.ok(skill.path.endsWith("SKILL.md"), "embedded skill points at the bundled SKILL.md")
  assert.ok(skill.content.includes("vision"), "embedded skill carries the SKILL.md content")
})

test("v2 skill drift: draft without add()/source() -> no-op, no throw", async () => {
  const { ctx, state } = makeCtx()
  ctx.skill = { transform: async (cb) => cb({ list: () => [] }) }
  await pluginEntry.setup(ctx)
  assert.equal(state.addedSkills.length, 0)
  assert.equal(state.tools.length, 1, "tool registration unaffected")
})

test("v2 agent create-only: existing vision-agent record is not overwritten", async () => {
  const { ctx, state } = makeCtx()
  const userRecord = { model: { id: "vm", providerID: "fakeprov" }, system: "user-authored" }
  state.agents.set("vision-agent", userRecord)
  await pluginEntry.setup(ctx)
  assert.deepEqual(state.agents.get("vision-agent"), userRecord)
})

// --- fix-v2-knob-capture-timing: lazy execute-time resolution ---------------

// Ordering regression (the live 2.3.2 failure as a test): the transform-time
// draft.get("vision-agent") is undefined (user config merges AFTER plugin
// transforms), but the agent domain's own getter returns the MERGED record
// once transforms settle — execute must resolve the model anyway.
test("v2 knobs ordering: transform sees undefined, domain getter returns merged record -> execute resolves model", async () => {
  const { ctx, state } = makeCtx()
  const mergedRecord = {
    model: { id: "vm", providerID: "fakeprov", variant: "low" },
    request: { settings: { temperature: 0.2 } },
  }
  // Simulated 2.3.2 ordering: empty draft at transform time; the domain's
  // get() serves the merged record after all transforms finished.
  ctx.agent = {
    transform: async (cb) => cb({ get: () => undefined, list: () => [] }),
    get: (id) => (id === "vision-agent" ? mergedRecord : undefined),
    list: () => [{ id: "vision-agent" }],
  }
  await pluginEntry.setup(ctx)
  assert.equal(state.tools.length, 1, "tool registered (merged disable not visible -> not suppressed)")
  stubFetch()
  const result = await state.tools[0].execute(
    { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
    { directory: tmp },
  )
  assert.deepEqual(result, { content: '{"ok":true}' })
  assert.equal(captured.length, 1, "no 'model not configured' — the merged record was observed")
  const body = JSON.parse(captured[0].body)
  assert.equal(body.model, "vm", "model knob from the merged record (variant folds to provider/id)")
  assert.equal(body.temperature, 0.2)
})

// Fallback path: no domain getter AND transform saw nothing -> the config
// file (OPENCODE_CONFIG_DIR, JSONC-tolerant) supplies the knobs; zero writes.
test("v2 knobs fallback: no domain getter + JSONC config fixture -> knobs resolve, zero file writes", async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "v2-knob-cfg-"))
  const cfgFile = join(cfgDir, "opencode.jsonc")
  const cfgContent = `{
  // user config with comments (JSONC)
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "vision-agent": {
      "model": "fakeprov/vm", /* inline comment */
      "temperature": 0.5,
      "extraBody": { "top_p": 0.8, },
    },
  },
}`
  writeFileSync(cfgFile, cfgContent)
  const prevCfg = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = cfgDir
  try {
    const { ctx, state } = makeCtx()
    // No domain getter; the transform draft never carries the record.
    ctx.agent = { transform: async (cb) => cb({ get: () => undefined, list: () => [] }) }
    await pluginEntry.setup(ctx)
    assert.equal(state.tools.length, 1)
    stubFetch()
    await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    const body = JSON.parse(captured[0].body)
    assert.equal(body.model, "vm", "model knob from the config-file fallback")
    assert.equal(body.temperature, 0.5)
    assert.equal(body.top_p, 0.8, "extraBody propagated from the fallback")
    // Zero-write contract: the fixture is byte-identical and the dir gained nothing.
    assert.equal(readFileSync(cfgFile, "utf8"), cfgContent, "config file never rewritten")
    assert.deepEqual(readdirSync(cfgDir), ["opencode.jsonc"], "no files added to the config dir")
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevCfg
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

// Fallback miss: no domain getter, no readable config -> byte-identical
// VT-2 "model not configured" error (no invented default model).
test("v2 knobs fallback: no domain getter + empty config dir -> exact 'model not configured' error", async () => {
  const { ctx, state } = makeCtx()
  ctx.agent = { transform: async (cb) => cb({ get: () => undefined, list: () => [] }) }
  await pluginEntry.setup(ctx)
  assert.equal(state.tools.length, 1)
  stubFetch()
  await assert.rejects(
    state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    ),
    /vision_analyze: model not configured: set agent\["vision-agent"\]\.model/,
  )
  assert.equal(captured.length, 0)
})

// Capability map lazy refresh (task 2.2): domain list/get post-merge repopulates
// the agent-name capability map at context-hook time.
test("v2 capability map: post-merge domain list/get refreshes agents map at context time", async () => {
  const { ctx, state } = makeCtx()
  ctx.agent = {
    transform: async (cb) => cb({ get: () => undefined, list: () => [] }),
    get: (id) =>
      id === "vision-agent" ? { model: { id: "vm", providerID: "fakeprov" } } : undefined,
    list: () => [{ id: "vision-agent" }],
  }
  await pluginEntry.setup(ctx)
  assert.equal(state.contextHooks.length, 1)
  const event = { model: { providerID: "fakeprov", id: "tm" }, system: [], messages: [] }
  await state.contextHooks[0].cb(event)
  // Indirect observable: none yet (v2 routing keys off the request model) —
  // assert the refresh itself ran without throwing and the hook still works.
  assert.equal(event.system.length, 0, "text-only model: no injection")
})

// --- harden-tests wave: P2 class-instance record shape + config-fallback edges --

// P2 sandbox verdict (design.md "Post-apply sandbox verdict"): records fetched
// through the live domain handle serialize to `{}` (class-instance shape —
// prototype getters are invisible to JSON) while DIRECT property access may
// still read merged fields. This test pins the main path under BOTH shapes:
// whatever the host serves, execute resolves the knobs.
test("v2 knobs P2: class-instance record (prototype getters) — serializes to {} but property access resolves knobs", async () => {
  class HostAgentRecord {
    get model() {
      return { id: "vm", providerID: "fakeprov", variant: "low" }
    }
    get request() {
      return { settings: { temperature: 0.3 } }
    }
  }
  const record = new HostAgentRecord()
  // shape premise: JSON hides the prototype getters, access does not
  assert.equal(JSON.stringify(record), "{}", "premise: the record serializes to {} (P2 observation)")
  assert.ok(record.model, "premise: direct property access reads the merged model")
  const { ctx, state } = makeCtx()
  ctx.agent = {
    transform: async (cb) => cb({ get: () => undefined, list: () => [] }),
    get: (id) => (id === "vision-agent" ? record : undefined),
    list: () => [{ id: "vision-agent" }],
  }
  await pluginEntry.setup(ctx)
  stubFetch()
  const result = await state.tools[0].execute(
    { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
    { directory: tmp },
  )
  assert.deepEqual(result, { content: '{"ok":true}' })
  const body = JSON.parse(captured[0].body)
  assert.equal(body.model, "vm", "model resolved off the prototype getter (variant folds away)")
  assert.equal(body.temperature, 0.3, "request.settings.temperature resolved off the prototype getter")
})

// The hostile corner of the same shape: a getter that THROWS must degrade to
// the next source (config file), never propagate into execute.
test("v2 knobs P2: a throwing prototype getter degrades to the config-file fallback, never throws", async () => {
  class ThrowingRecord {
    get model() {
      throw new Error("getter boom")
    }
  }
  const cfgDir = mkdtempSync(join(tmpdir(), "v2-knob-throw-"))
  writeFileSync(join(cfgDir, "opencode.json"), JSON.stringify({ agent: { "vision-agent": { model: "fakeprov/vm" } } }))
  const prevCfg = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = cfgDir
  try {
    const { ctx, state } = makeCtx()
    ctx.agent = {
      transform: async (cb) => cb({ get: () => undefined, list: () => [] }),
      get: (id) => (id === "vision-agent" ? new ThrowingRecord() : undefined),
      list: () => [{ id: "vision-agent" }],
    }
    await pluginEntry.setup(ctx)
    stubFetch()
    const result = await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    assert.deepEqual(result, { content: '{"ok":true}' }, "no throw — resolution fell through to the config file")
    assert.equal(JSON.parse(captured[0].body).model, "vm", "model served by the fallback source")
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevCfg
    rmSync(cfgDir, { recursive: true, force: true })
  }
})

// Fallback edge: OPENCODE_CONFIG_DIR pointing at a NONEXISTENT directory —
// no error, graceful degradation to unset (exact VT-2 error, no invented model).
test("v2 knobs fallback: OPENCODE_CONFIG_DIR at a nonexistent directory degrades to unset", async () => {
  const prevCfg = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = join(tmp, "definitely-not-here")
  try {
    const { ctx, state } = makeCtx()
    ctx.agent = { transform: async (cb) => cb({ get: () => undefined, list: () => [] }) }
    await pluginEntry.setup(ctx)
    assert.equal(state.tools.length, 1, "tool still registered (no throw at setup)")
    stubFetch()
    await assert.rejects(
      state.tools[0].execute(
        { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
        { directory: tmp },
      ),
      /vision_analyze: model not configured: set agent\["vision-agent"\]\.model/,
    )
    assert.equal(captured.length, 0)
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevCfg
  }
})

// JSONC state-machine boundary: "//" inside string literals is DATA, not a
// comment opener — asserted both directly on the exported stripper and through
// a full fixture where the URL string precedes the agent knobs.
test("v2 knobs fallback: '//' inside string literals survives the strip (state machine does not eat URLs)", async () => {
  const url = "https://example.test/v1//double"
  const stripped = stripJsoncForParse(`{"url":"${url}" // real comment
}`)
  assert.deepEqual(JSON.parse(stripped), { url }, "the URL string literal is byte-identical after stripping")
  // block comment + trailing comma combination, with the '//' string in front
  const cfgDir = mkdtempSync(join(tmpdir(), "v2-knob-jsonc-"))
  const cfgFile = join(cfgDir, "opencode.jsonc")
  const cfgContent = `{
  // docs: ${url}
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "vision-agent": {
      "model": "fakeprov/vm", /* inline block */ "temperature": 0.6,
    },
  },
}`
  writeFileSync(cfgFile, cfgContent)
  const prevCfg = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = cfgDir
  try {
    const { ctx, state } = makeCtx()
    ctx.agent = { transform: async (cb) => cb({ get: () => undefined, list: () => [] }) }
    await pluginEntry.setup(ctx)
    stubFetch()
    await state.tools[0].execute(
      { images: [{ id: "a", path: PNG_PATH }], question: "q", response_template: "{}" },
      { directory: tmp },
    )
    const body = JSON.parse(captured[0].body)
    assert.equal(body.model, "vm", "knobs resolve through the block-comment + trailing-combo fixture")
    assert.equal(body.temperature, 0.6)
  } finally {
    if (prevCfg === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prevCfg
    rmSync(cfgDir, { recursive: true, force: true })
  }
})
