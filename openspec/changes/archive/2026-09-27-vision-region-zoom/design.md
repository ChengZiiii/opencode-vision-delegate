# Design: vision-region-zoom

## Context

`vision_analyze` submits each image whole; providers downsample internally
(~1568px long edge typical), destroying small text before the vision model
sees it. Hermes solves this with a `region` crop applied before submission
(crop keeps full resolution). We port that single idea under this project's
hard constraints: zero new runtime dependencies, self-contained single-file
`dist/index.js` (RB-1), no new tools or agents, no new opencode API surface,
image bytes never through the shell, and no new out-of-package writes
(file-ledger rule). See proposal.md for motivation and scope cuts (no resize
ladder, no URL/data:URL inputs, no OS image tools, no JPEG crop).

## Goals / Non-Goals

Goals:

- Region crop that works for the dominant real-world input: screenshots,
  which are virtually always 8-bit non-interlaced PNG.
- Pure, side-effect-free, unit-testable crop core in the style of
  `src/vision-http.ts`.
- Prompt-borne coordinate disclosure so the response contract stays
  untouched.
- Skill/prompt/docs updates that teach the zoom workflow and reposition
  `vision-agent` (fallback + advanced), without touching registration.

Non-Goals:

- Any image format work beyond PNG decode/encode for crop (passthrough for
  non-region calls is unchanged for every format).
- Resizing, resampling, quality ladders, or size-error auto-retry.
- Multi-crop fan-out in one call beyond what per-image `region` already
  gives; animated PNG (APNG) beyond first-frame-at-most behavior.

## Decisions

### D1: Crop as an argument on the existing tool, not a new tool

Per user direction: one tool, one agent. `region` rides the existing
`images[]` entries (optional, per-image) — multi-image calls can mix cropped
and whole images. Rejected: a separate `vision_crop` tool (new surface,
needs a file-write target, complicates the ledger) and a per-call global
region (wrong geometry for multi-image).

### D2: PNG-only, pure JS on Node builtin `zlib`

PNG-ness is detected from signature bytes (`\x89PNG\r\n\x1a\n`), never from
the path extension; a cropped entry is always submitted as `image/png` (the
`inferImageMime` path-extension default does not apply to cropped entries).
PNG decode requires only chunk parsing + `zlib.inflateSync` + scanline
filter reconstruction (all five filter types incl. Paeth); encode requires
filter choice + `zlib.deflateSync` + CRC32 (~30 lines table code).
Transparency: palette `tRNS` (color type 3) expands to per-pixel alpha;
gray/RGB `tRNS` (color types 0/2) is a transparent COLOR KEY — pixels
matching the key expand to alpha 0, all others opaque. Rejected: `sharp`
(native binary — cannot be bundled into the single-file dist), `jimp` (pure
JS but a large dependency addition), OS tools via `child_process`
(environment fragility — exactly the "breaks when the platform shifts" class
the user ruled out). Support matrix: bit depth 8; color types 0 (gray), 2
(RGB), 3 (palette+`tRNS`), 4 (gray+alpha), 6 (RGBA); `interlace` 0 only.
Anything else with a `region` → `crop error`. This is a format constraint,
not an opencode-coupling risk: PNG and zlib are frozen standards,
independent of opencode updates.

### D3: Coordinate disclosure in the prompt, not the response

The tool appends per-cropped-image text to the request: image `<id>` is a
crop with origin `(x1, y1)`; report coordinates in ORIGINAL-image pixel
space. The model then emits original-space coordinates natively and the
orchestrator can chain the next zoom without arithmetic. Rejected: adding a
`regionContext` key or envelope to the response (breaks VT-1's "exactly one
JSON object matching the template" and the skill's template-match retry
logic in Step 6).

### D4: In-memory crop, no disk writes

Decode → crop → re-encode → base64 all in buffers. Peak memory is bounded by
one decoded image (a 4K RGBA frame ≈ 33 MB) — acceptable for a tool call.
This keeps the file ledger unchanged (no new write targets, README uninstall
section stays valid) and avoids temp-file cleanup paths entirely.

### D5: `crop error` as a deterministic local category

New prefix `vision_analyze: crop error:` handled like `missing image`:
report + fix, no retry, no subagent fallback (a subagent would hit the same
bytes). The crop runs INSIDE the existing image-read loop — the current
error precedence is preserved exactly (disabled → `model not configured` →
`provider error` from endpoint/key resolution → per-image `missing image` →
per-image `crop error`), so double-fault behavior for region-free calls is
unchanged. No HTTP request is made when a crop error fires (the request is
only built and posted after every image has been read and cropped).

### D6: Zoom workflow lives in SKILL.md + tool description; agent gets a
prompt line, not new permissions

`vision-agent` can already call `vision_analyze` in its loop (the tool is
registered in subagent sessions and auto-allowed by VT-3's hook). The change
is guidance: SKILL.md teaches full-image-then-region re-call (margin
suggested: ±40px, clamped), and the agent system prompt gains one sentence
permitting in-loop `vision_analyze` (including `region`) before its final
JSON. Rejected: adding crop/shell tools or loosening the agent's permission
map (edit stays deny; no bash).

### D7: `[vision:native]` relaxation is wording-only

The system-transform instruction and SKILL.md "When NOT to invoke" change
from "never touch vision_analyze" to "never delegate plain reading;
`region`-zoom assist allowed". No routing logic changes — the messages
transform (RV-1) is untouched; a multimodal model calling
`vision_analyze({region})` works through the same tool path as anyone else.
One documented caveat: natively-routed dropped images are NOT materialized
to disk (RV-1), so the zoom assist requires a file path — it applies to
tool-output screenshots and user-provided paths; SKILL.md and README state
this so multimodal models don't hunt for nonexistent paths.

## Risks / Trade-offs

- [PNG variants outside the matrix (16-bit, interlaced, APNG) fail with
  `crop error`] → Mitigation: error names the limitation and both fixes
  (re-call without `region` / convert to PNG); screenshots in practice are
  8-bit non-interlaced. No silent wrong-crop paths.
- [Crop of a huge PNG costs CPU time in the tool call] → Mitigation: the
  work is bounded linear decode/encode of one image, synchronous on the
  tool's execution (the fetch abort signal cannot cancel it); a
  decoded-pixel guard (reject images over ~40 megapixels with a
  `crop error`) caps the worst case, which is a few seconds on a
  screenshot-sized frame.
- [Palette/gray PNGs re-encode as RGBA, inflating payload bytes] →
  Trade-off accepted: correctness over byte golf; cropped regions are small.
  Encoder may down-encode to RGB when alpha is uniformly opaque (cheap
  post-check).
- [Model ignores the disclosure instruction and reports crop-local
  coordinates] → Mitigation: disclosure is per-image and explicit; the skill
  tells the orchestrator which images were sent with regions (it built the
  call), so it can add the origin itself when a reply is self-inconsistent.
  No contract enforcement attempted (would violate D3).
- [Multimodal zoom assist could confuse models into delegating all
  reading] → Mitigation: `[vision:native]` wording keeps the prohibition
  first and the exception narrow ("small text / fine detail natively
  unresolvable"); SKILL.md mirrors it.

## Migration Plan

Additive only: new optional argument, new error category, prompt/doc
wording. No config migration; `disable` semantics, model knob, and all
existing error prefixes unchanged. Rollback = revert the commit and rebuild
`dist/index.js`. Deploy: normal release path — `bun run bundle`, commit
dist, `npm publish` / git tag; per AGENTS.md the final verification must run
the official install mode (`opencode plugin github:ChengZiiii/opencode-vision-delegate
--global --force` or the npm name) and the smoke checks.

## Open Questions

None blocking. (Encoder filter heuristic — None/Sub/Up/Paeth try-pick vs
fixed Paeth — is an implementation detail of D2, decided during coding by
the unit tests' byte-size assertions.)
