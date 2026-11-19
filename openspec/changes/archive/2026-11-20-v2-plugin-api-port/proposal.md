# v2-plugin-api-port

## Why

OpenCode V2 is stable and community adoption is accelerating (oh-my-openagent
shipped its complete, runtime-verified V2 port as the 5.x line in October).
V2 intentionally does not run V1 plugin implementations: the moment a host
runs V2, this plugin loads nothing beyond the defensive `setup` skeleton and
loses the `vision_analyze` tool, image materialization, native-vision gating,
and permission auto-allow. The official V2 plugin API now provides every
domain the V1 implementation needs (`ctx.tool.transform`, `ctx.permission`,
`ctx.session.hook("context")`), so full feature parity on V2 hosts is a
port, not a redesign — and the package can keep serving V1 hosts unchanged
from the same default export (officially supported dual-host shape).

## What Changes

- Upgrade the `setup` entry from the defensive forward-compat skeleton
  (agent + skill registration only) to full V2 feature parity:
  - register `vision_analyze` via `ctx.tool.transform` with a JSON Schema
    argument schema (same argument contract, error categories, and response
    contract as VT-1/VT-8);
  - auto-allow via `ctx.permission.hook("evaluate")` (ask → allow for
    `vision_analyze` only; explicit deny wins, per VT-3);
  - image materialization and native-vision gating via
    `ctx.session.hook("context")` editing `event.messages` / `event.system`
    (same capability-resolution chain as RV-1/RV-2);
  - resolve the tool knobs (`model`/`disable`/`temperature`/`extraBody`)
    from the user's `vision-agent` agent record via the agent domain —
    still never writing `model` or `disabled`;
  - keep the existing `ctx.agent` / `ctx.skill` registrations (create-only,
    v2 field names) unchanged.
- Keep the `server` entry (V1 hooks) fully functional and untouched: one
  package, two hosts, disjoint registration targets.
- Keep structural typing for the V2 surface (no runtime import of
  `@opencode/plugin`): domain access stays `?.` + `typeof` guarded so
  host-shape drift degrades that registration to a no-op.
- Extend the manifest `engines.opencode` range to cover V2 hosts
  (`^1.18.0 || ^2.0.0`); no new runtime dependency (the V2 entry stays
  structurally typed).
- Verify on a sandboxed real V2 host binary (downloaded to a temp dir; the
  installed V1 host is untouched) with a hand-written sandbox config — the
  `opencode plugin` installer is not used for sandbox tests (it ignores
  `OPENCODE_CONFIG_DIR`).
- Document V2 installation in the README (V2 `plugins` config shape and
  local-plugin discovery rules).

## Capabilities

### New Capabilities

<!-- none: V2 host parity lands as new requirements (VH-*) in the existing
     vision-bridge spec -->

### Modified Capabilities

- `vision-bridge`: RB-1 (manifest engines range covers V2 hosts), RB-2
  (default export's `setup` entry upgrades from defensive skeleton to full
  V2 parity while keeping the guards and disjoint-registration contract),
  plus new requirements VH-1 (V2 registration parity: tool + permission)
  and VH-2 (V2 routing and knob parity: context hook + agent-domain knobs).

## Impact

- `plugin.ts`: the `v2Setup` function grows the tool/permission/context
  registrations (shared internal helpers with the V1 implementations; the
  V1 hooks and their semantics are not modified).
- `package.json`: `engines.opencode` range only.
- `README.md` / `AGENTS.md`: V2 install + architecture notes.
- `tests/*.test.mjs`: new unit tests for the V2 registrations (mock
  `ctx` domains) and shape-drift no-ops; existing V1 tests unchanged.
- `dist/index.js`: rebuilt, still self-contained (no new imports).
- No host-side breaking change: V1 hosts keep loading `server` exactly as
  today; V2 hosts gain the full feature set.
