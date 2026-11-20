# implement-vision-knob-timing — final report

Change: `fix-v2-knob-capture-timing` (apply phase)
Repo: `opencode-vision-bridge/`
Date: 2026-11-20

## Changed files

| File | Change |
| ---- | ------ |
| `plugin.ts` | Lazy execute-time knob resolution: module-state seams (`v2AgentDomain` / `v2CatalogRef` / `v2OptionsConfigRef` / `v2TransformKnobs`), `resolveV2Knobs()` (domain getter → transform snapshot → config-file fallback → unset), `stripJsoncForParse()` + `readOpencodeConfigFile()` (OPENCODE_CONFIG_DIR-aware, JSONC-tolerant, strictly read-only), `refreshV2AgentsMap()` lazy capability-map refresh, lazy disabled gate for the tool registration. v1 config-hook path untouched. |
| `tests/v2-setup.test.mjs` | `OPENCODE_CONFIG_DIR` isolation in before/after; 4 new tests (ordering regression, JSONC fallback + zero-write, fallback-miss byte-identical error, capability-map refresh). |
| `README.md` | v2 section: knob capture timing note + documented capability-map limitation (task 2.2). |
| `openspec/changes/fix-v2-knob-capture-timing/design.md` | "Probe resolution (task 1.1/1.2)" + "Implementation notes (apply phase)" appended. |
| `openspec/changes/fix-v2-knob-capture-timing/tasks.md` | Checked 1.1–4.1; 4.2/4.3 left open (live-host verify + release need user approval). |
| `dist/index.js` | Rebuilt via `bun run bundle` — **PENDING, see blocker**. |

## Design choices (per dispatch)

- Source order in `resolveV2Knobs()`: **domain getter** (`ctx.agent.get("vision-agent")`, merged record) → **transform-time snapshot** (valid on hosts whose drafts carry the record; keeps prior behavior) → **config-file fallback** (read-only, `OPENCODE_CONFIG_DIR` → `~/.config/opencode/opencode.json(c)`, comments + trailing commas stripped, only `agent["vision-agent"]` model/disable/disabled/temperature/extraBody read) → **unset** (byte-identical `vision_analyze: model not configured: set agent["vision-agent"].model …`).
- `model` object `{id, providerID, variant}` folds to `providerID/id` via existing `readV2AgentKnobs` (reused, plugin.ts ~L989 pre-change).
- Capability map (task 2.2): **both** — lazy `refreshV2AgentsMap()` at every session-context hook when the domain exposes `list`/`get` outside `transform`, **and** README-documented limitation for hosts without a post-merge list (request-model check is the primary v2 routing signal regardless).
- Disabled suppression: registration gate calls `resolveV2Knobs()` lazily; `runVisionAnalyze` independently guards `disabled` at execute time.

## tasks.md status

- [x] 1.1, 1.2 — resolved from the live-session binding facts (recorded in design.md)
- [x] 2.1, 2.2, 2.3
- [x] 3.1, 3.2, 3.3, 3.4
- [x] 4.1 (bundle) — typecheck + tests verified live; **bundle rebuild + commit PENDING (blocker below)**
- [ ] 4.2, 4.3 — live-host verify + release (require user approval; out of scope here)

## Verification evidence

- `bun run typecheck` → clean (exit 0).
- `node --test tests/*.test.mjs` → **107 pass / 0 fail** (includes the full V1 suite — zero regression).
- `node --test tests/v2-setup.test.mjs` → 24 pass / 0 fail, including the new tests:
  - `v2 knobs ordering: transform sees undefined, domain getter returns merged record -> execute resolves model`
  - `v2 knobs fallback: no domain getter + JSONC config fixture -> knobs resolve, zero file writes`
  - `v2 knobs fallback: no domain getter + empty config dir -> exact 'model not configured' error`
  - `v2 capability map: post-merge domain list/get refreshes agents map at context time`

## Blocker (report verbatim)

After the successful typecheck/test runs, every subsequent `forge_shell` call — including the plain `Write-Output ok` health probe — fails with:

```
Tool.Error
```

(no message content; caught error `name: "Error"`, `message: "Tool.Error"`). The builtin shell is refused by the forge partition (`[forge:partition] Builtin shell refused: the forge family executes through forge_shell …`), so per the mandate no workaround was attempted. Consequently the following steps could NOT be completed by this worker:

1. `bun run bundle` rebuild of `dist/index.js` (dist currently still reflects pre-change code).
2. Conventional commits (`plugin:`, `tests:`, `docs:`) — the working tree contains all changes above, uncommitted.
3. No `git push` (also blocked, per instruction not to push anyway).

Recovery: once forge_shell responds again, run in `opencode-vision-bridge/`:

```powershell
bun run bundle
node --test tests/*.test.mjs   # re-confirm 107 pass
git add -A
git commit -m "plugin: resolve v2 vision-agent knobs lazily at execute time (merged record first, read-only config-file fallback)"
```

(or split into `plugin:` / `tests:` / `docs:` commits — suggested split: plugin.ts+dist → `plugin:`, tests → `tests:`, README+openspec → `docs:`).
