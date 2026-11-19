## Context

The plugin already ships the officially supported dual-host shape
(`{ id: "vision", server, setup }`): V1 hosts call `server` (full hooks
feature set), V2 hosts call `setup` — which today is a defensive
forward-compat skeleton (agent + skill registration only) written when V2
had no tool/permission/session-context domains. OpenCode V2 is now stable
and the official migration guide documents every domain this port needs.
The V1 implementation and its specs (RB-*, RV-*, VT-*) are NOT modified by
this change; only the `setup` entry grows. Shared conventions for all three
plugin ports live in `../opencode-v2-migration-conventions.md`.

## Goals / Non-Goals

**Goals:**
- One code path per concern: extract the V1 execute/route logic into
  host-agnostic helpers and wire them into BOTH entries, so V2 parity is
  wiring, not a second implementation.
- Runtime-verified V2 parity on a sandboxed real V2 host binary.
- V1 behavior byte-identical (existing tests green, no spec text change).

**Non-Goals:**
- No V2 TUI plugin (the package has none).
- No `@opencode/plugin` runtime dependency (structural typing stays).
- No V1 retirement timeline — `server` stays until V1 hosts are gone.
- No new features beyond parity.

## Decisions

1. **Structural typing, no SDK import (kept from the skeleton).** The V2
   entry keeps importing nothing from `@opencode/plugin`: the loader
   accepts a plain `{ id, setup }` definition, the bundle stays
   self-contained with zero new dependencies, and shape drift degrades to
   no-ops instead of throwing. Alternative (import `Plugin.define`) was
   rejected: it couples the bundle to a second SDK major for no functional
   gain.
2. **Shared execute core.** `visionAnalyzeTool()`'s body becomes a
   host-agnostic `runVisionAnalyze(args, ctx)` helper (file reading, crop,
   endpoint/key resolution, HTTP, parsing); the V1 `tool()` wrapper and the
   V2 `editor.add()` definition both call it. Error prefixes live in one
   place.
3. **Knobs from the agent domain (runtime-verified).** V2 has no mutable
   global config object, so `model`/`disable`/`temperature`/`extraBody`
   resolve from the `vision-agent` record the agent domain serves
   (`ctx.agent` transform draft read; field names per the V2 agent record
   shape — verified in the sandbox before wiring; the spec pins behavior,
   not field names). If the domain is unavailable the knobs read as unset
   → the exact VT-2 error contract.
4. **Permission via `evaluate`, not config injection.** V2 exposes no
   global config mutation, so the VT-3 behavior moves to
   `ctx.permission.hook("evaluate")`: upgrade `ask` → `allow` for
   `vision_analyze`, never touch `deny`. Exact event field names verified
   in the sandbox; the guard chain follows the same first-hit priority
   idea as V1 (`metadata.tool` → `permission` → `id` → `type`).
5. **Context hook as the routing seam.** One
   `ctx.session.hook("context", ...)` registration edits
   `event.system` (the `[vision:native]` instruction) and
   `event.messages` (the image materialization rewrite), reusing the V1
   capability-resolution helpers verbatim. Message/part shapes on V2 are
   verified in the sandbox before the rewrite logic is wired; drift there
   degrades to pass-through (no rewrite) rather than corruption.
6. **Tool schema as JSON Schema.** The V2 editor takes a JSON Schema
   `input` object; the `tool.schema.*` chain converts to an equivalent
   literal schema (images array with id/path/region, region
   `minItems: 4, maxItems: 4, integer items`, required: images/question/
   response_template). The V2 execute return wraps the same result text in
   the host's expected structured-content shape (verified in sandbox).
7. **Sandbox protocol.** Per the shared conventions doc: download a real
   V2 binary into a temp dir (installed V1 untouched), hand-written
   sandbox config (never the installer), staged verification (load →
   registration surface → semantic seam), then the standard V1 regression
   (`node --test`, typecheck, bundle) and a V1 host sandbox load.

## Risks / Trade-offs

- [V2 event shapes differ from V1 hook shapes (messages parts, permission
  fields, agent record fields)] → every touched surface is guarded; the
  sandbox stage verifies each shape before its wiring task; drift degrades
  to no-op/pass-through, never corruption.
- [Guarded no-ops could silently skip a registration on an unexpected V2
  minor] → the sandbox smoke checklist asserts every registration surface
  explicitly (tool present, permission hook wired, system instruction
  observable); unit tests cover both the wired and the drifted shapes.
- [Two entries sharing helpers could couple V1 to V2 mistakes] → helpers
  are extracted first and the V1 suite must stay green before any V2 wiring
  lands; the V1 hooks' code paths keep their own call sites.

## Migration Plan

1. Extract shared helpers; V1 suite green (no behavior change).
2. Unit tests for the V2 registrations with mock `ctx` domains (wired +
   drifted shapes).
3. Sandbox stage: real V2 binary in temp; verify load + each registration
   surface; fix field-name realities.
4. `engines.opencode` → `^1.18.0 || ^2.0.0`; README V2 install section;
   version bump; `bun run bundle`; publish per the release train recipe;
   V1-host install regression after publish.

Rollback: the V2 entry is additive — reverting the `setup` growth restores
the previous skeleton; V1 hosts never load it.

## Open Questions

- Exact V2 field names for the permission evaluate event and the agent
  record's model knob — resolved empirically in the sandbox stage (the
  specs pin behavior, not field names).

  RESOLVED (task 3.4, observed against opencode 2.3.2 — live probe plugin +
  `@opencode/plugin`/`@opencode/schema` 2.3.2 type inspection):

  - **Permission evaluate event** is `PermissionEvaluation`:
    `{ sessionID, agent?, action: string, resources: string[], metadata?,
    source?: {type:"tool", messageID, id}, effect: "allow"|"deny"|"ask",
    message? }`. The tool identity is **`action`** (not the V1-style
    metadata/permission/id/type chain, kept as a drift fallback) and the
    decision is **`effect`**. Live capture (ask rule + write-tool call)
    recorded in the verify checklist.
  - **Agent record knobs** (Agent.Info via `ctx.agent` transform draft):
    `model` is an **object** `{ id, providerID }` (a config string
    `"providerID/modelID"` under the `agents` config map is folded by the
    host — verified via `debug agents`); `temperature` lives under
    `request.settings.temperature`; the extra-body JSON lives under
    `request.body` (config `request.body` propagates verbatim — observed);
    the config-level disable flag is `disabled` (ConfigAgent.Info) and a
    disabled agent is excluded from the domain before plugins see it.
  - Additional realities wired in the same pass: `system` entries in the
    context event are `{type:"text", text}` objects; messages are
    `{id, role, content: parts[]}` with image parts
    `{type:"media", media:{source:{type:"base64", data, mediaType}}}`;
    tool execute results keep `{content: string}` (Tool.Result.content is
    `string | Content[]`); the skill draft has `add(Skill.Info)` and NO
    `source()` method (the assumed directory-source call was a silent no-op
    on 2.3.2 — replaced by an embedded-skill `draft.add`); `ctx.options` is
    an empty object, not the user config; V2 `plugins` config is an ARRAY
    (string | ConfigPlugin.Entry), and the map shape in the sandbox template
    is rejected by normalization diagnostics — directory discovery
    (`.opencode/plugins/<name>/` with package.json `main`) is the verified
    hand-written loading path.
