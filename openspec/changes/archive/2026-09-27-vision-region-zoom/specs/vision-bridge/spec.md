## MODIFIED Requirements

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

## ADDED Requirements

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
