## 1. Shared extraction (no behavior change)

- [x] 1.1 Extract the `visionAnalyzeTool()` execute body into a host-agnostic `runVisionAnalyze(args, ctx)` helper; the V1 `tool()` wrapper calls it — verify: `node --test tests/*.test.mjs` all green, `bun run typecheck` clean, `bun run bundle` succeeds

## 2. V2 registrations (guarded, structural)

- [x] 2.1 Register `vision_analyze` via `ctx.tool.transform` with the JSON Schema input contract and the shared execute core (return wrapped in the host's structured-content shape) — verify: new unit tests cover the wired path (editor receives name/schema/execute) and the drifted path (no `ctx.tool` → no-op)
- [x] 2.2 Register the permission behavior via `ctx.permission.hook("evaluate")`: upgrade `ask` → `allow` for `vision_analyze` only; explicit `deny` untouched — verify: unit tests for allow-upgrade, deny-passthrough, missing-domain no-op
- [x] 2.3 Register `ctx.session.hook("context")` editing system + messages: `[vision:native]` instruction for vision-capable models, image materialization + marker rewrite for text-only models, reusing the RV-1/RV-2 resolution helpers; drift degrades to pass-through — verify: unit tests for both injections, marker rewrite, pass-through drift
- [x] 2.4 Resolve knobs (`model`/`disable`/`temperature`/`extraBody`) from the `vision-agent` agent record via the agent domain; unset → the exact VT-2 `model not configured` error; disabled → no tool registration — verify: unit tests for each knob path and the disabled suppression
- [x] 2.5 Keep the existing `ctx.agent` (create-only `vision-agent`) and `ctx.skill` (directory source) registrations — verify: existing setup tests stay green

## 3. Sandbox verification (real V2 binary, isolated)

- [x] 3.1 Download an opencode V2 release binary into a temp dir (installed 1.19.5 untouched); record the version — verify: `opencode --version` from the temp dir prints 2.x
- [x] 3.2 Load test with a hand-written sandbox config (`OPENCODE_CONFIG_DIR` temp, V2 `plugins` entry pointing at local dist): plugin id listed, no load errors in `--print-logs` — verify: recorded command output
- [x] 3.3 Registration surface check: `vision_analyze` present in the toolset, `vision-agent` listed, skill discoverable — verify: recorded host queries
- [x] 3.4 Field-name reality check for the permission evaluate event and the agent record knob shape; adjust the guarded readers to the observed shapes — verify: design Open Questions resolved and unit mocks updated to the observed shapes

## 4. Manifest, docs, release

- [x] 4.1 `engines.opencode` → `^1.18.0 || ^2.0.0`; README V2 install section (V2 `plugins` config shape + local discovery rules); AGENTS.md architecture row updated — verify: manifest JSON valid, docs sections present
- [x] 4.2 Version bump, `bun run bundle`, dist self-containment re-check (no new imports) — verify: `npm pack --dry-run` file list unchanged in shape
- [x] 4.3 V1 host regression: full suite + typecheck + a 1.19.5 sandbox load with a hand-written config — verify: recorded outputs
- [ ] 4.4 `openspec validate --all` green and change status complete — verify: CLI output; archive only on the user's explicit word
