---
name: vision
description: >-
  You **MUST** use the vision skill when your model is text-only (e.g.
  glm-5.2, deepseek-v4-pro) AND:
  (1) the user's message contains images;
  (2) OR the user's message contains URLs or paths to images;
  (3) OR the user asks to visually verify/check something ("visually verify",
  "screenshot shows", "centered/visible/hidden", "looks right",
  "matches the design");
  (4) OR a tool result contains an image attachment the current model
  cannot see (attachments[].mime = "image/png",
  url = "data:image/png;base64,...");
  (5) OR you think it is necessary to READ any visual contents;
  Triggers on screenshots from chrome-devtools_take_screenshot,
  playwright_browser_take_screenshot,
  cua-driver_get_window_state/zoom/take_screenshot and cannot see images
  itself. Extracts the visual intent from context, designs a prompt-local JSON
  response template for that specific task, delegates, and parses the
  returned JSON.
---

# Vision

Delegates visual tasks to subagents with a vision-capable model.

## When NOT to invoke this skill

You **MUST NOT** delegate to a vision subagent if the model is vision-capable. A multimodal (vision-capable) model receives image parts natively in this session: the plugin's messages transform leaves image `FilePart`s untouched on the native path, so you inspect images directly from the message rather than via a path. There is no `[vision:dropped-image]` marker for a multimodal model, and you **MUST NOT** spawn a `vision-*` subagent for it. The system prompt makes this explicit with a `[vision:native]` line; follow it.

One narrow exception for multimodal models: when small text or fine detail is beyond native resolution, you MAY call `vision_analyze` WITH a `region` argument to zoom into that area of an image FILE on disk. The zoom assist needs a file path — user-dropped images were attached natively and were NOT materialized to disk, so the assist applies to tool-output screenshots and user-provided paths only.

## Step 1. Detect

Visual intent arrives from four sources. Recognize all four.

**Source A - explicit visual language in a user prompt:**

Trigger lexicon:

<EXPLICIT_VISUAL_LANGUAGE_EXAMPLES>

- "visually verify", "visually check", "screenshot shows"
- "looks right", "looks wrong", "looks broken"
- "centered", "aligned", "overlapping", "misaligned"
- "visible", "hidden", "not showing"
- "readable", "legible", "too small", "low contrast"
- "on" / "off" / "checked" / "disabled" for a visual control state
- "matches the design", "matches the mockup"
- acceptance criteria mentioning on-screen visual state
- a user-provided image path, e.g. `/tmp/foo.png`

</EXPLICIT_VISUAL_LANGUAGE_EXAMPLES>

If the user's request contains image attachment references or a screenshot path, that is also a trigger.

**Source B - a gap between text output and a visual criterion:**

A browser or computer-use tool may return a screenshot path plus a text description of the screen. If the user's criterion is positional, color, readability, layout, or visual comparison, the text description cannot fully prove it. Extract the visual intent from the user criterion plus the tool output and delegate.

Example: the user says "check the dashboard looks right." A browser subagent returns `/tmp/dashboard.png` and "sidebar, chart, welcome header." The text describes structure, but "looks right" is a visual layout question, so delegate with a response template tailored to layout problems and evidence.

**Source C - image attachment in a tool result:**

When a tool result contains an `attachments[]` entry with `mime` starting `image/`, that image may be useful. Auto-invoke only when the user's current task has a visual component. If the task has no visual component, do nothing; note the image is available if needed later.

<TOOL_RESULTS_IMAGE_ATTACHMENT_EXAMPLES>

| Tool | Signal in result | File path available? |
| ---- | ---------------- | -------------------- |
| `chrome-devtools_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filePath` was passed |
| `playwright_browser_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filename` was passed |
| `cua-driver_get_window_state` | `screenshot` base64 plus `screenshot_file_path` if requested | Yes, if `screenshot_out_file` was passed |
| `cua-driver_zoom` | Cropped JPEG returned inline | No - save to disk first |
| `cua-driver_take_screenshot` | `attachments[].mime = image/png` | Yes, if `filePath` was passed |

</TOOL_RESULTS_IMAGE_ATTACHMENT_EXAMPLES>

**Source D - image attached to a user message:**

When the user drops an image into the chat, the vision plugin's `experimental.chat.messages.transform` hook routes per handling model. If the message's model is vision-capable (multimodal), the image `FilePart` passes through untouched — the model sees the image natively and no marker is produced, so the rest of this source does not apply. If the message's model is text-only, the hook materializes the image as a file in the operating system's temporary directory and surfaces the path to the orchestrator. The `[vision:dropped-image]` marker below therefore only appears for text-only models. For every user-message `FilePart` with `type: "file"` and `mime: "image/*"` on the text-only path, the hook:

1. Saves the bytes under the plugin's `opencode-vision-delegate` temporary subdirectory via `writeFileSync` (data URLs) or `copyFileSync` (file paths). Image bytes never touch the shell.
2. Replaces the `FilePart` with text like:

   ```text
   [vision:dropped-image] {"mime":"image/png","path":"<system-temp>/opencode-vision-delegate/vision-...png","originalFilename":"screenshot.png"}
   ```

When you see `[vision:dropped-image]`, parse the following JSON object and use `path` in the `Images to Inspect` section.
When you see `[vision:dropped-image-error]`, report that the plugin could not save the image and include the error; do not delegate that image.
If the user gave no visual criterion beyond the image itself, ask for a concise description of the visible screen or object using a response template that includes `summary`, `notableItems`, `uncertainItems`, and `evidence`.

## Step 2. Extract visual intent

Convert the current user request and image context into a direct visual
task. Do not classify into a closed taxonomy. Capture:

- The exact visual question to answer.
- Which image IDs are needed and why.
- Whether the answer is a pass/fail check, a description, a comparison, a list of findings, a measurement, or a state read.
- What evidence the orchestrator needs to cite back to the user.
- What uncertainty or failure path is appropriate.

Before delegating, check whether the text tree already answers the question.
Browser and desktop MCPs often return an accessibility/AX tree alongside the screenshot.
Use that cheap text source first.

<VISUAL_INTENT_EXTRACTION_EXAMPLE>

| Criterion | Source | Delegate to vision? |
| --------- | ------ | ------------------- |
| "Button exists" | a11y tree element present | No |
| "Button is enabled/disabled" | a11y tree state | No |
| "Button text says Submit" | a11y tree title/value | No |
| "Button is centered" | Screenshot position | Yes |
| "Text is readable" | Screenshot contrast/size | Yes |
| "Toggle is blue" | Screenshot color | Yes |
| "Layout matches design" | Screenshot structure | Yes |
| "Two screenshots are visually different" | Screenshot pair | Yes |

</VISUAL_INTENT_EXTRACTION_EXAMPLE>

## Step 3. Gather image paths

Image paths come from:

<IMAGE_PATHS_SOURCES>

| Source | How to get the path |
| ------ | ------------------- |
| User-provided | Use the path the user gave, e.g. `/tmp/foo.png`. |
| User-dropped image | Parse the `[vision:dropped-image]` JSON and use its `path`. |
| chrome-devtools MCP | Use `chrome-devtools_take_screenshot({ filePath: "/tmp/shot.png" })`. |
| Playwright MCP | Use `playwright_browser_take_screenshot({ filename: "shot.png" })`. |
| cua-driver MCP | Use `cua-driver_get_window_state({ pid, window_id, screenshot_out_file: "/tmp/win.png" })`. |
| Browser-use subagent output | Extract the returned screenshot path from the subagent text. |

</IMAGE_PATHS_SOURCES>

You **MUST** assign each image a short contract ID such as `current`, `before`, `after`, `reference`, or `detail`. Use these IDs in the prompt and in the response template.

**Inline-only Image Attachments:**

Some tool results return `attachments[].url = "data:image/...;base64,"` but no file path.
The vision subagent needs a file path to read.
Save inline images to disk first.

Prefer avoiding inline images altogether: when calling screenshot tools, pass the file-path option where available.

If you must handle an inline-only image, write the base64 payload to a file using Node via stdin or a temporary script.
Do not embed the raw base64 payload in a shell command; screenshots may contain sensitive content that should not appear in shell history, transcripts, or logs.

## Step 4. Vision model is user-configured

The vision model for BOTH delegation paths (the `vision_analyze` tool and the `vision-agent` subagent fallback) is configured by the **user** through the opencode agent model override on `vision-agent` (e.g. `agent["vision-agent"].model = "minimax-cn-coding-plan/MiniMax-M3"` in opencode.json). It is a single knob: the tool's model source is exactly this override.

Before delegating, check whether a model override is set on `vision-agent`. If the override is unset, ask the user to configure one — do not invent or hardcode a model, and do not pick a default.

The plugin registers `vision-agent` without a model; opencode falls back to the default model when none is set.

**Routing note (tool-first):** delegate by calling the `vision_analyze` tool first (Step 5, path 1). Fall back to spawning the `vision-agent` subagent (Step 5, path 2) ONLY when the tool is not present in the current session's toolset, or the tool call fails with a provider, protocol, or HTTP error. A "model not configured" error from the tool must NOT trigger the fallback — surface it and direct the user to set `agent["vision-agent"].model`. A `crop error` must NOT trigger retry or fallback either — it is a deterministic local failure (non-PNG image with `region`, unsupported PNG variant, or an empty region); report the error and its fix to the user (re-call without `region`, or convert the image to PNG).

## Disabling the vision subagent

To stop delegation entirely, disable `vision-agent` in opencode config: set `disable: true` on `agent["vision-agent"]`. Disabled agents do not appear in the agent list and cannot be delegated to; the `vision_analyze` tool is not registered either. The plugin never writes `disable`, so the user's setting stays effective.

## Step 5. Delegate (tool-first)

### Path 1 — Primary: call the `vision_analyze` tool

When the tool is present in the current session's toolset (text-only orchestrators see it; it exists in every session unless `vision-agent` is disabled), call `vision_analyze` directly with:

```js
vision_analyze({
  images: [{ id: "<short contract id>", path: "<local image path>", region: [x1, y1, x2, y2] /* optional, see zoom workflow */ }],
  question: "<the exact visual question>",
  response_template: "<JSON string defining the required response shape>",
  response_rules: "<optional task-specific constraints>"
})
```

You **MUST** assign each image a short contract ID such as `current`, `before`, `after`, `reference`, or `detail`, and use the same IDs in the response template.

You **MUST** develop the `response_template` and `response_rules` per the template-design principles below. The tool reads the listed image files in-process (no subagent nesting) and returns exactly one JSON object matching the template.

**Zoom workflow (optional per-image `region` crop):**

`region` is `[x1, y1, x2, y2]` — integer pixel coordinates in the ORIGINAL image, `x2`/`y2` exclusive, clamped to the image bounds. PNG only (detected by file signature, not extension; cropped entries are submitted as `image/png`). The tool crops the region IN MEMORY at full source resolution, so provider-side downsampling never applies to the crop.

When the answer may hinge on detail beyond a full-image pass (small text, tiny UI elements, dense tables):

1. Call `vision_analyze` on the full image first, with a template that asks for the coordinates of the relevant area as numbers (original-image pixel space).
2. If the judgment reports unreadable detail or an area of interest, re-call `vision_analyze` with `region` covering the reported area plus margin (e.g. ±40px; clamping is automatic).
3. The tool automatically appends a coordinate-mapping note to the request for cropped images: the vision model reports coordinates in ORIGINAL-image pixel space, so you can chain further zooms or cite locations directly without arithmetic.

### Path 2 — Fallback and advanced delegation: the `vision-agent` subagent

Fall back to spawning the single `vision-agent` subagent with the full visual task prompt ONLY when:

- the `vision_analyze` tool is not present in the current session's toolset, or
- the tool call fails with a provider, protocol, or HTTP error (e.g. `vision_analyze: provider error: ...`).

A "model not configured" error (`vision_analyze: model not configured: ...`) MUST NOT trigger the fallback — report it to the user and ask them to set `agent["vision-agent"].model`. A `crop error` MUST NOT either — report it with its fix (re-call without `region`, or convert the image to PNG).

Beyond those fallback conditions, you MAY delegate a whole investigation to `vision-agent` as the **advanced option**: multi-image sweeps or deep zoom chains that would otherwise spend many of your own tool turns. The subagent can read the image files natively and can call `vision_analyze` (including `region` crops) in its own loop before returning its single final JSON. For bounded single questions, keep the direct tool call.

The subagent type is always `"vision-agent"` — it is a constant, not a per-model name — and its model is configured by the user via the opencode agent model override (the plugin registers it without a model):

```js
task({
  subagent_type: "vision-agent",
  description: "<short visual task description>",
  prompt: `<the spawning prompt>`
})
```

You **MUST** develop the spawning prompt per the following rules.

You **MUST** use this spawning-prompt structure in the following template:

<SPAWNING_PROMPT_TEMPLATE>

````md
## Visual Task

<one or two sentences describing the exact visual question>

## Images to Inspect

- <image-id>: <local path> - <why this image is relevant>

## Response Template

Return exactly one JSON object shaped like this. Keep these keys exactly, replace placeholder values with observed values, and do not add keys:

<RESPONSE_TEMPLATE>
{
  "...": "..."
}
</RESPONSE_TEMPLATE>

## Response Rules

- The response **MUST** use only the listed images.
- The response **MUST** match the response template exactly; no markdown, prose wrapper, or extra keys.
- The response **MUST** include evidence from the images for every conclusion.
- The response **MUST** include an explicit uncertainty/failure path appropriate to this task.
- The response **MUST** use null when a requested measurement or fact cannot be determined.
````

</SPAWNING_PROMPT_TEMPLATE>

**Spawning Prompt Generation Principles:**

- Each visual task **MUST** carries its own response shape inside the spawning prompt.
- The spawning prompt shape **MUST** be just large enough to answer the current user request and should include its own uncertainty or failure fields.

**Response-template Design Principles (apply to BOTH the tool and the subagent path):**

Build the smallest JSON object that lets you answer the user.
Include the template directly in the tool call (or subagent prompt).
The vision model must replace placeholder values with observed values and must not add fields.

Good templates usually include:

- A task-specific conclusion field, e.g. `isCentered`, `layoutLooksOk`, `visible`, `matchesReference`, `changes`.
- Evidence fields that quote or describe what is visible.
- Measurements only when needed; use `null` if not determinable.
- `confidence` from `0` to `1` when the user needs a judgment.
- `uncertainty` or `limitations` when the task can fail partially.

Avoid generic catch-all fields such as `observations` unless the user asked for an open-ended list.
Avoid asking for pixel precision unless the screenshot context actually supports it — coordinates ARE supported on the zoom path: a full-image call may ask for an approximate bounding box to drive a `region` re-call, and cropped calls receive the coordinate-mapping note so their coordinates come back in original-image pixel space.

**MUST:**

- You **MUST** generate the smallest JSON shape that answers the current task.
- You **MUST** prefer booleans, enums, numbers, arrays, and nullable fields over vague prose when you may branch on the result.
- You **MUST** always include enough visual evidence for the orchestrator to cite back to the user.
- You **MUST** include uncertainty in the template, not as an afterthought.
- You **MUST** use arrays with one representative item shape for repeated findings.
- You **MUST** require per-image references and structured changes for comparisons.

**MUST NOT:**

- You **MUST NOT** directly reuse a generic fixed envelope shown in the **SPAWNING PROMPT TEMPLATE**.

## Step 6. Parse

The subagent **MUST** return one JSON object and nothing else.
You **MUST** parse it and compare the returned keys to the response template you authored.

- You **MUST** retry once with the same subagent and include the invalid output plus the template if the JSON is malformed or contains extra/missing keys.
- You **MUST** report that honestly and do not invent a stronger conclusion if the response uses uncertainty or failure fields.
- You **MUST** cite the evidence fields when reporting back to the user.
- You **MUST** include confidence only if your template requested it.
