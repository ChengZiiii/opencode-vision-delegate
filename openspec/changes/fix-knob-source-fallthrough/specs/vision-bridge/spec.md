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
override is unset". A knob source `SHALL` win the resolution only when it
actually yields usable knobs — the model reference set, or
`disable: true`; a record that is present but carries no model reference
(observed on 2.3.2: the agent-domain getter returns an enumerable-empty
skeleton for config-defined agents) `SHALL NOT` terminate the resolution
and `SHALL` fall through to the next source, including the user's config
file. The model reference `SHALL` be read uniformly across the v1 captures,
the v2 reader, and the capability-map builders: a string passes through;
an object carrying `providerID` plus `id` or `modelID` folds to
`providerID + "/" + (id ?? modelID)`. If the override is unset, malformed,
or resolves to a model that is not image-capable per the catalog, `execute`
`SHALL` return a `model not configured` error that names the fix
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

#### Scenario: A present-but-model-less domain record falls through

Given a v2 host whose agent-domain getter returns a record for
`vision-agent` that carries no model reference (the observed 2.3.2
skeleton), and the user's config file sets
`agent["vision-agent"].model` to a valid image-capable `provider/model`
string,
when `vision_analyze` executes,
then the knob-less domain record does not terminate the resolution: the
config-file fallback resolves the override, the configured model id is
targeted, and no `model not configured` error is produced.

#### Scenario: A disabled domain record wins immediately

Given a v2 host whose agent-domain getter returns a vision-agent record
with `disable: true`,
when the knobs resolve,
then the disabled verdict applies at once (the tool is not offered) and no
later source can re-enable it.

#### Scenario: Model reference shapes fold uniformly

Given the override's model expressed as a plain string, as
`{providerID, id}`, or as `{providerID, modelID}`,
when any capture site reads it (v1 config capture, v2 knob reader,
capability-map builders),
then all three shapes resolve to the same `providerID/modelID` reference
string.
