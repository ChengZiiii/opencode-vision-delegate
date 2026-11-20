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
