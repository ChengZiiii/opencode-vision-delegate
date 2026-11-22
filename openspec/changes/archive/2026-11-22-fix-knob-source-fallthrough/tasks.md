# Tasks: fix-knob-source-fallthrough

## 1. Fix

- [x] 1.1 `resolveV2Knobs` fall-through: a source wins only when its knobs
      carry `model !== undefined` or `disabled === true`; otherwise continue
      to the next source (transform snapshot → config file → unset).
- [x] 1.2 Shared `readAgentModelRef`: string passthrough, `{providerID, id}`
      and `{providerID, modelID}` fold to `providerID/model`, else
      undefined. Wire it into all five capture sites (v1 agents capture,
      v1 vision-agent capture, readV2AgentKnobs, refreshV2AgentsMap,
      transform draft.list loop).

## 2. Tests

- [x] 2.1 Shape-fold unit legs: all three accepted shapes resolve to the
      same `providerID/model` string; garbage/absent → undefined.
- [x] 2.2 Fall-through legs: model-less domain record + config file in a
      temp OPENCODE_CONFIG_DIR → override resolves (no tier-1 error);
      disabled domain record wins immediately (tool suppressed, no
      fall-through); domain record WITH model still beats the file.
- [x] 2.3 Existing VT-2 legs stay green (unset override error byte-identical;
      unset-model no-HTTP; v1 capture unchanged for string configs).

## 3. Verify (③ GATE — sandbox, production-identical seam)

- [x] 3.1 `bun run typecheck` + full `node --test tests/*.test.mjs` green;
      `bun run bundle` (dist self-contained, committed).
- [x] 3.2 Sandbox serve (isolated OPENCODE_CONFIG_DIR + XDG) with the FIXED
      dist dir-scanned from `.opencode/plugins/vision-fixed/` (the verified
      v2 hand-written path) and the user-mirrored config (string model +
      variant + extraBody): a real prompt invokes `vision_analyze` on a real
      PNG via the image-capable sandbox provider → a real verdict JSON comes
      back; the tier-1 `model not configured` string appears nowhere. The
      shape-probe plugin re-dumps the domain record for the record.
- [x] 3.3 `opencode.jsonc`-bearing fallback leg: file fallback parses the
      .jsonc spelling (temp dir) — covered by 3.2's config mirroring.

## 4. Release (④ GATE — npm ladder, user-authorized)

- [x] 4.1 Version 0.3.1 → 0.3.2 (`chore: release 0.3.2` commit, dist
      bundled in).
- [x] 4.2 `npm pack --dry-run` whitelist check → publish from the tgz →
      poll `dist-tags` until `latest = 0.3.2`; report shasum for 对账.
- [x] 4.3 Quarantine the host cache copy of 0.3.1 (rename into
      `_quarantine`, never delete); config already points at the
      unversioned npm specifier.
- [x] 4.4 User restarts (shared with forge 0.32.1) and calls vision_analyze
      on a real screenshot: a verdict comes back (no `model not
      configured`). The palette screenshot leg (previously blocked on this
      fix) unblocks at the same restart.
- [ ] 4.5 D6 note: the subagent delegation leg's real-host kill rides the
      user's next SKILL-routed vision call (unit-covered otherwise).
