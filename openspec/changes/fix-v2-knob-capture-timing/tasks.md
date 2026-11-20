# fix-v2-knob-capture-timing — tasks

## 1. Probe (live 2.3.2 host)

- [x] 1.1 Probe whether the agent domain handle exposes `get`/`list`
  usable OUTSIDE `transform` (i.e. callable at tool-execute time) and
  whether they return the merged record. Record observed shapes in
  design.md (resolve the SANDBOX-PENDING assumption).
- [x] 1.2 Probe config discovery for the fallback path: does
  `OPENCODE_CONFIG_DIR` redirection + global config file read yield the
  `agent["vision-agent"]` knobs? Confirm the active config path the
  service actually uses.

## 2. Implement

- [x] 2.1 Add `resolveV2Knobs()` lazy resolution (domain getter →
  config-file fallback → unset), replacing the transform-time-only
  snapshot in the v2 tool registration; keep the v1 snapshot untouched.
- [x] 2.2 Give the vision-capability map the same deferred source, or
  document the limitation in README if the host exposes no post-merge
  list (state which happened).
- [x] 2.3 Minimal JSONC-tolerant config reader for the fallback path
  (comments/trailing commas stripped; no write path; `OPENCODE_CONFIG_DIR`
  aware).

## 3. Tests

- [x] 3.1 Ordering test: transform sees `undefined`, domain getter
  returns merged record with model → execute resolves the model (the
  live failure becomes a regression test).
- [x] 3.2 Fallback test: no domain getter, JSONC config fixture with
  comments → knobs resolve; assert no file writes.
- [x] 3.3 Contract tests stay green: error prefixes byte-identical,
  disabled suppression, malformed model id, non-image-capable model.
- [x] 3.4 `bun run typecheck` clean; `node --test tests/*.test.mjs` all
  green (V1 suite must not regress).

## 4. Verify + release

- [x] 4.1 `bun run bundle` (self-contained dist, no `--packages external`).
- [ ] 4.2 Live verify on the real 2.3.2 host: `vision_analyze` resolves
  the configured model and returns analysis for a dropped image.
- [ ] 4.3 Release per README flow (version bump → bundle → npm publish →
  store reinstall via official `opencode plugin` mode) — only after
  user approval of this proposal.
