// Tests for src/vision-crop.ts (pure PNG region-crop core, openspec change
// vision-region-zoom). Run with: node --test tests/vision-crop.test.mjs
// (node type stripping, same contract as vision-http.test.mjs).
//
// Anti-circularity (review finding 6): the scanline filter-reconstruction
// cases below use HAND-COMPUTED arithmetic on hand-built filtered byte
// streams (fixtures assembled chunk-by-chunk with a test-local CRC), not
// outputs of the module's own encoder. Pixel assertions on module-produced
// PNGs use an independent filter-0 inflate reader (see readPixels below).
import { test } from "node:test"
import assert from "node:assert/strict"
import { deflateSync, inflateSync } from "node:zlib"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  VisionCropError,
  cropPngToBase64,
  encodePng,
  prepareVisionImage,
  regionDisclosureLine,
  validateRegion,
} from "../src/vision-crop.ts"

// ---------------------------------------------------------------------------
// Test-local PNG assembler (independent CRC; hand-built fixtures)
// ---------------------------------------------------------------------------

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data, { corruptCrc = false } = {}) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(corruptCrc ? 0xdeadbeef : crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function ihdr(width, height, { depth = 8, colorType = 2, interlace = 0 } = {}) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(width, 0)
  b.writeUInt32BE(height, 4)
  b[8] = depth
  b[9] = colorType
  b[12] = interlace
  return b
}

/** Assemble a PNG from raw (already filtered) scanline bytes. */
function assemble({ width, height, colorType = 0, scanlines, extraChunks = [], ihdrOpts = {} }) {
  const idat = deflateSync(Buffer.from(scanlines))
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr(width, height, { colorType, ...ihdrOpts })),
    ...extraChunks,
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Full-image pass through the module's decode+re-encode (identity crop). */
function decodeFull(png) {
  return cropPngToBase64(png, [0, 0, png.readUInt32BE(16), png.readUInt32BE(20)]).base64
}

/**
 * INDEPENDENT pixel reader for module-produced PNGs: encodePng always emits
 * filter-0 rows, so raw scanlines can be inflated and read directly with
 * zero reliance on the module's decoder (no unfiltering needed). The
 * module's unfilter is validated separately by the hand-computed fixtures.
 */
function readPixels(base64) {
  const png = Buffer.from(base64, "base64")
  const w = png.readUInt32BE(16)
  const h = png.readUInt32BE(20)
  const colorType = png[25]
  const channels = colorType === 6 ? 4 : 3
  const idat = []
  let pos = 8
  while (pos < png.length) {
    const len = png.readUInt32BE(pos)
    const type = png.toString("ascii", pos + 4, pos + 8)
    if (type === "IDAT") idat.push(png.subarray(pos + 8, pos + 8 + len))
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = y * (1 + w * channels) + 1 + x * channels
      const o = (y * w + x) * 4
      rgba[o] = raw[s]
      rgba[o + 1] = raw[s + 1]
      rgba[o + 2] = raw[s + 2]
      rgba[o + 3] = channels === 4 ? raw[s + 3] : 255
    }
  }
  return { png, width: w, height: h, rgba }
}

// ---------------------------------------------------------------------------
// Task 1.1: variant gate
// ---------------------------------------------------------------------------

test("rejects 16-bit PNG with a variant-naming error", () => {
  const png = assemble({
    width: 1,
    height: 1,
    scanlines: [0, 0xff, 0xff, 0xff],
    ihdrOpts: { depth: 16 },
  })
  assert.throws(() => cropPngToBase64(png, [0, 0, 1, 1]), /bit depth 16/)
})

test("rejects interlaced PNG (Adam7)", () => {
  const png = assemble({
    width: 1,
    height: 1,
    scanlines: [0, 0xff, 0xff, 0xff],
    ihdrOpts: { interlace: 1 },
  })
  assert.throws(() => cropPngToBase64(png, [0, 0, 1, 1]), /interlaced/)
})

test("rejects non-PNG bytes (JPEG signature) with the PNG-only fix", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
  assert.throws(() => cropPngToBase64(jpeg, [0, 0, 1, 1]), /PNG only|PNG signature/)
})

test("rejects corrupted IHDR (CRC mismatch)", () => {
  const bad = Buffer.concat([
    SIG,
    chunk("IHDR", ihdr(1, 1), { corruptCrc: true }),
    chunk("IDAT", deflateSync(Buffer.from([0, 0xff, 0xff, 0xff]))),
    chunk("IEND", Buffer.alloc(0)),
  ])
  assert.throws(() => cropPngToBase64(bad, [0, 0, 1, 1]), /IHDR CRC/)
})

test("rejects unknown critical chunks", () => {
  const png = Buffer.concat([
    SIG,
    chunk("IHDR", ihdr(1, 1, { colorType: 0 })),
    chunk("ABCD", Buffer.from([1])),
    chunk("IDAT", deflateSync(Buffer.from([0, 0x10]))),
    chunk("IEND", Buffer.alloc(0)),
  ])
  assert.throws(() => cropPngToBase64(png, [0, 0, 1, 1]), /critical PNG chunk ABCD/)
})

test("pixel guard rejects >40 MP images", () => {
  const png = assemble({ width: 7000, height: 6000, scanlines: [] })
  // scanlines: [] deflates to an empty payload -- the guard fires before inflate
  assert.throws(() => cropPngToBase64(png, [0, 0, 1, 1]), /40 MP|guard/)
})

// ---------------------------------------------------------------------------
// Task 1.2: filter reconstruction on HAND-COMPUTED fixtures (grayscale,
// bpp=1). Expected values derived by hand from the PNG spec formulas.
// ---------------------------------------------------------------------------

test("filter 0 (None) reconstructs literally", () => {
  // 2x1 gray, one scanline [None, 5, 200] -> pixels 5, 200
  const png = assemble({ width: 2, height: 1, scanlines: [0, 5, 200] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba), [5, 5, 5, 255, 200, 200, 200, 255])
})

test("filter 1 (Sub): raw[i] = filt[i] + raw[i-bpp]", () => {
  // 2x1 gray, [Sub, 5, 3] -> raw0 = 5, raw1 = 3 + 5 = 8
  const png = assemble({ width: 2, height: 1, scanlines: [1, 5, 3] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba), [5, 5, 5, 255, 8, 8, 8, 255])
})

test("filter 2 (Up): raw[i] = filt[i] + priorRow[i]", () => {
  // 2x2 gray, rows [Up, 7, 9] and [Up, 1, 1]
  // row0: 7, 9 (no prior row). row1: 1+7=8, 1+9=10
  const png = assemble({ width: 2, height: 2, scanlines: [2, 7, 9, 2, 1, 1] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba.slice(0, 4)), [7, 7, 7, 255])
  assert.deepEqual(Array.from(out.rgba.slice(4, 8)), [9, 9, 9, 255])
  assert.deepEqual(Array.from(out.rgba.slice(8, 12)), [8, 8, 8, 255])
  assert.deepEqual(Array.from(out.rgba.slice(12, 16)), [10, 10, 10, 255])
})

test("filter 3 (Average): raw[i] = filt[i] + floor((a+b)/2)", () => {
  // 2x2 gray, rows [Avg, 4, 6] and [Avg, 2, 2]
  // row0: i=0: a=0,b=0 -> 4. i=1: a=raw0[0]=4, b=0(no up) -> (4+0)>>1=2 -> 6+2=8
  // row1: i=0: a=0, b=4 -> 2 -> 2+2=4
  //       i=1: a=raw1[0]=4, b=row0[1]=8 -> (4+8)>>1=6 -> 2+6=8
  const png = assemble({ width: 2, height: 2, scanlines: [3, 4, 6, 3, 2, 2] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba.slice(0, 4)), [4, 4, 4, 255])
  assert.deepEqual(Array.from(out.rgba.slice(4, 8)), [8, 8, 8, 255])
  assert.deepEqual(Array.from(out.rgba.slice(8, 12)), [4, 4, 4, 255])
  assert.deepEqual(Array.from(out.rgba.slice(12, 16)), [8, 8, 8, 255])
})

test("filter 4 (Paeth): hand-computed predictor chain", () => {
  // 2x2 gray, rows [Paeth, 3, 9] and [Paeth, 1, 1]
  // row0: i=0: paeth(0,0,0)=0 -> 3. i=1: a=3, b=0, c=0 -> pred a=3 -> 9+3=12
  // row1: i=0: a=0,b=3,c=0 -> pred 3 -> 1+3=4
  //       i=1: a=4 (row1 raw0), b=12 (row0[1]), c=3 (row0[0]) -> p=13,
  //            pa=9, pb=1, pc=10 -> pred b=12 -> 1+12=13
  const png = assemble({ width: 2, height: 2, scanlines: [4, 3, 9, 4, 1, 1] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba.slice(0, 4)), [3, 3, 3, 255])
  assert.deepEqual(Array.from(out.rgba.slice(4, 8)), [12, 12, 12, 255])
  assert.deepEqual(Array.from(out.rgba.slice(8, 12)), [4, 4, 4, 255])
  assert.deepEqual(Array.from(out.rgba.slice(12, 16)), [13, 13, 13, 255])
})

test("tRNS color key (gray): matching samples become alpha 0", () => {
  // 2x1 gray, samples [100, 100], key 100 (16-bit BE -> [0x00, 0x64])
  const png = assemble({
    width: 2,
    height: 1,
    colorType: 0,
    scanlines: [0, 100, 100],
    extraChunks: [chunk("tRNS", Buffer.from([0x00, 0x64]))],
  })
  const out = readPixels(decodeFull(png))
  assert.equal(out.rgba[3], 0)
  assert.equal(out.rgba[7], 0)
})

test("tRNS color key (RGB): only exact triple matches go alpha 0", () => {
  // 2x1 RGB: (10,20,30) matches key, (10,20,31) does not
  const png = assemble({
    width: 2,
    height: 1,
    colorType: 2,
    scanlines: [0, 10, 20, 30, 10, 20, 31],
    extraChunks: [chunk("tRNS", Buffer.from([0, 10, 0, 20, 0, 30]))],
  })
  const out = readPixels(decodeFull(png))
  assert.equal(out.rgba[3], 0)
  assert.equal(out.rgba[7], 255)
})

test("palette PNG with tRNS per-index alpha", () => {
  // PLTE: red, green. indices [0, 1]; tRNS [0x80] -> idx0 alpha 128, idx1 255
  const png = assemble({
    width: 2,
    height: 1,
    colorType: 3,
    scanlines: [0, 0, 1],
    extraChunks: [
      chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])),
      chunk("tRNS", Buffer.from([0x80])),
    ],
  })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba.slice(0, 4)), [255, 0, 0, 128])
  assert.deepEqual(Array.from(out.rgba.slice(4, 8)), [0, 255, 0, 255])
})

test("gray+alpha (type 4) passthrough", () => {
  // 1x2 gray+alpha: (gray=80,a=0),(gray=90,a=200)
  const png = assemble({ width: 1, height: 2, colorType: 4, scanlines: [0, 80, 0, 0, 90, 200] })
  const out = readPixels(decodeFull(png))
  assert.deepEqual(Array.from(out.rgba.slice(0, 4)), [80, 80, 80, 0])
  assert.deepEqual(Array.from(out.rgba.slice(4, 8)), [90, 90, 90, 200])
})

// ---------------------------------------------------------------------------
// Task 1.3: crop semantics (clamping, half-open bounds, degenerate)
// ---------------------------------------------------------------------------

function patternRgba(width, height) {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      rgba[o] = (x * 7) % 256
      rgba[o + 1] = (y * 5) % 256
      rgba[o + 2] = (x + y) % 256
      rgba[o + 3] = 255
    }
  }
  return rgba
}

test("crop extracts the exact half-open region at full resolution", () => {
  const W = 40
  const H = 30
  const png = encodePng(W, H, patternRgba(W, H))
  const r = cropPngToBase64(png, [10, 5, 20, 12])
  assert.equal(r.cropWidth, 10)
  assert.equal(r.cropHeight, 7)
  assert.equal(r.originX, 10)
  assert.equal(r.originY, 5)
  const out = readPixels(r.base64)
  // IHDR width/height read manually (independent of the module's types)
  assert.equal(out.png.readUInt32BE(16), 10)
  assert.equal(out.png.readUInt32BE(20), 7)
  // corners: crop(0,0) == source(10,5); crop(9,6) == source(19,11)
  const px = (x, y) => Array.from(out.rgba.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4))
  assert.deepEqual(px(0, 0), [(10 * 7) % 256, (5 * 5) % 256, 15, 255])
  assert.deepEqual(px(9, 6), [(19 * 7) % 256, (11 * 5) % 256, 30, 255])
})

test("region is clamped to image bounds", () => {
  const png = encodePng(100, 50, patternRgba(100, 50))
  const r = cropPngToBase64(png, [90, 40, 120, 60])
  assert.equal(r.cropWidth, 10)
  assert.equal(r.cropHeight, 10)
})

test("degenerate region (empty after clamp) is rejected", () => {
  const png = encodePng(100, 50, patternRgba(100, 50))
  assert.throws(() => cropPngToBase64(png, [100, 100, 100, 100]), /empty after clamping/)
  assert.throws(() => cropPngToBase64(png, [60, 10, 40, 30]), /empty after clamping/)
})

test("large-image crop keeps region resolution (3000x2000 -> 400x200)", () => {
  const W = 3000
  const H = 2000
  // Row-flat-ish pattern keeps deflate fast
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      rgba[o] = (x + y) % 256
      rgba[o + 1] = y % 256
      rgba[o + 2] = x % 256
      rgba[o + 3] = 255
    }
  }
  const png = encodePng(W, H, rgba)
  const r = cropPngToBase64(png, [1200, 800, 1600, 1000])
  assert.equal(r.cropWidth, 400)
  assert.equal(r.cropHeight, 200)
  assert.equal(r.originX, 1200)
  assert.equal(r.originY, 800)
  const out = readPixels(r.base64)
  assert.equal(out.png.readUInt32BE(16), 400)
  assert.equal(out.png.readUInt32BE(20), 200)
  const px = (x, y) => Array.from(out.rgba.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4))
  assert.deepEqual(px(0, 0), [(1200 + 800) % 256, 800 % 256, 1200 % 256, 255])
  assert.deepEqual(px(399, 199), [(1599 + 999) % 256, 999 % 256, 1599 % 256, 255])
})

// ---------------------------------------------------------------------------
// Encoder checks
// ---------------------------------------------------------------------------

test("encodePng: opaque input encodes as RGB (color type 2), alpha input as RGBA (6)", () => {
  const opaque = encodePng(2, 1, Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]))
  assert.equal(opaque[25], 2)
  const alpha = encodePng(2, 1, Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 0]))
  assert.equal(alpha[25], 6)
})

test("encodePng roundtrip preserves pixels (RGBA with mixed alpha)", () => {
  const W = 5
  const H = 4
  const src = patternRgba(W, H)
  for (let i = 3; i < src.length; i += 16) src[i] = 128 // sprinkle alpha
  const png = encodePng(W, H, src)
  const out = readPixels(png.toString("base64"))
  assert.deepEqual(Array.from(out.rgba), Array.from(src))
})

// ---------------------------------------------------------------------------
// prepareVisionImage glue (task 2.1 unit level; real temp files)
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "vision-crop-test-"))
test.after(() => rmSync(tmp, { recursive: true, force: true }))

const PNG_FIXTURE = encodePng(20, 10, patternRgba(20, 10))
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])

test("prepareVisionImage: region-free passthrough has no mime/disclosure", () => {
  const p = join(tmp, "plain.png")
  writeFileSync(p, PNG_FIXTURE)
  const prepared = prepareVisionImage({ id: "a", path: p })
  assert.equal(prepared.mime, undefined)
  assert.equal(prepared.disclosure, undefined)
  assert.equal(prepared.base64, PNG_FIXTURE.toString("base64"))
})

test("prepareVisionImage: PNG detected by signature even under a .jpg name; mime is image/png", () => {
  const p = join(tmp, "actually-png.jpg")
  writeFileSync(p, PNG_FIXTURE)
  const prepared = prepareVisionImage({ id: "shot", path: p, region: [2, 2, 8, 6] })
  assert.equal(prepared.mime, "image/png")
  assert.ok(prepared.disclosure.includes('Image "shot"'))
  assert.ok(prepared.disclosure.includes("origin (2, 2)"))
  assert.ok(Buffer.from(prepared.base64, "base64").subarray(0, 8).equals(SIG))
})

test("prepareVisionImage: non-PNG with region errors naming id, path, and fix", () => {
  const p = join(tmp, "real.jpg")
  writeFileSync(p, JPEG_BYTES)
  assert.throws(
    () => prepareVisionImage({ id: "ref", path: p, region: [0, 0, 5, 5] }),
    (err) => {
      assert.ok(err instanceof VisionCropError)
      assert.match(err.message, /image "ref"/)
      assert.match(err.message, /real\.jpg/)
      assert.match(err.message, /without `region`/)
      return true
    },
  )
})

test("prepareVisionImage: degenerate region error carries the image id", () => {
  const p = join(tmp, "degen.png")
  writeFileSync(p, PNG_FIXTURE)
  assert.throws(
    () => prepareVisionImage({ id: "d", path: p, region: [20, 10, 20, 10] }),
    /image "d".*empty after clamping/,
  )
})

test("validateRegion: absent -> undefined; malformed -> error", () => {
  assert.equal(validateRegion(undefined), undefined)
  assert.throws(() => validateRegion([1, 2, 3]), /exactly 4 integers/)
  assert.throws(() => validateRegion([1, 2, 3, 4.5]), /exactly 4 integers/)
  assert.deepEqual(validateRegion([1, 2, 3, 4]), [1, 2, 3, 4])
})

test("regionDisclosureLine carries origin, size, coverage, and mapping rule", () => {
  const line = regionDisclosureLine(
    { base64: "", cropWidth: 400, cropHeight: 200, originX: 1200, originY: 800 },
    "detail",
  )
  assert.match(line, /Image "detail"/)
  assert.match(line, /origin \(1200, 800\)/)
  assert.match(line, /400x200/)
  assert.match(line, /\[1200,800\) to \[1600,1000\)/)
  assert.match(line, /ORIGINAL-image pixel space/)
})

// ---------------------------------------------------------------------------
// Task 1.4: purity -- no @opencode-ai imports, imports only node: builtins
// ---------------------------------------------------------------------------

test("src/vision-crop.ts stays pure (node builtins only, no @opencode-ai)", () => {
  const source = readFileSync(new URL("../src/vision-crop.ts", import.meta.url), "utf8")
  const imports = [...source.matchAll(/^\s*import\s+.*?from\s+"([^"]+)"/gm)].map((m) => m[1])
  assert.ok(imports.length > 0, "import scan found the module's imports")
  assert.deepEqual(imports.filter((i) => !i.startsWith("node:")), [], "only node: imports")
})
