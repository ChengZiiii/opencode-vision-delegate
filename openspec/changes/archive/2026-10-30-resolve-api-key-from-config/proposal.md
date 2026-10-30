# Proposal: resolve-api-key-from-config

## Why

`resolveVisionApiKey` accepts the merged opencode config but never reads it
(the `_config` parameter is dead). Custom providers whose API key is set
inline as `provider.<id>.options.apiKey` in opencode.json work for normal
chat (the opencode core reads options.apiKey) but `vision_analyze` fails
with `provider error: no API key for provider "..."` — a hidden breakage
that only bites the vision delegation path. The endpoint resolver already
honors config (`options.baseURL`, first priority); the key resolver must
match.

## What Changes

- `resolveVisionApiKey` (src/vision-http.ts) gains a config lookup:
  `provider.<id>.options.apiKey` (both `provider` and legacy `providers`
  sections, case-insensitive fold match, same as the endpoint resolver).
- Resolution order becomes: auth.json (type `api`) → **config
  `options.apiKey` (new)** → provider catalog env vars → keyless allowance
  → error. Inserting config after auth.json keeps every existing
  resolution result unchanged except the case that currently errors.
- Error message for the no-key case now also mentions the config option.
- No breaking changes: auth.json and env resolution keep their priorities
  and semantics; Zen keyless behavior untouched.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `vision-bridge`: Requirement VT-5 (endpoint and credentials resolve for
  the tool call) — the API key resolution order gains a config
  `options.apiKey` step between auth.json and provider env vars, plus a
  matching scenario; all existing VT-5 scenarios are carried over
  unchanged.

## Impact

- Code: `src/vision-http.ts` (`resolveVisionApiKey` only; signature keeps
  the same parameter, now actually used — rename `_config` → `config`).
- Tests: `tests/vision-http.test.mjs` — new unit cases for config-key
  resolution, precedence (auth wins over config), and combined
  config-key + config-baseURL custom provider happy path.
- Docs: README troubleshooting note for inline apiKey; AGENTS.md decision
  list item 3 (key resolution order) updated to include the config step.
- Spec: VT-5 delta in this change (MODIFIED with all existing scenarios).
