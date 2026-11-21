# fix-v2-knob-capture-timing — vision-bridge delta

## MODIFIED Requirements

### Requirement: VT-2: Tool model comes from the existing vision-agent override

**Requirement:** The `vision_analyze` tool's model `SHALL` be resolved from
the user's `agent["vision-agent"].model` override (same single knob as the
subagent path); the plugin `SHALL NOT` write that field and `SHALL NOT`
invent or default a model. On the v2 loader, the resolution `SHALL NOT`
depend on transform-time ordering: because the host merges user-config
agent entries into the agent draft only after plugin transforms run
(observed on opencode 2.3.2), the plugin `SHALL` resolve the knobs from a
source that observes the MERGED record — the agent domain's record at
execute time, or an equivalent post-merge observation of the user's
config — and `SHALL NOT` treat a transform-time empty snapshot as "the
override is unset". If the override is unset, malformed, or resolves
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

#### Scenario: Config merged after transform still resolves

Given a v2 host whose agent draft does not contain the user-config
vision-agent entry at transform time and merges it afterwards,
when `vision_analyze` executes,
then the knob resolves from the merged record (the configured model id is
targeted) and no `model not configured` error is produced.

#### Scenario: No post-merge observation point degrades honestly

Given a v2 host that exposes neither an agent-domain getter usable at
execute time nor a discoverable user config,
when `vision_analyze` executes,
then the tool returns the exact `model not configured` error naming
`agent["vision-agent"].model` (no invented model, no HTTP request).

## MODIFIED Requirements

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
`SHALL` be resolved LAZILY at execute time from a post-merge observation of
the user's `vision-agent` agent record — the agent domain's record when its
getter is reachable, else a read-only parse of the user's config file
(`OPENCODE_CONFIG_DIR` aware, JSONC tolerant, never written) — never from a
transform-time snapshot alone (the plugin still never writes `model` or
`disabled`); a record that is unset or unreachable on BOTH sources degrades
to the exact VT-2 `model not configured` error contract. The capability map
the router consults (which agent ids are vision-capable) `SHALL` be re-read
from the agent domain at each session-context hook when the domain exposes a
post-merge list/get; hosts without such a surface keep the transform-time
map (a documented README limitation). All error-category prefixes `SHALL`
stay byte-identical to the V1 path so SKILL.md routing (VT-4) is unaffected.

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
  on their config's `vision-agent` entry and the v2 host merges config agent
  entries only after plugin transforms
- **THEN** `vision_analyze` targets that model with those request knobs
  (resolved lazily at execute time — the empty transform-time snapshot did
  not matter), and the plugin has written no `model`/`disabled` field
  anywhere

#### Scenario: Unset model keeps the fixable error on V2

- **WHEN** `vision_analyze` executes on a V2 host with no model configured
- **THEN** the error is the `model not configured` category naming
  `agent["vision-agent"].model`, and no HTTP request is made

#### Scenario: The capability map refreshes post-merge when the domain allows

- **WHEN** a v2 host exposes an agent-domain list/get that reflects merged
  records and a session-context hook fires
- **THEN** the router's capability map is re-read from the domain
  (config-declared agent capabilities are honored); on hosts without such a
  surface the transform-time map persists and the README limitation applies
