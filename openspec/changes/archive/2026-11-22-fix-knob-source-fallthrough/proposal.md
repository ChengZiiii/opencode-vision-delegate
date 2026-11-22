# Proposal: fix-knob-source-fallthrough

## Why

`vision_analyze` died with the tier-1 `model not configured` error on the
real host (2.3.2) even though the user's config sets
`agent["vision-agent"].model = "glm-coding-worker/glm-5.3-flash"` (a plain
string). Sandbox probe ground truth (2026-11-22, production-identical
loading: v2 `plugins` array + the npm package + a dir-scanned shape probe
plugin): `ctx.agent.get("vision-agent")` returns a record that is PRESENT
but carries NO model (`record.model` undefined — an enumerable-empty
skeleton, still model-less 8s after a session exists; the model the host
shows via `/api/agent` lives in a different serialization). `resolveV2Knobs`
treats record presence as resolution success and early-returns
`model: undefined`, short-circuiting BOTH later sources: the transform-time
snapshot (undefined on this host ordering) and the config-file fallback —
which reads the same `opencode.jsonc` that HAS the model string and parses
it correctly. The model was one fall-through away the whole time.

The same probe confirms the production entry path: on a `plugins` config
the v2 loader runs `setup` only (v1 hooks never fire), so the v2 resolver
is the only knob path on this host.

Secondary gap, same probe family: the model-fold readers accept a string
or `{providerID, id}` but not `{providerID, modelID}` (the raw config
spelling before host normalization) — five capture sites fold shapes
inconsistently (two v1 string-only sites, two v2 object-fold sites, one
shared reader).

## What Changes

- **MODIFIED**: VT-2 (tool model resolution) — a knob source "wins" only
  when it actually yields usable knobs (`model` set, or `disable: true`);
  a present-but-knobless record falls through to the next source. The
  config-file fallback is therefore reached on 2.3.2 and resolves the
  override. All four existing VT-2 scenarios carry.
- Unify the five model-shape fold sites on one shared reader that accepts
  `string`, `{providerID, id}`, and `{providerID, modelID}` (fold to
  `providerID/modelID-or-id`), so v1 captures, the v2 reader, and the
  capability-map builders cannot drift again.
- Tests: shape-fold unit legs + fall-through legs (model-less domain
  record → file fallback wins; disabled domain record still wins
  immediately).
- Verification: production-identical sandbox E2E — fixed dist loaded via
  the verified dir-scan path, real prompt invoking `vision_analyze` on a
  real PNG through the image-capable sandbox provider, asserting a real
  verdict (no tier-1 error).

## Impact

- Specs: `specs/vision-bridge/spec.md` (one MODIFIED requirement, all
  scenarios carried + two new).
- Code: `plugin.ts` (resolver fall-through + one shared shape reader
  replacing five sites), tests (`tests/v2-setup.test.mjs`).
- Release: patch 0.3.2 through ③ sandbox → ④ npm ladder (config already
  points at the unversioned npm specifier; one host restart picks up both
  this and forge 0.32.1).
- Backward compatibility red lines hold: the knob stays
  `agent["vision-agent"].model`, error prefixes unchanged, `disable`
  semantics unchanged (a disabled domain record still suppresses
  immediately).
