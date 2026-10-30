## 1. Implementation

- [x] 1.1 In `src/vision-http.ts`, use the config parameter in `resolveVisionApiKey` (rename `_config` → `config`): after the auth.json lookup and before the env lookup, fold-match the provider id against `config.provider` / `config.providers` and return a trimmed non-empty `options.apiKey` with `source: "config"`; update the no-key error message to also name `provider.<id>.options.apiKey`. Verify with `bun run typecheck`.
- [x] 1.2 Add unit tests in `tests/vision-http.test.mjs`: (a) config apiKey resolves when auth.json/env are absent; (b) auth.json key wins over config apiKey; (c) provider id matched case-insensitively in config; (d) legacy `providers` section honored; (e) non-Zen provider with no key anywhere still errors. Verify with `node --test tests/*.test.mjs`.
- [x] 1.3 Rebuild dist with `bun run bundle` and verify `dist/index.js` contains the new config lookup (grep for `options?.apiKey`).

## 2. Docs

- [x] 2.1 Update AGENTS.md "关键设计决策" item 3 key resolution order to include the config `options.apiKey` step, and add a README troubleshooting line for inline apiKey. Verify by re-reading both files.
