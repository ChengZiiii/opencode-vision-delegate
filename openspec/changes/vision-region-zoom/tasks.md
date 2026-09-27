# Tasks: vision-region-zoom

## 1. Pure crop core (`src/vision-crop.ts`)

- [x] 1.1 Implement PNG chunk reader (IHDR/PLTE/tRNS/IDAT/IEND, CRC verify)
      and the supported-variant gate (8-bit; color types 0/2/3/4/6;
      interlace 0), and verify `tests/vision-crop.test.mjs` rejects a
      16-bit and an interlaced fixture with variant-naming errors
- [x] 1.2 Implement scanline filter reconstruction (types 0–4 incl. Paeth)
      and raw pixel extraction for all five color types, and verify against
      HAND-CONSTRUCTED scanline fixtures (one per filter type 0–4, plus
      gray/RGB `tRNS` color-key expansion and palette `tRNS` alpha) — not
      only self-encoder roundtrips
- [x] 1.3 Implement `cropPngRegion(buffer, region)` with clamping,
      half-open `[x1,y1)–[x2,y2)` semantics, degenerate-region rejection,
      and PNG re-encode (filter heuristic, CRC32, `zlib.deflateSync`),
      and verify: 3000x2000 fixture + `[1200,800,1600,1000]` yields a
      decodable 400x200 PNG with the exact expected pixels; out-of-bounds
      region clamps; `[100,100,100,100]` rejects
- [x] 1.4 Verify the module stays pure (no `@opencode-ai/*` imports, no fs
      writes, no side effects) via import in `node --test` and a grep check
      in the test file

## 2. Tool wiring (`plugin.ts`)

- [x] 2.1 Add optional `region` (schema-validated 4-int array, `z.number().int()`)
      to the tool's `images[]` schema and the `crop error` execution path
      (crop inside the existing read loop, AFTER endpoint/key resolution —
      precedence: disabled → model not configured → provider error →
      missing image → crop error; `vision_analyze: crop error:` prefix,
      image id + fix in the message, no HTTP request on failure), and verify
      a unit-level execute test: JPEG-with-region and
      PNG-with-degenerate-region both error with the prefix and no fetch
      stub call
- [x] 2.2 Append the coordinate-disclosure instruction to the request text
      per cropped image (origin `(x1, y1)`, original-space reporting), and
      verify `tests/vision-http.test.mjs` (or a new describe block) asserts
      the disclosure text and unchanged single-JSON response contract via a
      stubbed fetch
- [x] 2.3 Verify region-free calls are unchanged: assert the built request
      body matches a GOLDEN body recorded from the pre-change code for the
      same inputs, and assert the preserved error precedence (a call with an
      unresolvable endpoint AND a missing image file still yields
      `provider error`, not `missing image`)

## 3. Prompts and docs

- [x] 3.1 Update the `[vision:native]` system-transform text (prohibit
      delegating plain reading; permit `region` zoom assist) and verify the
      transform unit scenario output contains both halves
- [x] 3.2 Add one sentence to the `vision-agent` system prompt permitting
      in-loop `vision_analyze` (incl. `region`) before its final JSON, and
      verify the prompt constant in the built `dist/index.js` after bundle
- [x] 3.3 Update `SKILL.md`: zoom workflow (full-image → region re-call
      with margin, coordinate-asking templates), `crop error` handling
      (report + fix, no retry/fallback), `vision-agent` dual role (fallback
      conditions unchanged + advanced sweep/zoom delegation), relaxed
      "When NOT to invoke" wording per RV-2/RV-4 including the caveat that
      the zoom assist needs a file path (natively-routed dropped images are
      not materialized), and verify every error-category prefix named in
      the skill matches the tool's thrown prefixes exactly
- [x] 3.4 Update `README.md`: `region` argument + PNG-only limitation +
      in-memory crop note, zoom workflow example, agent dual-role section,
      `crop error` troubleshooting entry, the zoom-assist-needs-a-path
      caveat, and verify no uninstall/ledger text changed (no new write
      targets)

## 4. Build, test, final verification

- [x] 4.1 Run `node --test tests/*.test.mjs` (all pass), `bun run
      typecheck`, `bun run bundle`, and confirm `dist/index.js` is
      self-contained (no new requires beyond existing set)
- [x] 4.2 Sandboxed smoke test (`OPENCODE_CONFIG_DIR`/`OPENCODE_TEST_HOME`
      temp dirs): `vision_analyze` region call on a synthetic PNG against a
      stubbed provider succeeds; crop error on JPEG+region surfaces with
      the documented prefix
- [ ] 4.3 Final verification in official install mode per AGENTS.md:
      `opencode plugin github:ChengZiiii/opencode-vision-delegate --global
      --force` (or npm-name install), restart, `opencode agent list` shows
      exactly one `vision-agent`, and a live zoom round-trip
      (full-image call → region re-call) completes
