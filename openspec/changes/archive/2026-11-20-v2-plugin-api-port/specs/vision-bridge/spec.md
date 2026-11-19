## ADDED Requirements

### Requirement: VH-1: V2 host registration parity

**Requirement:** On an opencode V2 host, the `setup` entry `SHALL` register
the full feature set through the V2 domains, keeping the V1 `server` entry
untouched: the `vision_analyze` tool `SHALL` be registered via
`ctx.tool.transform` with a JSON Schema argument schema carrying the exact
VT-1 argument contract (`images` array of `{id, path, region?: number[4]}`,
`question`, `response_template`, optional `response_rules`) and the exact
VT-1/VT-8 execution semantics and error-category prefixes; the permission
behavior of VT-3 `SHALL` be carried by `ctx.permission.hook("evaluate")`
(upgrade `ask` to `allow` for `vision_analyze` requests only; an explicit
user `deny` `SHALL` win and is never overwritten); and the disable semantics
of VT-2/RV-6 `SHALL` hold: when the user's `vision-agent` record is
disabled, the tool `SHALL NOT` be registered and the agent registration
stays skipped. Every V2 registration `SHALL` keep the structural guards
(`?.` + `typeof`) so a host with a missing or reshaped domain no-ops that
registration instead of throwing.

#### Scenario: Tool registers on a V2 host

- **WHEN** a V2 host with `ctx.tool.transform` loads the plugin and the
  `vision-agent` record is not disabled
- **THEN** `vision_analyze` appears in the tool registry with the declared
  JSON Schema arguments, and execution reuses the V1 execute path (same
  error categories, same response contract)

#### Scenario: Permission evaluate auto-allows on V2

- **WHEN** an agent calls `vision_analyze` on a V2 host and the evaluate
  hook observes the request with an `ask` outcome
- **THEN** the outcome is upgraded to `allow`, while an explicit user
  `deny` for `vision_analyze` is left untouched

#### Scenario: Disabled agent suppresses the tool on V2

- **WHEN** the user's `vision-agent` record is disabled on a V2 host
- **THEN** `setup` registers no `vision_analyze` tool (the subagent
  registration stays skipped as today)

#### Scenario: Shape drift degrades to a no-op

- **WHEN** a V2 host lacks `ctx.tool.transform` or `ctx.permission` (or
  their methods have drifted shapes)
- **THEN** the corresponding registrations are skipped without throwing
  and the rest of `setup` still runs

### Requirement: VH-2: V2 host routing and knob parity

**Requirement:** On a V2 host, the routing behavior of RV-1/RV-2 `SHALL` be
carried by a `ctx.session.hook("context", ...)` registration that edits the
event's messages and system arrays with the same semantics as the V1
transforms: image `FilePart`s of user messages whose handling model is not
vision-capable `SHALL` be materialized to the plugin temp dir and rewritten
to `[vision:dropped-image]` markers (same resolution chain: message model →
agent name → top-level default, case-insensitive, availability-ungated), and
requests handled by a vision-capable model `SHALL` receive the single
`[vision:native]` system instruction while text-only models receive no
injection. The tool knobs (`model`, `disable`, `temperature`, `extraBody`)
`SHALL` be resolved from the user's `vision-agent` agent record via the
agent domain (the plugin still never writes `model` or `disabled`); an
unavailable or unset record degrades to the exact VT-2 `model not
configured` error contract. All error-category prefixes `SHALL` stay
byte-identical to the V1 path so SKILL.md routing (VT-4) is unaffected.

#### Scenario: Text-only model gets markers on V2

- **WHEN** a user message carrying an image part is handled by a text-only
  model on a V2 host
- **THEN** the image is materialized under the plugin temp dir and the part
  is rewritten to a `[vision:dropped-image]` marker carrying the path

#### Scenario: Vision-capable model gets the native instruction on V2

- **WHEN** a request is handled by a vision-capable model on a V2 host
- **THEN** the event system array receives the `[vision:native]`
  instruction and image parts pass through unchanged

#### Scenario: Knobs resolve from the agent record on V2

- **WHEN** the user sets `model` (and optionally `temperature`/`extraBody`)
  on their `vision-agent` record on a V2 host
- **THEN** `vision_analyze` targets that model with those request knobs,
  and the plugin has written no `model`/`disabled` field anywhere

#### Scenario: Unset model keeps the fixable error on V2

- **WHEN** `vision_analyze` executes on a V2 host with no model configured
- **THEN** the error is the `model not configured` category naming
  `agent["vision-agent"].model`, and no HTTP request is made

## MODIFIED Requirements

### Requirement: RB-1: Package manifest targets the opencode plugin SDK

**Requirement:** The package `SHALL` declare `@opencode-ai/plugin` `^1.18.0`
in both `peerDependencies` and `devDependencies`, expose the built
`dist/index.js` through both `exports["."]` and `exports["./server"]` (the
latter is what `opencode plugin`'s manifest reader detects), and declare an
`engines.opencode` range of `^1.18.0 || ^2.0.0` so incompatible opencode
versions skip loading with a warning — the V2 branch of the range is
satisfied without any new runtime dependency because the V2 entry is
structurally typed (no import of `@opencode/plugin`). The manifest `scripts`
`SHALL NOT` declare any of the pacote prepare-trigger names — `preinstall`,
`install`, `postinstall`, `prepack`, `prepare`, `build` — and the manifest
`SHALL NOT` declare a `workspaces` field (a seventh trigger; see
anomalyco/opencode issue #49704), because opencode 1.18.32's bundled pacote
forces git-dep preparation (an inner `npm install` in the cloned repo) for
git/github-spec installs whenever ANY of those triggers is present, and that
preparation fails inside the compiled opencode binary (the spawned
`npm-cli.js` runs under the opencode executable itself). The build task
`SHALL` use a non-trigger script name (`bundle`).

#### Scenario: Install resolves the 1.18.x SDK

Given the package manifest declares `@opencode-ai/plugin` `^1.18.0` in
`peerDependencies` and `devDependencies`,
when `bun install` runs,
then `bun.lock` is regenerated and contains `@opencode-ai/plugin` 1.x
and the build (`bun run bundle`) produces a self-contained `dist/index.js`.

#### Scenario: CLI compatibility range

Given `package.json` declares `"engines": { "opencode": "^1.18.0 || ^2.0.0" }`,
when an opencode CLI outside that range loads the plugin,
then the plugin is skipped with a warning instead of failing the load, and
both a 1.18.x host and a 2.x host are inside the range.

#### Scenario: Git-spec plugin install skips preparation

Given the manifest declares no prepare-trigger script,
when `opencode plugin github:<owner>/<repo> [--global]` installs the plugin
(opencode 1.18.32, Windows host),
then the install completes without git dep preparation (no inner
`npm install`) and the plugin registers on the next launch.

### Requirement: RB-2: Default export is dual-entry (hooks + v2 setup)

**Requirement:** The plugin `SHALL` default-export
`{ id: "vision", server, setup }`. The `server` entry `SHALL` carry the full
hooks-API feature set (config hook, `tool` hook, `permission.ask`, both
experimental chat transforms). The `setup` entry `SHALL` provide full V2
feature parity per VH-1/VH-2 — the `vision_analyze` tool via
`ctx.tool.transform`, the permission behavior via
`ctx.permission.hook("evaluate")`, image materialization and native-vision
gating via `ctx.session.hook("context")`, knob resolution from the
`vision-agent` agent record via the agent domain — alongside the existing
`vision-agent` registration via `ctx.agent` (only when absent, using v2
field names `system`/`mode`, never writing `model`/`disabled`/`permissions`)
and the vision skill directory via `ctx.skill` as a directory source. The
v2 path `SHALL` use structural types with `?.` and `typeof` guards on every
domain and draft method so a host with a missing or reshaped domain no-ops
that registration instead of throwing. Because the v1 loader only reads
`server` and ignores extra keys, and the v2 loader only reads `setup`, the
two entries `SHALL` keep disjoint registration targets and share no mutable
state.

#### Scenario: v1 loader loads the hooks entry

Given the plugin is installed via the `plugin` config array (`opencode plugin`
or `file://`),
when opencode's v1 plugin loader imports the module,
then `server()` is called and the full feature set registers; `setup` is
ignored.

#### Scenario: v2 setup degrades on shape drift

Given a v2 host whose `ctx.agent` lacks a `transform` method or whose agent
draft lacks `get`/`update`,
when `setup` runs,
then the agent registration is skipped without throwing.

#### Scenario: v2 loader loads the setup entry

Given a V2 host loading the package through the V2 loader,
when the host imports the module,
then `setup(ctx)` is called with the V2 plugin context and the full V2
feature set registers (VH-1/VH-2); `server` is ignored.
