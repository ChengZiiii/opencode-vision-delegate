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
