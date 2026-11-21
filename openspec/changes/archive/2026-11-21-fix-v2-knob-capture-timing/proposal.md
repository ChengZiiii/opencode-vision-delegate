# fix-v2-knob-capture-timing

## Why

On the real opencode 2.3.2 host, `vision_analyze` fails with
`model not configured` even though `agent["vision-agent"].model` is
correctly set in the user's config. Root cause (observed live,
2026-11-20): the v2 port snapshots the tool knobs inside
`ctx.agent.transform` via `draft.get("vision-agent")`, but the host
merges user-config agent entries into the draft only AFTER plugin
transforms run. Evidence: the plugin's create-only registration fired
(wrote its description/system into the record) while the config's
`model`/`variant` values only appear in the final merged record — the
transform-time snapshot observed `undefined` for a config key that is
present on disk and in the resolved agent record exposed by
`/api/agent`. The same ordering flaw affects the agent-name →
vision-capability map built from `draft.list()` at transform time.

The knob contract (VT-2) is not the problem — the config is intact and
the knob semantics are unchanged. The defect is purely the observation
point: a transform-time snapshot cannot see config-merged state on this
host.

## What Changes

- Knob resolution moves from a transform-time snapshot to a lazy
  execute-time resolution that observes the MERGED vision-agent record.
  Primary mechanism: the agent domain's own getter (if the domain handle
  exposes one outside `transform`), probed on the live host first.
  Fallback mechanism if the domain exposes no such getter: read the
  user's config the same way the host discovers it
  (`OPENCODE_CONFIG_DIR` awareness + global config file, minimal
  JSONC-tolerant read) strictly as a fallback, keeping the exact VT-2
  knob semantics (never write, never invent a model).
- The vision-capability map gains the same deferred treatment (or an
  explicit documented limitation if the host offers no post-merge
  observation point for the full agent list).
- Unit tests add the actual failure ordering: `draft.get` returns
  `undefined` at transform, the merged record with `model` appears
  later — `execute` must resolve the model anyway.
- No change to VT-2 semantics: error category prefixes, knob fields,
  and the never-write rule are byte-identical.

## Capabilities

### Modified Capabilities

- `vision-bridge`: VT-2 is amended — on the v2 loader the knob `SHALL`
  be resolved from the merged vision-agent record (post-config-merge)
  rather than a transform-time snapshot; all existing VT-2 scenarios
  keep their meaning and two ordering scenarios are added.
