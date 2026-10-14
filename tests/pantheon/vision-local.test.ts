import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import {
  buildLocalVisionBlock,
  detectImageFormat,
  extractImageInfo,
  formatLocalImageBlock,
  tesseractAvailable,
} from '../../src/pantheon/vision-local.ts'

// ─── Synthetic fixtures (bytes built in-test, no binary assets) ────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) crc = ((CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

function buildPng(options: {
  width: number
  height: number
  colorType: 2 | 6
  interlace?: 0 | 1
  pixels: number[][]
}): Buffer {
  const { width, height, colorType, interlace = 0, pixels } = options
  const channels = colorType === 6 ? 4 : 3
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  ihdr[12] = interlace
  const raw = Buffer.alloc(height * (1 + width * channels))
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    raw[pos] = 0 // filter: None
    pos += 1
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x] ?? []
      for (let c = 0; c < channels; c += 1) {
        raw[pos] = pixel[c] ?? 0
        pos += 1
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function buildJpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  buf[0] = 0xff
  buf[1] = 0xd8 // SOI
  buf[2] = 0xff
  buf[3] = 0xc0 // SOF0
  buf.writeUInt16BE(17, 4) // segment length
  buf[6] = 8 // precision
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  buf[11] = 3 // components
  return buf
}

/** Minimal GIF header: signature + LE width/height at offsets 6/8. */
function buildGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

/** Minimal WebP VP8X header (30 bytes): canvas size minus one at offsets 24/27. */
function buildWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4) // RIFF chunk size (unused by the parser)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16) // VP8X chunk size
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return buf
}

const dataUri = (mime: string, bytes: Buffer): string =>
  `data:${mime};base64,${bytes.toString('base64')}`

// ─── Tests ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Format detection from signatures.
  const png2x2 = buildPng({
    width: 2,
    height: 2,
    colorType: 2,
    pixels: [
      [255, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ],
  })
  assert.equal(detectImageFormat(png2x2), 'png')
  assert.equal(detectImageFormat(buildJpeg(3, 2)), 'jpeg')
  assert.equal(detectImageFormat(Buffer.from('GIF89a....')), 'gif')
  assert.equal(
    detectImageFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    'webp',
  )
  assert.equal(detectImageFormat(Buffer.from('not an image at all')), 'unknown')

  // PNG RGB: dimensions + quantized dominant colors.
  const rgb = await extractImageInfo(dataUri('image/png', png2x2), { ocr: null })
  assert.ok(rgb)
  assert.equal(rgb.format, 'png')
  assert.equal(rgb.mime, 'image/png')
  assert.equal(rgb.width, 2)
  assert.equal(rgb.height, 2)
  assert.equal(rgb.bytes, png2x2.length)
  assert.equal(rgb.ocrText, null)
  assert.equal(rgb.colors?.length, 3)
  assert.equal(rgb.colors?.[0]?.hex, '#ff0000')
  assert.equal(rgb.colors?.[0]?.ratio, 0.5)
  assert.deepEqual(rgb.colors?.map((color) => color.hex).sort(), ['#0000ff', '#00ff00', '#ff0000'])

  // PNG RGBA: fully transparent pixels are ignored.
  const rgba = buildPng({
    width: 2,
    height: 1,
    colorType: 6,
    pixels: [
      [10, 20, 30, 255],
      [0, 0, 0, 0],
    ],
  })
  const rgbaInfo = await extractImageInfo(dataUri('image/png', rgba), { ocr: null })
  assert.equal(rgbaInfo?.colors?.length, 1)
  assert.equal(rgbaInfo?.colors?.[0]?.hex, '#001111')
  assert.equal(rgbaInfo?.colors?.[0]?.ratio, 1)

  // PNG interlaced: dimensions still parsed, colors degrade to null, no throw.
  const interlaced = buildPng({
    width: 2,
    height: 2,
    colorType: 2,
    interlace: 1,
    pixels: [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10, 11, 12],
    ],
  })
  const interlacedInfo = await extractImageInfo(dataUri('image/png', interlaced), { ocr: null })
  assert.equal(interlacedInfo?.width, 2)
  assert.equal(interlacedInfo?.height, 2)
  assert.equal(interlacedInfo?.colors, null)

  // JPEG: dimensions via SOF markers; colors are out of scope (null).
  const jpeg = buildJpeg(3, 2)
  const jpegInfo = await extractImageInfo(dataUri('image/jpeg', jpeg), { ocr: null })
  assert.equal(jpegInfo?.format, 'jpeg')
  assert.equal(jpegInfo?.width, 3)
  assert.equal(jpegInfo?.height, 2)
  assert.equal(jpegInfo?.colors, null)

  // JPEG malformed/truncated → null dimensions, never a throw.
  const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00])
  const truncatedInfo = await extractImageInfo(dataUri('image/jpeg', truncated), { ocr: null })
  assert.equal(truncatedInfo?.format, 'jpeg')
  assert.equal(truncatedInfo?.width, null)
  assert.equal(truncatedInfo?.height, null)

  // GIF: dimensions from the LE uint16 fields at offsets 6/8.
  const gif = buildGif(320, 200)
  const gifInfo = await extractImageInfo(dataUri('image/gif', gif), { ocr: null })
  assert.equal(gifInfo?.format, 'gif')
  assert.equal(gifInfo?.mime, 'image/gif')
  assert.equal(gifInfo?.width, 320)
  assert.equal(gifInfo?.height, 200)
  assert.equal(gifInfo?.colors, null)

  // WebP (VP8X): canvas size is stored minus one at offsets 24/27.
  const webp = buildWebpVp8x(640, 480)
  const webpInfo = await extractImageInfo(dataUri('image/webp', webp), { ocr: null })
  assert.equal(webpInfo?.format, 'webp')
  assert.equal(webpInfo?.mime, 'image/webp')
  assert.equal(webpInfo?.width, 640)
  assert.equal(webpInfo?.height, 480)
  assert.equal(webpInfo?.colors, null)

  // A truncated GIF (< 10 bytes) yields no dimensions, never a throw.
  const shortGif = await extractImageInfo(dataUri('image/gif', Buffer.from('GIF89a')), {
    ocr: null,
  })
  assert.equal(shortGif?.format, 'gif')
  assert.equal(shortGif?.width, null)
  assert.equal(shortGif?.height, null)

  // Garbage bytes degrade gracefully to an unknown format with a size only.
  const garbage = Buffer.from('this is definitely not an image')
  const garbageInfo = await extractImageInfo(dataUri('application/octet-stream', garbage), {
    ocr: null,
  })
  assert.equal(garbageInfo?.format, 'unknown')
  assert.equal(garbageInfo?.bytes, garbage.length)
  assert.equal(garbageInfo?.width, null)

  // Remote URLs expose only the declared metadata (offline, deterministic).
  const remote = await extractImageInfo('https://example.test/photo.jpg?size=large', { ocr: null })
  assert.equal(remote?.format, 'jpeg')
  assert.equal(remote?.mime, 'image/jpeg')
  assert.equal(remote?.bytes, null)
  assert.equal(remote?.colors, null)

  // OCR is disabled by `ocr: null`, supplied text is surfaced when a runner exists.
  const noOcr = await extractImageInfo(dataUri('image/png', png2x2), { ocr: null })
  assert.equal(noOcr?.ocrText, null)
  const withOcr = await extractImageInfo(dataUri('image/png', png2x2), {
    ocr: async () => '  hello world\n',
  })
  assert.equal(withOcr?.ocrText, 'hello world')
  // A throwing runner degrades to null instead of propagating.
  const throwingOcr = await extractImageInfo(dataUri('image/png', png2x2), {
    ocr: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(throwingOcr?.ocrText, null)

  // Block formatting carries the metadata, palette and OCR state.
  const block = formatLocalImageBlock(rgb)
  assert.match(block, /^Imagem local: 2x2 PNG, /)
  assert.match(block, /Cores dominantes: #ff0000 \(50%\)/)
  assert.match(block, /Texto OCR: indisponível/)
  const indexed = formatLocalImageBlock(rgb, 2)
  assert.match(indexed, /^Imagem local 2: /)

  // buildLocalVisionBlock: null for nothing, prefixed blocks for several.
  assert.equal(await buildLocalVisionBlock([], { ocr: null }), null)
  const single = await buildLocalVisionBlock([dataUri('image/png', png2x2)], { ocr: null })
  assert.match(single ?? '', /Imagem local: 2x2 PNG/)
  const multi = await buildLocalVisionBlock(
    [dataUri('image/png', png2x2), dataUri('image/jpeg', jpeg)],
    { ocr: null },
  )
  assert.match(multi ?? '', /Imagem local 1:/)
  assert.match(multi ?? '', /Imagem local 2:/)

  // The tesseract probe is total (a boolean) and never throws.
  assert.equal(typeof tesseractAvailable(), 'boolean')

  console.log('vision-local: all assertions passed')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
