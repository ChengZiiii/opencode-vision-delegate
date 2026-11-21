# fix-v2-knob-capture-timing — design

## Observed failure (live 2.3.2, 2026-11-20)

Sequence on the real host with `agent["vision-agent"].model` set:

1. `ctx.agent.transform(cb)` runs; `draft.get("vision-agent")` returns
   `undefined` (user config agent entries not yet merged into the draft).
2. The create-only registration therefore fires: the plugin writes its
   `description`/`system` into a NEW record (this is why the final record
   carries the plugin's wording).
3. After plugin transforms, the host merges the user config agent entry:
   the final record gains `model: {id, providerID, variant}` from config.
4. `vision_analyze` executes with the transform-time knob snapshot —
   `model: undefined` → `model not configured`, although `/api/agent`
   shows the fully merged record with the configured model.

Additional confirmation: the recorded `variant: "low"` (a config-only
field the plugin never writes) appears in the final record — the merge
definitely happens after the plugin's transform.

## Fix shape

Knobs become a function of the record at EXECUTE time, not a snapshot:

- `resolveV2Knobs()` (new) attempts, in order:
  1. agent-domain getter: `ctx.agent.get?.("vision-agent")` /
     `ctx.agent.list?.()` — PROBE FIRST on the live host (task 1.1); the
     port's existing structural-typing guards (`?.` + typeof) apply.
  2. Config-file fallback: read the user's config via the same discovery
     the host documents (`OPENCODE_CONFIG_DIR` env, else
     `~/.config/opencode/opencode.json(c)`), minimal JSONC-tolerant
     parse (strip comments/commas), extract `agent["vision-agent"]`
     knobs read-only. This path only runs when the domain getter is
     unavailable; it NEVER writes and never invents a model.
  3. If both unavailable → current behavior (exact `model not
     configured` error, byte-identical prefix).
- The capability map (`draft.list()` consumers) gets the same deferred
  source where available; if the host exposes no post-merge list, the
  limitation is documented in README (native-vision gate falls back to
  the default-model check only).

## Test plan additions

- Ordering test (the actual failure): transform runs with a draft whose
  `get("vision-agent")` is `undefined`; the domain getter later returns
  the merged record with `model`; `execute` resolves the model and makes
  no `model not configured` error.
- Fallback test: no domain getter; config file fixture with JSONC
  comments; knobs resolve; plugin never writes the file.
- Contract tests kept: error prefixes, disabled suppression, malformed
  model id, non-image-capable model — all byte-identical.

## Non-goals

- No change to VT-2 semantics, knob fields, error category prefixes, or
  the never-write rule.
- No V1 entry changes (the v1 config hook snapshot is correct on v1
  hosts — config hook runs with the config in hand).
- No re-registration changes: the create-only contract stays; on hosts
  with the merge-after-transform ordering the registration firing for a
  config-defined entry is harmless today (fields merge over it) and its
  full treatment belongs to a host-behavior discussion, not this fix.

## Probe resolution (task 1.1 / 1.2 — live session, 2026-11-20)

- **1.1 (domain getter outside transform)**: the config → agent merge is
  the built-in plugin `opencode.agent`'s `agent.transform`, running AFTER
  ordinary plugin transforms. A plugin's `ctx.agent.transform` therefore
  observes `draft.get("vision-agent") === undefined` for config-defined
  entries while the final merged record carries the config's
  `model {id, providerID, variant}`. Since every plugin transform has
  finished by the time any tool `execute` runs, the merged record is
  guaranteed settled at the agent layer at execute time — the domain
  getter at execute time is the primary resolution source (kept behind a
  `typeof get === "function"` guard with a config-file fallback, so hosts
  whose domains expose no getter degrade gracefully).
- **1.2 (config discovery)**: `ctx.options` on 2.3.2 is an EMPTY object
  (not the user config). The fallback reads the host's global config file
  exactly as the host documents discovery: `OPENCODE_CONFIG_DIR` when set,
  else `~/.config/opencode/opencode.json(c)`. JSONC comments and trailing
  commas are stripped before `JSON.parse`; only
  `agent["vision-agent"].{model,disable,disabled,temperature,extraBody}`
  are read; the file is never written.
- Agent record `model` object shape `{id, providerID, variant}` folds to
  `"providerID/id"` (the `variant` field is ignored by the fold) — reuse of
  the existing `readV2AgentKnobs` folding.

## Implementation notes (apply phase)

- Source order in `resolveV2Knobs()`: domain getter → transform-time
  snapshot → config-file fallback → unset. The transform-time snapshot is
  retained as a middle source because on hosts whose drafts already carry
  the record it is a valid observation, and keeping it preserves behavior
  for the existing wired-test legs.
- The registration-time disabled gate also resolves lazily
  (`if (!resolveV2Knobs().disabled …)`), and `runVisionAnalyze`
  independently guards `disabled` at execute time — a config-merged
  disable that was invisible at transform time is still observed.
- Capability map (task 2.2): BOTH deferred-refresh and documented
  limitation — `refreshV2AgentsMap()` re-reads the domain `list`/`get` at
  every session-context hook when available; on hosts without a post-merge
  list the transform-time map persists (README documents the limitation).

## Post-apply sandbox verdict (P2, 2.3.2, 2026-11-20)

Execute-time readability probed on a sandbox host (probe report in the
forge workspace, `reports/probe-v2-surface-report.md`):

- The agent domain handle is ALIVE at execute time (`get`, `list`,
  `transform`, `reload` all present; `exists: true`) — the primary
  resolution source is reachable, as designed.
- BUT records fetched through it serialize to `{}` (class-instance
  shape) and `list()` returns a non-array. Whether DIRECT property
  access (`record.model`) still reads merged fields is NOT decidable
  from this evidence — prototype getters are invisible to JSON
  serialization, so `{}` is a serialization fact, not necessarily an
  access fact.
- Consequence: the layered source order stands unchanged. If direct
  access works, the domain getter resolves knobs as designed; if it
  does not, resolution degrades to the config-file fallback — which
  reads the same file the config→agent merge read, so the resolved
  values are identical either way. User-visible behavior is correct on
  2.3.2 in both branches; the live-host verification (task 4.2) will
  observe which layer actually serves.
