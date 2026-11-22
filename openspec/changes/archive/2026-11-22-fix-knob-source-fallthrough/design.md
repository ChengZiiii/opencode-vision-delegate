# Design: fix-knob-source-fallthrough

## Decision

Two changes in `plugin.ts`, both small and behavior-preserving on healthy
hosts:

1. **Fall-through win condition** in `resolveV2Knobs`: a source wins only
   when its knobs carry `model !== undefined` or `disabled === true`.
   Otherwise resolution continues to the next source (transform snapshot,
   then config file). Rationale: the probe (below) shows the 2.3.2 domain
   getter returns a PRESENT record with no knobs for config-defined agents;
   presence was treated as success, starving the file fallback that has the
   real override. Disabling stays instant: a `disable: true` record must
   never be bypassable by a later source.
2. **One shared shape reader** `readAgentModelRef(model: unknown)`:
   string passthrough; `{providerID, id}` and `{providerID, modelID}` fold
   to `providerID + "/" + (id ?? modelID)`; anything else → undefined.
   Replaces five inconsistent sites: v1 config agents capture, v1
   vision-agent capture, `readV2AgentKnobs`, `refreshV2AgentsMap`, and the
   transform-time draft.list loop.

## Field realities (sandbox probe, 2.3.2, 2026-11-22)

Production-identical sandbox: isolated `OPENCODE_CONFIG_DIR` + XDG, config
mirroring the user's (`plugins: ["opencode-vision-delegate"]`,
`agent["vision-agent"]` with STRING model + variant + extraBody, glm
provider), real npm 0.3.1, probe plugin dir-scanned from
`.opencode/plugins/<name>/` (the verified hand-written v2 path), session
created to trigger plugin loading.

- **Entry path**: the v2 loader ran `setup` (probe ctx carries all v2
  domains; no v1 hook fired). v1-only capture paths are dead code on this
  host — the v2 resolver is the only knob path.
- **`ctx.agent.get("vision-agent")`**: returns an object whose enumerable
  JSON is `{}` and whose `.model` direct access is `undefined` — at setup
  AND 8s later with a session created. The host's `/api/agent` shows
  `{providerID, id, variant}` (HTTP serializer reads elsewhere) — the
  domain getter does not serve the merged knobs.
- **Raw config**: `model` is the string `"glm-coding-worker/glm-5.3-flash"`,
  `variant: "low"`, `extraBody: {reasoning_effort: "low"}` — so the file
  fallback (jsonc-tolerant, .json→.jsonc tried) would resolve it; it was
  never reached because source 1 early-returned.
- **vision-agent registration**: config-defined agents register natively —
  its presence in `/api/agent` is NOT evidence of plugin liveness (only the
  tool transform + skill registration are).

## Why the earlier fix shipped incomplete

`fix-v2-knob-capture-timing` (0.3.1) added the lazy resolver with the right
source ORDER but asserted "the merged record carries the config's model"
from `/api/agent` evidence — an HTTP-serializer observation, not the domain
getter the resolver actually calls. The task-3.4 live capture verified
registration and permission legs, not the knob record shape at execute
time. Process lesson: assert the exact seam being coded against (here,
`ctx.agent.get`), not a sibling API that serializes differently.

## Verification shape (③)

1. Unit (tests/v2-setup.test.mjs): shape-fold legs (string / {p,id} /
   {p,modelID} / garbage); fall-through legs (model-less domain record →
   file fallback resolves via a temp OPENCODE_CONFIG_DIR; disabled domain
   record wins immediately; domain record WITH model still wins over the
   file).
2. Sandbox E2E (production-identical): fixed dist dir-scanned from
   `.opencode/plugins/vision-fixed/` + real prompt invoking
   `vision_analyze` on a real PNG through the image-capable sandbox
   provider (glm-5.3-flash: attachment true, input [text, image]) — assert
   a real verdict JSON, no tier-1 error string. The subagent delegation leg
   is covered by unit tests of the capability map; its real-host kill stays
   opportunistic (the user's next vision call exercises it immediately —
   D6-noted).
3. ④ npm 0.3.2 ladder: publish → dist-tags → quarantine 0.3.1 cache copy →
   user restart (shared with forge 0.32.1) → real vision_analyze call.
