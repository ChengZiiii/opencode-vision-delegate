# Design: resolve-api-key-from-config

## Context

`resolveVisionApiKey` in `src/vision-http.ts` takes a `ConfigLike` parameter
(named `_config`, unused). The sibling endpoint resolver
(`resolveVisionEndpoint`) already reads `config.provider` /
`config.providers` with a case-insensitive `foldMatch` and returns
`source: "config"` for `options.baseURL`. The opencode core itself accepts
`provider.<id>.options.apiKey` for custom providers, so the plugin's
failure to read it diverges from core behavior on the same configuration.

## Goals / Non-Goals

- Goals: make inline `options.apiKey` work for `vision_analyze` exactly as
  it works for normal chat; keep auth.json and env resolution priorities
  unchanged; keep the module pure (no new imports, no side effects).
- Non-Goals: writing keys back to auth.json; supporting key files /
  keychains; per-model keys; changing endpoint resolution.

## Decisions

1. **Insert config lookup between auth.json and env vars.** Alternative —
   config first (mirroring baseURL being first for endpoints) — rejected:
   auth.json is the credential store of record and is what
   `opencode auth login` writes; changing its priority could silently
   switch which key is in use for existing setups. Inserting after auth
   means the only observable change is the case that previously errored.
2. **Reuse the endpoint resolver's config access pattern verbatim**: iterate
   `[config.provider, config.providers]`, `foldMatch` the provider id,
   read `options.apiKey` (string, trimmed, non-empty), return
   `{ source: "config" }`. No new helper, no schema validation beyond
   typeof checks — consistent with the file's defensive style.
3. **Update the no-key error message** to also name
   `provider.<id>.options.apiKey` so the fix is discoverable. Prefix stays
   `no API key for provider "..."` → error classification (`provider
   error`, VT-4 fallback to subagent) unchanged.
4. **Parameter rename** `_config` → `config` only; signature shape,
   argument order, and call sites unchanged.

## Risks / Trade-offs

- [Key material already sits in opencode.json; the plugin reads it in
  process only and never logs it] → no new exposure surface; README keeps
  recommending auth.json as the preferred store.
- [Users relying on the old error to detect misconfiguration] → error
  text stays in the same family, still names the provider; behavior change
  is exactly the fix requested.

## Migration Plan

Single-release patch (0.2.0 → 0.2.1). No config migration: setups using
auth.json or env vars resolve identically. Rollback = revert commit; no
persistent state written by the new code path.
