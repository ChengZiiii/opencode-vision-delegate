// Pure PNG region-crop core for the vision_analyze tool's optional per-image
// `region` argument (openspec change vision-region-zoom, design D2/D4).
//
// PNG-only by design: decode via Node's builtin zlib, crop in memory,
// re-encode — zero runtime dependencies beyond node:zlib and (for
// prepareVisionImage only) one node:fs read. No @opencode-ai/* imports, no
// other side effects; imported directly by plugin.ts (bundled) and by tests
// (node --test with type stripping), same contract as src/vision-http.ts.
//
// Supported PNG subset (what screenshots are in practice): 8-bit depth,
// color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA),
// non-interlaced. tRNS is honored on every supported color type: palette
// alpha (type 3) and transparent COLOR KEYS (types 0/2) — a key match
// expands to alpha 0, everything else stays opaque. APNG animation chunks
// are ancillary and skipped: the IDAT set is the still image. Anything
// outside the subset raises VisionCropError with the limitation and the
// fix in the message; there are no silent wrong-crop paths.
//
// Error contract: every VisionCropError message is user-facing and
// self-contained (names the reason + the fix). plugin.ts wraps it as
// `vision_analyze: crop error: image "<id>" (<path>): <message>` — a
// deterministic local category: the skill neither retries nor falls back.

import { readFileSync } from "node:fs"
import { inflateSync, deflateSync } from "node:zlib"

/** Half-open pixel crop rectangle in ORIGINAL-image coordinates. */
export type Region = [number, number, number, number]

export class VisionCropError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VisionCropError"
  }
}

// Decoded-pixel guard: 40 MP caps worst-case synchronous decode work
// (design.md risk mitigation — the fetch abort signal cannot cancel
// synchronous CPU, so bound it instead).
const MAX_PIXELS = 40_000_000

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ---------------------------------------------------------------------------
// CRC32 (ISO 3309, PNG spec) — table-driven.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// PNG decode
// ---------------------------------------------------------------------------

type DecodedImage = {
  width: number
  height: number
  /** Normalized RGBA, width*height*4 bytes, row-major. */
  rgba: Uint8Array
}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function decodePng(png: Buffer): DecodedImage {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new VisionCropError(
      "region crop supports PNG images only and this file does not carry the PNG signature. " +
        "Fix: call again without `region`, or convert the image to PNG first",
    )
  }

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = -1
  let colorType = -1
  let interlace = -1
  let palette: Buffer | undefined
  let trns: Buffer | undefined
  const idatParts: Buffer[] = []
  let sawIhdr = false
  let sawIend = false

  while (pos < png.length && !sawIend) {
    if (pos + 8 > png.length) throw new VisionCropError("truncated PNG (chunk header)")
    const length = png.readUInt32BE(pos)
    const type = png.toString("ascii", pos + 4, pos + 8)
    const dataStart = pos + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > png.length) throw new VisionCropError(`truncated PNG (${type} chunk)`)
    const data = png.subarray(dataStart, dataEnd)

    // CRC: verified on IHDR (cheap, catches structural corruption early).
    // IDAT integrity is enforced by zlib's own Adler-32 inside the stream,
    // so data chunks are not CRC-checked again (linear JS CRC over a 40 MP
    // payload would dominate the tool call's CPU budget for no extra
    // detection power).
    if (type === "IHDR") {
      const crcBuf = png.subarray(pos + 4, dataEnd)
      if (crc32(crcBuf) !== png.readUInt32BE(dataEnd)) {
        throw new VisionCropError("corrupted PNG (IHDR CRC mismatch)")
      }
      if (length !== 13) throw new VisionCropError("corrupted PNG (IHDR length)")
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      // data[10] compression method and data[11] filter method: only 0 is
      // defined; anything else is undecodable.
      if (data[10] !== 0 || data[11] !== 0) {
        throw new VisionCropError("unsupported PNG compression/filter method")
      }
      interlace = data[12]
      sawIhdr = true
    } else if (type === "PLTE") {
      palette = data
    } else if (type === "tRNS") {
      trns = data
    } else if (type === "IDAT") {
      idatParts.push(data)
    } else if (type === "IEND") {
      sawIend = true
    } else if (type[0] >= "A" && type[0] <= "Z") {
      // Unknown CRITICAL chunk (uppercase first letter): the PNG spec
      // requires decoders to fail on it rather than guess.
      throw new VisionCropError(
        `unsupported critical PNG chunk ${type}. Fix: call again without \`region\`, or re-save the image as a standard PNG`,
      )
    }
    // Ancillary chunks (lowercase first letter: gAMA, iCCP, acTL, ...) are
    // skipped — they do not affect pixel decoding.
    pos = dataEnd + 4
  }

  if (!sawIhdr) throw new VisionCropError("corrupted PNG (no IHDR chunk)")
  if (idatParts.length === 0) throw new VisionCropError("corrupted PNG (no IDAT chunks)")

  if (bitDepth !== 8) {
    throw new VisionCropError(
      `unsupported PNG bit depth ${bitDepth} (only 8-bit is supported for region crop). ` +
        "Fix: call again without `region`, or re-save the image as an 8-bit PNG",
    )
  }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (channels === undefined) {
    throw new VisionCropError(
      `unsupported PNG color type ${colorType} (supported: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA). ` +
        "Fix: call again without `region`, or convert the image to RGB(A) PNG",
    )
  }
  if (colorType === 3 && (!palette || palette.length === 0 || palette.length % 3 !== 0)) {
    throw new VisionCropError("corrupted PNG (palette image without a valid PLTE chunk)")
  }
  if (interlace !== 0) {
    throw new VisionCropError(
      "interlaced PNG (Adam7) is not supported for region crop. " +
        "Fix: call again without `region`, or re-save as a non-interlaced PNG (the default of every screenshot tool)",
    )
  }
  if (width <= 0 || height <= 0) throw new VisionCropError(`corrupted PNG (dimensions ${width}x${height})`)
  if (width * height > MAX_PIXELS) {
    throw new VisionCropError(
      `image is ${width}x${height} (${((width * height) / 1e6).toFixed(1)} MP); the crop guard rejects images over ${
        MAX_PIXELS / 1e6
      } MP. Fix: crop from a smaller screenshot or downscale the source image first`,
    )
  }

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idatParts))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new VisionCropError(`corrupted PNG (IDAT): ${message}`)
  }
  const stride = width * channels
  const expected = height * (1 + stride)
  if (raw.length < expected) {
    throw new VisionCropError(`corrupted PNG (decoded ${raw.length} bytes, expected ${expected})`)
  }

  const pixels = unfilter(raw, width, height, channels)
  const rgba = toRgba(pixels, width, height, colorType, palette, trns)
  return { width, height, rgba }
}

// Reconstruct raw scanlines from filtered data (PNG spec 6.0, filters 0-4).
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp
  const out = new Uint8Array(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    if (pos >= raw.length) throw new VisionCropError("corrupted PNG (scanline truncated)")
    const filter = raw[pos++]
    const rowStart = y * stride
    for (let i = 0; i < stride; i++) {
      if (pos >= raw.length) throw new VisionCropError("corrupted PNG (scanline truncated)")
      const x = raw[pos++]
      const a = i >= bpp ? out[rowStart + i - bpp] : 0
      const b = y > 0 ? out[rowStart - stride + i] : 0
      const c = i >= bpp && y > 0 ? out[rowStart - stride + i - bpp] : 0
      let v: number
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4:
          v = x + paeth(a, b, c)
          break
        default:
          throw new VisionCropError(`corrupted PNG (row filter type ${filter})`)
      }
      out[rowStart + i] = v & 0xff
    }
  }
  return out
}

// Expand reconstructed samples to normalized RGBA.
function toRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  palette: Buffer | undefined,
  trns: Buffer | undefined,
): Uint8Array {
  const count = width * height
  const rgba = new Uint8Array(count * 4)
  // tRNS color keys (types 0/2) are 16-bit big-endian samples; with depth 8
  // only the low byte is ever nonzero, compare against that.
  const grayKey = colorType === 0 && trns && trns.length >= 2 ? trns[1] : undefined
  const keyR = colorType === 2 && trns && trns.length >= 6 ? trns[1] : undefined
  const keyG = colorType === 2 && trns && trns.length >= 6 ? trns[3] : undefined
  const keyB = colorType === 2 && trns && trns.length >= 6 ? trns[5] : undefined

  for (let i = 0; i < count; i++) {
    const o = i * 4
    const s = i * CHANNELS_BY_COLOR_TYPE[colorType]!
    switch (colorType) {
      case 0: {
        const g = pixels[s]
        rgba[o] = g
        rgba[o + 1] = g
        rgba[o + 2] = g
        rgba[o + 3] = grayKey !== undefined && g === grayKey ? 0 : 255
        break
      }
      case 2: {
        const r = pixels[s]
        const g = pixels[s + 1]
        const b = pixels[s + 2]
        rgba[o] = r
        rgba[o + 1] = g
        rgba[o + 2] = b
        rgba[o + 3] =
          keyR !== undefined && r === keyR && g === keyG && b === keyB ? 0 : 255
        break
      }
      case 3: {
        const idx = pixels[s]
        const p = idx * 3
        // Out-of-range palette index: PNG spec says the image is invalid;
        // treat as opaque black rather than reading garbage memory.
        rgba[o] = palette![p] ?? 0
        rgba[o + 1] = palette![p + 1] ?? 0
        rgba[o + 2] = palette![p + 2] ?? 0
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255
        break
      }
      case 4: {
        const g = pixels[s]
        rgba[o] = g
        rgba[o + 1] = g
        rgba[o + 2] = g
        rgba[o + 3] = pixels[s + 1]
        break
      }
      case 6: {
        rgba[o] = pixels[s]
        rgba[o + 1] = pixels[s + 1]
        rgba[o + 2] = pixels[s + 2]
        rgba[o + 3] = pixels[s + 3]
        break
      }
    }
  }
  return rgba
}

// ---------------------------------------------------------------------------
// Crop + encode
// ---------------------------------------------------------------------------

export type CropResult = {
  base64: string
  cropWidth: number
  cropHeight: number
  originX: number
  originY: number
}

/** Clamp a region to the image and crop the RGBA buffer (half-open). */
function cropRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  region: Region,
): { rgba: Uint8Array; width: number; height: number; originX: number; originY: number } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))
  const x1 = clamp(region[0], width)
  const y1 = clamp(region[1], height)
  const x2 = clamp(region[2], width)
  const y2 = clamp(region[3], height)
  if (x2 <= x1 || y2 <= y1) {
    throw new VisionCropError(
      `region is empty after clamping to the ${width}x${height} image (got x:[${x1},${x2}), y:[${y1},${y2})). ` +
        "Fix: pass a non-empty [x1, y1, x2, y2] rectangle inside the image (x2/y2 exclusive)",
    )
  }
  const w = x2 - x1
  const h = y2 - y1
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const src = ((y1 + y) * width + x1) * 4
    out.set(rgba.subarray(src, src + w * 4), y * w * 4)
  }
  return { rgba: out, width: w, height: h, originX: x1, originY: y1 }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** Encode RGBA pixels as a PNG (RGB when fully opaque, RGBA otherwise). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  let hasAlpha = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      hasAlpha = true
      break
    }
  }
  const channels = hasAlpha ? 4 : 3
  const colorType = hasAlpha ? 6 : 2
  const stride = width * channels
  const raw = Buffer.alloc(height * (1 + stride))
  let pos = 0
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0 // filter: None — deterministic and lossless-correct
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      raw[pos++] = rgba[s]
      raw[pos++] = rgba[s + 1]
      raw[pos++] = rgba[s + 2]
      if (hasAlpha) raw[pos++] = rgba[s + 3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const idat = deflateSync(raw, { level: 6 })
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * Crop a PNG buffer to `region` and return the re-encoded PNG as base64.
 * Pure: buffers in, base64 out, nothing touches the filesystem. Throws
 * VisionCropError with a self-contained message (reason + fix) on any
 * unsupported input.
 */
export function cropPngToBase64(png: Buffer, region: Region): CropResult {
  const decoded = decodePng(png)
  const cropped = cropRgba(decoded.rgba, decoded.width, decoded.height, region)
  const encoded = encodePng(cropped.width, cropped.height, cropped.rgba)
  return {
    base64: encoded.toString("base64"),
    cropWidth: cropped.width,
    cropHeight: cropped.height,
    originX: cropped.originX,
    originY: cropped.originY,
  }
}

// ---------------------------------------------------------------------------
// Tool-facing glue (the only side effect: one readFileSync per entry)
// ---------------------------------------------------------------------------

/** Validate an unknown `region` argument: undefined -> no crop, bad -> error. */
export function validateRegion(value: unknown): Region | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => !Number.isInteger(v))) {
    throw new VisionCropError(
      `region must be exactly 4 integers [x1, y1, x2, y2], got ${JSON.stringify(value)}. ` +
        "Fix: pass integer pixel coordinates (x2/y2 exclusive)",
    )
  }
  return value as Region
}

/** Coordinate-mapping disclosure appended to the request text (VT-8). */
export function regionDisclosureLine(result: CropResult, id: string): string {
  return (
    `Image "${id}" is a crop of its original image: origin (${result.originX}, ${result.originY}), ` +
    `size ${result.cropWidth}x${result.cropHeight}, covering pixels [${result.originX},${result.originY}) ` +
    `to [${result.originX + result.cropWidth},${result.originY + result.cropHeight}) in original pixel coordinates. ` +
    "For this image, report any coordinates in ORIGINAL-image pixel space: " +
    `add (${result.originX}, ${result.originY}) to positions you observe within the crop.`
  )
}

export type PreparedVisionImage = {
  id: string
  path: string
  base64: string
  /** Present only for cropped entries (always image/png, VT-8). */
  mime?: string
  /** Present only for cropped entries. */
  disclosure?: string
}

/**
 * Read one images[] entry: no region -> passthrough base64 (extension mime
 * inference downstream, pre-change behavior); region -> PNG-signature
 * check, in-memory crop, image/png payload plus the disclosure line.
 * VisionCropError messages name the image id and path.
 */
export function prepareVisionImage(entry: {
  id: string
  path: string
  region?: unknown
}): PreparedVisionImage {
  const region = validateRegion(entry.region)
  if (!region) {
    return { id: entry.id, path: entry.path, base64: readFileSync(entry.path).toString("base64") }
  }
  let png: Buffer
  try {
    png = readFileSync(entry.path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new VisionCropError(`image "${entry.id}" (${entry.path}): cannot read file: ${message}`)
  }
  try {
    const result = cropPngToBase64(png, region)
    return {
      id: entry.id,
      path: entry.path,
      base64: result.base64,
      mime: "image/png",
      disclosure: regionDisclosureLine(result, entry.id),
    }
  } catch (error) {
    if (error instanceof VisionCropError) {
      throw new VisionCropError(`image "${entry.id}" (${entry.path}): ${error.message}`)
    }
    throw error
  }
}
