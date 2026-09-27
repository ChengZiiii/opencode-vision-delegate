# vision-bridge Specification

## Purpose

Give text-only opencode orchestrators (GLM, DeepSeek, and similar models)
"eyes": register a native `vision_analyze` tool (primary path) plus a single
`vision-agent` subagent (fallback path), route images per handling model
(native pass-through for multimodal models, disk materialization plus
delegation markers for text-only models), and resolve endpoint/credentials
and dual HTTP request shapes for direct provider calls. The vision model is
configured solely by the user through the agent model override on
`vision-agent`; the plugin never writes `model` or `disable`. Baseline ported
from kilo-vision-bridge's spec, adapted to opencode and aligned to the
verified behavior of opencode 1.18.32 (stale kilo spec text for RV-2 and
RB-5 corrected against the implementation).

## Requirements

### Requirement: RB-1: Package manifest targets the opencode plugin SDK

**Requirement:** The package `SHALL` declare `@opencode-ai/plugin` `^1.18.0`
in both `peerDependencies` and `devDependencies`, expose the built
`dist/index.js` through both `exports["."]` and `exports["./server"]` (the
latter is what `opencode plugin`'s manifest reader detects), and declare an
`engines.opencode` range of `^1.18.0` so incompatible opencode versions skip
loading with a warning. The manifest `scripts` `SHALL NOT` declare any of the
pacote prepare-trigger names — `preinstall`, `install`, `postinstall`,
`prepack`, `prepare`, `build` — and the manifest `SHALL NOT` declare a
`workspaces` field (a seventh trigger; see anomalyco/opencode issue #49704),
because opencode 1.18.32's bundled pacote forces git-dep preparation (an
inner `npm install` in the cloned repo) for git/github-spec installs whenever
ANY of those triggers is present, and that preparation fails inside the
compiled opencode binary (the spawned `npm-cli.js` runs under the opencode
executable itself). The build task `SHALL` use a non-trigger script name
(`bundle`).

#### Scenario: Install resolves the 1.18.x SDK

Given the package manifest declares `@opencode-ai/plugin` `^1.18.0` in
`peerDependencies` and `devDependencies`,
when `bun install` runs,
then `bun.lock` is regenerated and contains `@opencode-ai/plugin` 1.x
and the build (`bun run bundle`) produces a self-contained `dist/index.js`.

#### Scenario: CLI compatibility range

Given `package.json` declares `"engines": { "opencode": "^1.18.0" }`,
when an opencode CLI outside that range loads the plugin,
then the plugin is skipped with a warning instead of failing the load.

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
experimental chat transforms). The `setup` entry `SHALL` provide v2 forward
compatibility: register the `vision-agent` subagent via `ctx.agent` (only
when absent, using v2 field names `system`/`mode`, never writing
`model`/`disabled`/`permissions`) and the vision skill directory via
`ctx.skill` as a directory source. The v2 path `SHALL` use structural types
with `?.` and `typeof` guards on every domain and draft method so a host
with a missing or reshaped domain no-ops that registration instead of
throwing. Because the v1 loader only reads `server` and ignores extra keys,
and the v2 loader only reads `setup`, the two entries `SHALL` keep disjoint
registration targets and share no mutable state.

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

### Requirement: RB-4: Provider/model id matching is case-insensitive

**Requirement:** `plugin.ts` `SHALL` match provider ids and model ids
case-insensitively when intersecting configured providers with the cached
catalog (`~/.cache/opencode/models.json`), when applying provider
`whitelist`/`blacklist` filters, when evaluating the
`configuredModelVisionCapable` predicate, and when resolving a user-provided
model id (the agent override value). The case-insensitive machinery
(`foldKey` / lowercase key sets) `SHALL` remain intact, and RV-1/RV-2 routing
`SHALL` reuse the same folded lookup for per-message and per-request
capability checks so mixed-case ids keep working.

#### Scenario: Config id casing differs from catalog id

Given a configured provider id `Minimax-Cn-Coding-Plan` and a catalog
provider `minimax-cn-coding-plan` whose model entry is `MiniMax-M3`,
when discovery and override resolution run,
then the model is discovered and a user override of
`minimax-cn-coding-plan/MiniMax-M3` resolves to that catalog entry
case-insensitively.

#### Scenario: Gate with mixed-case model string

Given `cfg.model` is `minimax-cn-coding-plan/minimax-m3` and the catalog
stores `MiniMax-M3` with image input modality,
when `configuredModelVisionCapable` runs (used by the config-time capability
state and RV-1/RV-2 routing),
then it returns true, so a request handled by that model is treated as
vision-capable.

#### Scenario: Persisted override with mixed-case id

Given the user overrides `agent["vision-agent"].model` with
`minimax-cn-coding-plan/minimax-m3` while the catalog id is `MiniMax-M3`,
when the plugin resolves the override,
then the model is recognized as vision-capable (folded match) and image
delegations target a model that can see images.

### Requirement: RB-5: Status filter skips deprecated models

**Requirement:** Discovery `SHALL` skip models whose `status` is
`"deprecated"` and include models with any other status (including
`"active"`, `"beta"`, `"alpha"`, or unset).

#### Scenario: Beta model is selectable

Given a configured model with `status: "beta"` and image input modality,
when discovery runs,
then the model is registered for capability routing and usable as an
`agent["vision-agent"].model` override.

### Requirement: RB-6: SKILL.md is opencode-ized

**Requirement:** `SKILL.md` `SHALL` use opencode terminology throughout, name
`opencode-vision-delegate` as the temporary image subdirectory, and `SHALL
NOT` reference any model discovery script or picker flow — the
`vision-agent` model is configured by the user through the agent model
override in opencode config. The skill's documented tool-call contract
(argument names, error-category prefixes, fallback routing) `SHALL` match the
plugin's tool definition exactly.

#### Scenario: Skill docs match plugin behavior

Given the plugin materializes dropped images under
`<system-temp>/opencode-vision-delegate/`,
when the skill describes Source D,
then it documents `[vision:dropped-image]` with `path` under
`opencode-vision-delegate`.

### Requirement: RB-7: README documents opencode-vision-bridge

**Requirement:** `README.md` `SHALL` describe the plugin's purpose under the
name `opencode-vision-delegate`, the verified installation methods for
opencode 1.18.32 (`opencode plugin opencode-vision-delegate [--global]
[--force]` npm install, `opencode plugin
github:ChengZiiii/opencode-vision-delegate --global` git-spec install,
`file://` config path, single-file `~/.config/opencode/plugin/`), the dual
v1/v2 entry explanation, the single `vision-agent` subagent registered
WITHOUT a default model, the agent model override as the single vision model
knob for both the `vision_analyze` tool and the subagent, the optional
per-image `region` argument with its PNG-only limitation and the zoom
workflow (VT-8), the request tuning knobs (VT-7), the auto-allowed
`vision_analyze` permission (explicit user `deny` wins), the tool-first /
subagent-fallback routing plus the `vision-agent` advanced delegation role,
the disable option (`disable: true` disables both paths), per-model vision
routing (multimodal models receive image parts natively and do not delegate
plain reading; text-only models receive `[vision:dropped-image]` markers and
delegate), skill discovery (`skills.paths` package scan; manual copy for
single-file installs), manual uninstall (remove the `plugin` entry from the
opencode config, delete the `~/.cache/opencode/packages/` store dir for the
installed spec — e.g. `opencode_vision_delegate` for the npm name or
`github_ChengZiiii_opencode-vision-delegate` for the git spec), the
`<system-temp>/opencode-vision-delegate/` image temp dir, a rename note for
users of the pre-rename `github:ChengZiiii/opencode-vision-bridge` spec
(switch the config entry, delete the old store dir), troubleshooting
(including the `crop error` category and its no-fallback, no-retry
handling), and attribution to the upstream MIT projects.

#### Scenario: Installation method verified

Given the README lists the loading methods,
then each method reflects the on-machine verification performed during the
port (works on opencode 1.18.32 sandbox).

#### Scenario: Rename migration documented

Given a user installed the plugin under the pre-rename github spec
`github:ChengZiiii/opencode-vision-bridge`,
when they read the README rename note,
then they know to switch the `plugin` entry to
`github:ChengZiiii/opencode-vision-delegate`, reinstall via `opencode
plugin`, and delete the old store dir
`~/.cache/opencode/packages/github_ChengZiiii_opencode-vision-bridge`.

#### Scenario: Region and zoom documented

Given the README documents the `vision_analyze` arguments,
then the optional per-image `region` argument, the PNG-only limitation, the
in-memory crop (no new files written), and the zoom workflow are all
described.

### Requirement: RB-8: Plugin loads and registers the vision subagent

**Requirement:** The built plugin `SHALL` load without errors on opencode
1.18.32 and register the single `vision-agent` subagent (no `model` set),
visible via `opencode agent list`. Exactly one `vision-*` subagent is ever
registered. A user `disable: true` on `agent["vision-agent"]` `SHALL` hide
it and disable the tool (VT-2).

#### Scenario: Subagent appears

Given the plugin is installed via at least one verified method,
when `opencode agent list` runs,
then it lists exactly one `vision-*` subagent, `vision-agent`, with no
plugin-assigned model.

#### Scenario: Vision-capable main model still registers the subagent

Given the top-level config `model` is set to a vision-capable
`provider/model`,
when the plugin's `config` hook runs,
then `vision-agent` is still registered (so a text-only agent in the same
config can delegate) and the skill remains discoverable.

### Requirement: RV-1: Image parts are rewritten only for text-only models

**Requirement:** The `experimental.chat.messages.transform` hook `SHALL`
rewrite image `FilePart`s into `[vision:dropped-image]` text markers only for
user messages whose handling model is NOT vision-capable. For user messages
whose handling model IS vision-capable, image parts `SHALL` pass through
unchanged so the multimodal model receives them natively. Capability `SHALL`
be resolved per message in this order: (1) the message's `info.model`
(`providerID`/`modelID`) looked up case-insensitively against the
vision-capable key set; (2) the message's `info.agent` looked up in the
agent→capability map built at config time; (3) the top-level config `model`
capability as final fallback. The vision-capable key set `SHALL` be built
from the FULL cached models catalog (`~/.cache/opencode/models.json`) merged
with config provider model overrides (`provider(s).<id>.models`), filtered by
image-input capability, and `SHALL NOT` be gated by provider-availability
heuristics (`enabled_providers`, config provider blocks, environment keys, or
stored credentials) — an already-active request model resolves against
catalog metadata alone. The key set includes deprecated models (capability
resolution reflects the model serving the request; the deprecated-status
filter applies only to the discovery/suggestion path, RB-5).

#### Scenario: Multimodal agent keeps native image input

Given a session on an agent whose model is vision-capable and a user message
containing an image FilePart,
when the messages transform runs,
then the FilePart is left untouched (no `[vision:dropped-image]` marker, no
temp file written).

#### Scenario: Text-only agent gets the marker

Given a session on an agent whose model is text-only and a user message
containing an image FilePart,
when the messages transform runs,
then the image bytes are materialized under the plugin temp dir and the part
is rewritten to `[vision:dropped-image]` with the resulting path.

#### Scenario: Capability resolved from message model before agent name

Given a message whose `info.model` is a vision model while `info.agent` maps
to a text-only agent,
when the transform runs,
then the image part is NOT rewritten (message model wins over agent map).

#### Scenario: Keyless provider session keeps native image input

Given a provider that is present in the cached catalog with a multimodal
model (image input modality) but is NOT availability-configured (no
`enabled_providers` entry, no config provider block, no environment key set,
no stored credential — e.g. keyless Zen `opencode/space-bunny-free`), and a
user message whose `info.model` names that model and contains an image
FilePart,
when the messages transform runs,
then the FilePart is left untouched (no `[vision:dropped-image]` marker, no
temp file written).

### Requirement: RV-2: System prompt instructions are model-appropriate

**Requirement:** The `experimental.chat.system.transform` hook `SHALL`
inspect `input.model` (the `Model` shape with `providerID`/`id`) against the
same vision-capable key set as RV-1 (full cached models catalog merged with
config provider model overrides, case-insensitively, NOT gated by provider
availability) and, for a vision-capable model, push a single
`[vision:native]` instruction stating the model sees images natively, MUST
NOT delegate plain image reading (no vision skill for reading, no
`vision_analyze` without a `region`, no spawning `vision-*` subagents for
reading), but MAY call `vision_analyze` WITH a `region` as a zoom assist when
native resolution cannot resolve small text or fine detail. For a text-only
model the transform `SHALL` inject nothing — delegation guidance comes from
the vision skill (RV-4), and the plugin `SHALL` maintain no model-choice
state of any kind.

#### Scenario: Multimodal model instructed to use native vision

Given a request whose `input.model` is vision-capable,
when the system transform runs,
then `output.system` contains a `[vision:native]` instruction.

#### Scenario: Text-only model gets no injected instruction

Given a request whose `input.model` is text-only,
when the system transform runs,
then `output.system` receives no vision-related injection.

#### Scenario: No persisted state

Given the plugin is installed,
when the config hook runs and the system transform executes,
then no model-choice file is read or written and no
`[vision:model-choice]`-style instruction is injected.

#### Scenario: Keyless multimodal session gets the native instruction

Given a provider that is present in the cached catalog with a multimodal
model but is NOT availability-configured (no `enabled_providers` entry, no
config provider block, no environment key set, no stored credential), and a
request whose `input.model` names that model,
when the system transform runs,
then `output.system` contains a `[vision:native]` instruction and the
session's images route natively instead of delegating to the vision skill
or `vision_analyze`.

#### Scenario: Native instruction permits region zoom assist

Given a request whose `input.model` is vision-capable,
when the system transform runs,
then the `[vision:native]` instruction permits calling `vision_analyze` with
a `region` for zooming into detail while still forbidding delegation of
plain image reading.

### Requirement: RV-4: Skill documents the routing split

**Requirement:** `SKILL.md` `SHALL` state that multimodal models receive
image parts natively and MUST NOT delegate plain reading (region-zoom
assist per RV-2 excepted), that text-only models receive
`[vision:dropped-image]` markers and delegate, and that delegation `SHALL`
target the `vision_analyze` tool first with the `vision-agent` subagent as
fallback on tool unavailability or provider/protocol/HTTP errors. The skill
`SHALL` document the zoom workflow (VT-8): a full-image judgment first,
then a `region` re-call around reported coordinates when the answer needs
small text or fine detail. The skill `SHALL` document the `vision-agent`
dual role: fallback path (unchanged conditions) AND advanced delegation for
multi-image sweeps or deep zoom chains, noting the subagent may call
`vision_analyze` (including `region`) in its own loop. The vision model for
both paths `SHALL` be configured by the user through the agent model
override on `vision-agent` (not by the plugin). It `SHALL` state that
disabling `vision-agent` in opencode config disables both paths.

#### Scenario: Skill guidance matches routing behavior

Given a multimodal orchestrator and a dropped image,
when the skill is consulted,
then it instructs the model to inspect the image natively without calling
`vision_analyze` (absent a `region` zoom need) or spawning a `vision-*`
subagent for reading.

#### Scenario: Skill guidance matches tool-first behavior

Given a text-only orchestrator and a dropped image,
when the skill is consulted,
then it instructs calling `vision_analyze` and mentions the `vision-agent`
subagent fallback.

#### Scenario: Skill documents the zoom workflow

Given a text-only orchestrator whose full-image `vision_analyze` judgment
reports unreadable small text or reports coordinates of a detail region,
when the skill is consulted for the follow-up,
then it instructs re-calling `vision_analyze` with a `region` around the
reported coordinates (with margin) instead of giving up on the detail.

#### Scenario: Skill documents the agent dual role

Given an orchestrator facing a multi-image sweep or a zoom chain that would
take many of its own tool turns,
when the skill is consulted,
then it presents delegating the whole investigation to `vision-agent` as
the advanced option, alongside the unchanged fallback conditions.

### Requirement: RV-6: vision-agent is registered without a default model

**Requirement:** The `config` hook `SHALL` register the single `vision-agent`
subagent on every launch WITHOUT setting its `model` (default = unset),
filling plugin-owned fields (description/mode/prompt/permission/temperature
default) without clobbering user-set values. The vision model `SHALL` be
specified entirely by the user through the agent model override on
`agent["vision-agent"]`; the plugin `SHALL NOT` write the `model` field. The
override `SHALL` serve both the `vision_analyze` tool (VT-2) and the
subagent fallback. A user-set `disable: true` on `agent["vision-agent"]`
`SHALL` remain effective and `SHALL` disable both the tool (VT-2) and the
subagent.

#### Scenario: vision-agent registers with no model

Given the plugin's config hook runs,
when `cfg.agent["vision-agent"]` is inspected,
then it exists with mode `subagent` and NO `model` field set by the plugin.

#### Scenario: User override supplies the model

Given the user overrides `agent["vision-agent"].model` to
`minimax-cn-coding-plan/MiniMax-M3`,
when the config hook runs,
then the override is preserved (the plugin does not touch the model field)
and both the `vision_analyze` tool (VT-2) and visual subagent delegations
use that model.

#### Scenario: Disabled agent disables both paths

Given the user sets `agent["vision-agent"].disable = true`,
when the config hook runs and the registries are inspected,
then `vision-agent` does not appear in `opencode agent list` and
`vision_analyze` is not registered.

### Requirement: VT-1: vision_analyze tool is registered natively

**Requirement:** The plugin `SHALL` register a native tool named
`vision_analyze` through the `@opencode-ai/plugin` `tool` hook on every
launch (unless disabled per VT-2). The tool's arguments `SHALL` be: `images`
— an array of `{id: string, path: string, region?: number[4]}` entries
(short contract ids plus local image paths, each optionally carrying a
`region` per VT-8), `question` — the exact visual question,
`response_template` — a JSON string defining the required response shape,
and optional `response_rules` — task-specific response constraints. The tool
`SHALL` read the listed image files, apply any per-image `region` crop per
VT-8, submit them together with the question to the configured vision model,
and return exactly one JSON object matching `response_template`. Calls whose
`images` entries carry no `region` `SHALL` behave exactly as before this
change.

#### Scenario: Tool is listed

Given the plugin is loaded with `agent["vision-agent"].model` set,
when the tool registry is inspected (e.g. `opencode debug agent
vision-agent --tool vision_analyze`),
then `vision_analyze` is present with the declared arguments.

#### Scenario: Tool returns template-shaped JSON

Given local image paths and a `response_template`,
when `execute` runs against a vision model that returns matching JSON,
then the tool output is that JSON text and the images were included in the
model request as base64 payloads with mime inferred from the paths.

#### Scenario: Missing image file

Given an `images` entry whose path does not exist,
when `execute` runs,
then the tool returns a `missing image` error naming the path and no model
call is made.

#### Scenario: Region-free calls are unchanged

Given an `images` entry without a `region` whose path is a non-PNG image,
when `execute` runs,
then the image is submitted whole, exactly as before this change (no crop
attempt, no format rejection).

### Requirement: VT-2: Tool model comes from the existing vision-agent override

**Requirement:** The `vision_analyze` tool's model `SHALL` be resolved from
the user's `agent["vision-agent"].model` override (same single knob as the
subagent path); the plugin `SHALL NOT` write that field and `SHALL NOT`
invent or default a model. If the override is unset, malformed, or resolves
to a model that is not image-capable per the catalog, `execute` `SHALL`
return a `model not configured` error that names the fix
(`agent["vision-agent"].model`) instead of calling any model. If the user
sets `agent["vision-agent"].disable = true`, the plugin `SHALL NOT` register
the tool.

#### Scenario: No override produces a fixable error

Given `agent["vision-agent"].model` is unset,
when `vision_analyze` is invoked,
then the tool returns a `model not configured` error instructing the user to
set the override and no HTTP request is made.

#### Scenario: Override preserved by the plugin

Given the user sets `agent["vision-agent"].model`,
when the config hook runs,
then the field is unchanged and tool calls target that model id.

### Requirement: VT-3: vision_analyze permission is auto-allowed

**Requirement:** The plugin `SHALL` register a `permission.ask` hook that
upgrades `ask` to `allow` for `vision_analyze` permission requests,
matching the tool name via a first-hit priority chain
(`metadata.tool` → `permission` → `id` → `type`). An explicit
user-configured `deny` (e.g. `permission.vision_analyze = "deny"`) `SHALL`
take precedence and is never overwritten by the hook.

#### Scenario: Subagent session calls the tool without prompting

Given a subagent session whose ruleset has no `vision_analyze` rule,
when the agent calls `vision_analyze`,
then the call proceeds without a permission prompt.

#### Scenario: Explicit deny wins

Given the user configures `permission.vision_analyze = "deny"`,
when an agent calls `vision_analyze`,
then the call is denied (the hook does not override the deny).

### Requirement: VT-4: Skill routes tool-first with subagent fallback

**Requirement:** `SKILL.md` `SHALL` instruct text-only orchestrators to
delegate visual tasks by calling the `vision_analyze` tool first. It `SHALL`
instruct falling back to spawning the `vision-agent` subagent only when (a)
the tool is not present in the current session's toolset, or (b) the tool
call fails with a `provider error` (provider, protocol, or HTTP failure). A
`model not configured` error `SHALL NOT` trigger the fallback; the
orchestrator `SHALL` surface it and direct the user to set
`agent["vision-agent"].model`. An `invalid response` error `SHALL` trigger
exactly one retry. A `crop error` (VT-8) `SHALL` be reported to the user
with its fix and `SHALL` trigger neither retry nor fallback. The skill
`SHALL` keep the existing detect/extract/parse steps and the native-vision
gate (multimodal models MUST NOT delegate plain reading; the `region` zoom
assist of RV-2 is excepted), `SHALL` teach the zoom workflow (full-image
judgment first, then `region` re-call around reported coordinates with
margin), and `SHALL` document the advanced delegation option: a multi-image
sweep or deep zoom chain may be delegated wholesale to `vision-agent`, which
may call `vision_analyze` (including `region`) in its own loop before
returning its single final JSON.

#### Scenario: Tool present routes to the tool

Given a text-only session whose toolset contains `vision_analyze`,
when the skill's delegation step runs,
then it calls `vision_analyze` with `images`, `question`,
`response_template`, and `response_rules`.

#### Scenario: Provider error falls back to the subagent

Given a text-only session where `vision_analyze` exists but returns a
provider/HTTP error,
when the skill's delegation step runs,
then it spawns the `vision-agent` subagent with the same visual task.

#### Scenario: Unconfigured model does not fall back

Given a text-only session where `vision_analyze` returns the "model not
configured" error,
when the skill's delegation step runs,
then it reports the configuration fix to the user and does not spawn a
subagent.

#### Scenario: Crop error does not retry or fall back

Given a text-only session where `vision_analyze` returns a `crop error`
(e.g. a JPEG image with a `region`),
when the skill's delegation step runs,
then it reports the error and its fix (re-call without `region` or convert
to PNG) and neither retries nor spawns a subagent.

#### Scenario: Zoom workflow re-calls with a region

Given a text-only orchestrator whose full-image `vision_analyze` judgment
reports a detail area with coordinates (or unreadable small text),
when the skill's follow-up guidance runs,
then it re-calls `vision_analyze` with a `region` covering the reported
area plus margin, using a response template that asks for
original-image-space coordinates.

#### Scenario: Advanced delegation for sweep tasks

Given an orchestrator facing a many-image sweep or a multi-step zoom chain,
when the skill's delegation guidance runs,
then it offers delegating the whole investigation to `vision-agent` as the
advanced path, with the tool-first single-shot call remaining the default
for bounded questions.

### Requirement: VT-5: Endpoint and credentials resolve for the tool call

**Requirement:** The tool `SHALL` resolve the vision provider's base URL in
this order: (1) `provider.<id>.options.baseURL` from config, (2) an endpoint
from the provider's environment variables when the catalog declares them
(e.g. `MINIMAX_API_HOST`), (3) the provider's catalog `api` field, else a
built-in map of known vision endpoints (minimax family maps to the
Anthropic-style URL), (4) otherwise a clear error. The API key `SHALL`
resolve from the provider's `auth.json` entry (type `api`) first, then from
the provider's declared environment variables; auth resolution `SHALL`
honor `OPENCODE_DATA_DIR`/`OPENCODE_AUTH_CONTENT` overrides. For providers
OTHER than the opencode Zen gateway, a key `SHALL` be required: when none
resolves, the tool `SHALL` return a `provider error` naming the fix and no
request is made. For the opencode Zen gateway (provider id `opencode`,
matched case-insensitively), the key `SHALL` be optional: when none
resolves, the request `SHALL` be sent WITHOUT an `Authorization` (OpenAI
shape) or `x-api-key` (Anthropic shape) header; when a key DOES resolve, it
`SHALL` be used normally. The request `SHALL` use either the
OpenAI-compatible `/chat/completions` shape (image parts as `data:` base64
URLs, `Bearer` auth) or the Anthropic-style `/messages` shape (image parts
as base64 content blocks, `x-api-key`), selected by the resolved endpoint
URL: endpoints whose URL contains `/anthropic` `SHALL` use the Anthropic
shape, all others the OpenAI shape. The shape split is required because
some vision endpoints (e.g. `api.minimaxi.com`) drop `data:` `image_url`
parts on their OpenAI-compatible endpoint while their Anthropic-style
endpoint delivers them (verified during the upstream spike). Image bytes
`SHALL` never be passed through shell commands — files are read via Node fs
APIs only. When resolution or the request fails, the error `SHALL` be
descriptive enough for the skill's fallback (VT-4) and for the user.

#### Scenario: Config baseURL wins

Given `provider.<id>.options.baseURL` is set to a custom endpoint,
when the tool resolves the endpoint,
then that base URL is used.

#### Scenario: Known provider default

Given a provider in the built-in endpoint map and no config/env override,
when the tool resolves the endpoint,
then the mapped default is used.

#### Scenario: Anthropic-style endpoint uses the /messages shape

Given a resolved base URL of `https://api.minimaxi.com/anthropic/v1`,
when the tool builds the request,
then the request is an Anthropic-style POST to `<base>/messages` with
base64 image content blocks and an `x-api-key` header.

#### Scenario: OpenAI-compatible endpoint uses the chat/completions shape

Given a resolved base URL without an Anthropic marker,
when the tool builds the request,
then the request is an OpenAI-compatible POST to `<base>/chat/completions`
with `data:` base64 `image_url` parts and a `Bearer` Authorization header.

#### Scenario: Unresolvable endpoint errors

Given a provider with no config baseURL, no env host, no catalog `api`
field, and no map entry,
when the tool resolves the endpoint,
then it returns a descriptive `provider error` and no request is made.

#### Scenario: Non-Zen provider without a key still errors

Given a non-Zen provider (e.g. `minimax-cn-coding-plan`) with no
`auth.json` entry and no provider env key,
when the tool resolves credentials,
then it returns a `provider error` naming the authentication fix and no
request is made (pre-change behavior preserved).

#### Scenario: Zen free model works with no key

Given `agent["vision-agent"].model = "opencode/space-bunny-free"` with no
`auth.json` entry for `opencode` and `OPENCODE_API_KEY` unset,
when `vision_analyze` executes,
then the request is sent to `https://opencode.ai/zen/v1/chat/completions`
WITHOUT an `Authorization` header and the free model's response is parsed
normally.

#### Scenario: Zen with a configured key still authenticates

Given the `opencode` provider has an `auth.json` entry (type `api`),
when the tool resolves credentials for a Zen model,
then the request carries the normal `Authorization: Bearer <key>` header.

#### Scenario: Zen provider id matches case-insensitively

Given a catalog/config provider id of `OpenCode`,
when keyless allowance is evaluated,
then it matches the Zen gateway provider id `opencode` case-insensitively.

### Requirement: RB-9: Skill discovery is package-path based

**Requirement:** The plugin `SHALL` register the vision skill for discovery
by pushing the package data dir (the directory containing `SKILL.md`) onto
`config.skills.paths` in the `config` hook; opencode scans `**/SKILL.md`
under each path from the live merged config with absolute paths allowed and
no trust gating (opencode has no `skill_path_origins` mechanism). The plugin
`SHALL NOT` write, copy, or sync `SKILL.md` (or any mirror of it) into the
opencode config skills directory (`~/.config/opencode/skills/` or
equivalent) at module load or at any other time — this mirrors the kilo
upstream spec decision (remove-skill-mirror-sync). Skill discovery `SHALL`
come from the installed package directory, which resolves from the plugin's
own location (`import.meta.url`) so it follows package upgrades
automatically. The package `SHALL NOT` ship a skill installer script (no
postinstall copy); single-file `~/.config/opencode/plugin/` installs `SHALL`
rely on the documented manual `SKILL.md` copy.

#### Scenario: Package install discovers the skill without a mirror

Given a package install (`file://` path, npm, or github spec) with NO
`~/.config/opencode/skills/vision/SKILL.md` file present,
when the plugin loads and skills are scanned,
then the `vision` skill is discoverable from the installed package
directory via `skills.paths`.

#### Scenario: Module load performs no config-dir writes

Given the plugin loads,
when module evaluation runs,
then no file is written under the opencode config skills directory
(`~/.config/opencode/skills/` or equivalent).

### Requirement: VT-6: vision response parsing tolerates non-JSON wrappers

**Requirement:** When extracting the vision model's text response, the tool
`SHALL` accept a JSON object that is wrapped in a single markdown code fence
or surrounded by leading/trailing prose, by cleaning the text before
validating it. Cleaning `SHALL` be attempted in this order: (1) strict
`JSON.parse` of the trimmed text; (2) if that fails, strip a single
surrounding markdown code fence and re-attempt; (3) if that fails, extract
the first brace-balanced `{ … }` substring (string- and escape-aware) and
re-attempt. The first step that yields a single JSON object (not an array,
scalar, or `null`) `SHALL` win, and the tool `SHALL` return the cleaned JSON
text, not the raw wrapped text. If every step fails, the tool `SHALL`
return the `invalid response: model output is not valid JSON: …` error so
VT-4 skill routing (retry / subagent fallback) is unaffected.

#### Scenario: Markdown-fenced JSON is accepted

Given a vision model whose text response is a `json`-fenced object,
when the tool parses the response,
then the tool returns the unfenced JSON object text and no error is raised.

#### Scenario: JSON surrounded by prose is accepted

Given a vision model whose text response is
`Sure, here is the result:\n{"visible": true}\nHope that helps.`,
when the tool parses the response,
then the tool returns the JSON object text `{"visible": true}` and no error
is raised.

#### Scenario: Arrays and scalars are still rejected

Given a vision model whose text response is `[1, 2, 3]` or `"just a
string"`, with or without a surrounding fence,
when the tool parses the response,
then the tool returns an `invalid response` error (the "single JSON object"
contract of VT-1 is preserved).

#### Scenario: Error category is unchanged

Given a response that fails every cleaning step,
when the tool parses the response,
then the thrown error is prefixed `vision_analyze: invalid response:` (the
category that VT-4 / SKILL.md Step 6 keys on).

### Requirement: VT-7: Tool-path request knobs and timeout

**Requirement:** Because the `vision_analyze` tool calls the provider
directly, runtime-injected model options (variants, thinking control) do not
apply to it. The plugin `SHALL` provide three knobs on the same
`vision-agent` entry: `temperature` (native agent option; plugin default 0.1
applied only when the user has not set one), and `extraBody` (generic body
passthrough deep-merged into the final request body — arrays and scalars
replace, objects merge). The timeout ceiling for one vision call `SHALL`
come from `OPENCODE_VISION_TIMEOUT_MS` (default 300000; values <= 0 disable
the timeout; invalid values fall back to the default). OpenAI-shaped
requests `SHALL` set no `max_tokens`; Anthropic-shaped requests `SHALL` keep
the protocol-required `max_tokens` (default 8192, overridable via
`extraBody`). On timeout the error `SHALL` read `timeout after <N>ms
posting <url>` and carry the `provider error` category so VT-4 fallback
routing still applies.

#### Scenario: extraBody disables thinking

Given `agent["vision-agent"].extraBody = { "thinking": { "type": "disabled"
} }`,
when the tool builds the request body,
then the final body contains the disabled-thinking object deep-merged at the
right position.

#### Scenario: Timeout ceiling is honored

Given `OPENCODE_VISION_TIMEOUT_MS=50` and an endpoint that does not respond,
when `execute` runs,
then the error is classified as a timeout (`timeout after 50ms posting
<url>`), not a generic network error.

#### Scenario: Timeout disabled with non-positive value

Given `OPENCODE_VISION_TIMEOUT_MS=0`,
when the tool composes the request,
then no timeout signal is composed (only the abort signal applies).

### Requirement: VT-8: Optional region crop preserves region resolution

**Requirement:** The `vision_analyze` tool `SHALL` accept an optional
per-image `region: [x1, y1, x2, y2]` — exactly four integers in
ORIGINAL-image pixel coordinates, origin top-left, `x2`/`y2` exclusive,
clamped to the image bounds (non-integer or wrong-arity values `SHALL` be
rejected by the tool's argument schema before `execute` runs). PNG-ness
`SHALL` be determined by the file's signature bytes, not its path extension.
When a `region` is present and the image is a supported PNG (8-bit depth,
color types 0/2/3/4/6, non-interlaced), the tool `SHALL` crop the region IN
MEMORY before base64 encoding, so the vision model receives the region at
full source resolution rather than a provider-downsampled full image; a
cropped image `SHALL` be submitted with `image/png` mime regardless of the
original path extension. The
crop `SHALL` be implemented with no runtime dependency beyond Node's
builtin `zlib` and `SHALL NOT` write any file to disk (the existing image
materialization dir is the plugin's only write target and is not used for
crops). Image bytes `SHALL` never pass through shell commands (VT-5
principle). When a `region` is applied, the tool `SHALL` append a
coordinate-disclosure instruction to the request text telling the vision
model the image is a crop of the original with origin `(x1, y1)` and that
any coordinates it reports MUST be in ORIGINAL-image pixel space (add the
origin); the tool's response contract `SHALL` remain exactly one JSON
object matching the caller's `response_template` (no extra keys, no
envelope). A `region` on a non-PNG image, or on an unsupported PNG variant
(16-bit, interlaced, or undecodable), or a region that is empty after
clamping, `SHALL` return a `vision_analyze: crop error:` prefixed error
naming the image id and the concrete fix, with no HTTP request made. The
`crop error` category is deterministic and local: the skill (VT-4) neither
retries nor falls back to the subagent on it.

#### Scenario: Region reaches the model at full resolution

Given a 3000x2000 PNG and `region: [1200, 800, 1600, 1000]`,
when `execute` runs,
then the base64 payload submitted to the vision model decodes to a
400x200 image containing exactly the requested pixels, and the request
text carries the coordinate-disclosure instruction with origin (1200, 800).

#### Scenario: Region is clamped to image bounds

Given a 1000x500 PNG and `region: [900, 400, 1200, 600]`,
when `execute` runs,
then the crop covers [900, 400)–[1000, 500) (100x100 pixels) and no error
is raised.

#### Scenario: Non-PNG image with a region errors cleanly

Given a JPEG image entry carrying a `region`,
when `execute` runs,
then the tool returns a `crop error` naming the image id, stating PNG-only
support, and suggesting a re-call without `region`; no HTTP request is
made.

#### Scenario: Unsupported PNG variant errors cleanly

Given a 16-bit or interlaced PNG entry carrying a `region`,
when `execute` runs,
then the tool returns a `crop error` naming the variant limitation and the
fix; no HTTP request is made.

#### Scenario: Degenerate region is rejected

Given a PNG entry with `region: [100, 100, 100, 100]` (or any region empty
after clamping),
when `execute` runs,
then the tool returns a `crop error` describing the degenerate region and
no HTTP request is made.

#### Scenario: Response contract unchanged under a region

Given a `region` call whose vision model returns JSON matching the
template,
when `execute` returns,
then the tool output is that JSON text alone — no wrapper object, no added
keys, no coordinate metadata appended.
