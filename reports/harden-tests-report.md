# harden-tests wave — opencode-vision-bridge

Scope: tests/ only (tests/v2-setup.test.mjs). Zero implementation changes, no bundle needed (tests only). Commit `e43c201` (`tests:`). Not pushed.

## New tests (4)

1. `v2 knobs P2: class-instance record (prototype getters) — serializes to {} but property access resolves knobs` — **P2 双面假体**: the domain getter serves a class instance whose `model`/`request` live on prototype getters (`JSON.stringify(record) === "{}"` while `record.model` reads the value). Asserts the premise AND that execute resolves model/temperature through it. Combined with the existing plain-record ordering test, the main path is pinned under both record shapes — whichever shape the 2.3.2 host serves, behavior is nailed.
2. `v2 knobs P2: a throwing prototype getter degrades to the config-file fallback, never throws` — hostile corner of the same shape: getter throws → `resolveV2Knobs` try/catch (plugin.ts:1139-1148) falls through to the config-file fallback, execute succeeds with the fallback model.
3. `v2 knobs fallback: OPENCODE_CONFIG_DIR at a nonexistent directory degrades to unset` — no error at setup or execute; exact VT-2 `model not configured` error, zero HTTP requests, no invented model.
4. `v2 knobs fallback: '//' inside string literals survives the strip (state machine does not eat URLs)` — direct assertion on exported `stripJsoncForParse` (URL with `//double` byte-identical) plus a full fixture combining a `//` URL inside a line comment, inline block comment, and trailing commas — knobs resolve through it.

## Implementation-side findings

None. All hardening candidates passed against the current implementation unchanged; nothing needed a code fix.

## Final counts

- `node --test tests/*.test.mjs` → **111 pass / 0 fail** (was 107; +4)
- `bun run typecheck` → exit 0
