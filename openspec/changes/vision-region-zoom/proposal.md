# Proposal: vision-region-zoom

## Why

The `vision_analyze` tool is a single-shot delegation pipe: it sends each image
at full size and the provider downsamples internally (e.g. Anthropic ~1568px
long edge), so small text or fine detail in a large screenshot is lost before
the vision model ever sees it. The `vision-agent` subagent is positioned as a
transport-failure fallback, yet it has no zoom capability either — so the three
scenarios Hermes solves in-tool (crop-read, repeated zoom, multi-step visual
investigation) are covered by neither path, and multimodal orchestrators are
banned from the plugin entirely (`[vision:native]`) leaving them with no crop
or zoom option at all. This change closes that gap with zero new tools, zero
new agents, and zero new runtime dependencies.

## What Changes

- `vision_analyze` gains an OPTIONAL per-image `region: [x1, y1, x2, y2]`
  argument (original-image pixel coordinates). When present on a PNG image,
  the tool crops the region IN MEMORY before base64 encoding, so the region
  reaches the vision model at full resolution. No temp files, no new writes.
- Crop is PNG-only, implemented as a pure function module using only Node's
  builtin `zlib` (8-bit, color types 0/2/3/4/6, non-interlaced). Any other
  format with a `region`, or an unsupported PNG variant, returns a new
  deterministic `crop error` that names the image id and the fix (re-call
  without `region`, or convert to PNG). Calls WITHOUT `region` behave exactly
  as before (non-PNG images keep passing through unchanged).
- Coordinate disclosure rides the PROMPT, not the response: when a region is
  applied, the tool appends an instruction telling the vision model to report
  coordinates in ORIGINAL-image space (by adding the region origin). The tool's
  response contract is unchanged — still exactly one JSON object matching the
  caller's `response_template`.
- SKILL.md teaches the zoom workflow: full-image judgment first, then a
  `region` re-call around reported coordinates (with margin) when the answer
  needs small text or fine detail.
- `vision-agent` keeps its fallback role (conditions unchanged) and gains a
  documented ADVANCED role: orchestrators MAY delegate multi-image sweeps or
  deep zoom chains to it; the agent's system prompt explicitly permits calling
  `vision_analyze` (including `region`) in-loop before emitting its single
  final JSON. The tool is already available in subagent sessions, so this is a
  guidance/prompt change, not a new surface.
- Multimodal relaxation (marked decision, strike if unwanted): the
  `[vision:native]` instruction and SKILL.md keep banning delegation of PLAIN
  reading, but permit `vision_analyze` WITH `region` as a zoom assist when
  native resolution cannot resolve small text or fine detail.
- Error taxonomy grows by one deterministic local category: `crop error`
  (report to user; no subagent fallback, no retry — same handling as
  `missing image`). All existing prefixes, the `agent["vision-agent"].model`
  knob, and the `disable: true` one-switch semantics are preserved.

Explicitly out of scope (rejected for dependency/update-risk reasons): new
tools or subagents, auto-resize/size ladders, OS image-tool ladders
(System.Drawing/sips/ImageMagick), JPEG/WebP crop, URL or `data:` URL image
inputs, native image embeds into orchestrator context.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `vision-bridge`: VT-1 modified (tool args gain optional per-image `region`);
  VT-8 added (region crop semantics: PNG-only in-memory crop, coordinate
  disclosure via prompt, `crop error` taxonomy); VT-4 modified (skill routing
  gains the zoom workflow, `crop error` handling, and the vision-agent
  advanced role); RV-2 modified (`[vision:native]` permits region-zoom
  assist); RV-4 modified (skill documents zoom workflow and agent dual role);
  RB-7 modified (README documents the `region` argument, zoom workflow, agent
  dual role, and `crop error` troubleshooting).

## Impact

- Code: new pure module `src/vision-crop.ts` (PNG chunk parse → inflate →
  filter decode → crop → re-encode → deflate, CRC32; no `@opencode-ai/*`
  imports, no side effects), wired into the tool's `execute` in `plugin.ts`;
  `[vision:native]` system-transform text and `vision-agent` prompt text in
  `plugin.ts`; `SKILL.md` Step 3/5 and "When NOT to invoke" wording;
  `README.md` tool-args and usage sections; `dist/index.js` rebuilt via
  `bun run bundle`.
- Tests: `tests/vision-crop.test.mjs` (roundtrip + region extraction +
  unsupported-variant rejections, synthetic PNGs generated in-test with
  `zlib`); existing `tests/vision-http.test.mjs` extended for prompt-borne
  disclosure.
- Dependencies: NONE added — Node builtin `zlib` only; bundle stays
  self-contained single-file (constraint per RB-1).
- File ledger: unchanged — crop is in-memory; the plugin still writes nothing
  outside its existing `<tmp>/opencode-vision-delegate/` materialization dir.
- opencode API surface: unchanged — only hooks already in use (`tool`,
  `config`, `permission.ask`, both chat transforms); no new host APIs, so no
  new opencode-update exposure.
