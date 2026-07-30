import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

const macosSource = readFileSync(
  new URL('../build/icon-macos.svg', import.meta.url),
  'utf8',
)
const linuxSource = readFileSync(
  new URL('../build/icon-linux.svg', import.meta.url),
  'utf8',
)

describe('platform application icons', () => {
  it('keeps one mark geometry with distinct platform framing', () => {
    expect(markGeometry(macosSource)).toEqual(markGeometry(linuxSource))
    expect(markGeometry(macosSource)).toHaveLength(4)

    expect(macosSource).toContain(
      '<rect x="100" y="76" width="824" height="824" rx="188"',
    )
    expect(macosSource).toContain('transparent outer framing')
    expect(linuxSource).toContain('filter id="launcher-keyline"')
    expect(linuxSource).toContain('free-standing hvir mark')
    expect(linuxSource).not.toMatch(/<rect[^>]+width="1024"[^>]+height="1024"/)
  })

  it('ships transparent, padded RGBA rasters at every Linux launcher size', () => {
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const icon = decodeRgbaPng(
        new URL(`../build/icons-linux/${size}x${size}.png`, import.meta.url),
      )
      expect(icon.width).toBe(size)
      expect(icon.height).toBe(size)
      expect(alphaAt(icon, 0, 0)).toBe(0)
      expect(alphaAt(icon, size - 1, size - 1)).toBe(0)
      expect(alphaCoverage(icon)).toBeGreaterThan(0.1)
      expect(alphaCoverage(icon)).toBeLessThan(0.6)
    }
  })

  it('ships a padded rounded macOS tile instead of an opaque square canvas', () => {
    const icon = decodeRgbaPng(new URL('../build/icon-macos.png', import.meta.url))
    expect(icon).toMatchObject({ height: 1024, width: 1024 })
    expect(alphaAt(icon, 0, 0)).toBe(0)
    expect(alphaAt(icon, 1023, 0)).toBe(0)
    expect(alphaAt(icon, 0, 1023)).toBe(0)
    expect(alphaAt(icon, 1023, 1023)).toBe(0)
    expect(alphaCoverage(icon)).toBeGreaterThan(0.5)
    expect(alphaCoverage(icon)).toBeLessThan(0.85)

    const icns = readFileSync(new URL('../build/icon-macos.icns', import.meta.url))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
  })
})

function markGeometry(source: string) {
  const paths = [...source.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1])
  const stem = source.match(
    /<rect x="800" y="780" width="124" height="202" rx="28"[^>]*>/,
  )?.[0]
  return [...paths, stem]
}

interface RgbaPng {
  readonly height: number
  readonly pixels: Buffer
  readonly width: number
}

function decodeRgbaPng(url: URL): RgbaPng {
  const png = readFileSync(url)
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`${url.pathname} is not a PNG file.`)
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const imageData: Buffer[] = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? 0
      interlace = data[12] ?? 0
    } else if (type === 'IDAT') {
      imageData.push(data)
    }
    offset += length + 12
  }
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`${url.pathname} must be a non-interlaced 8-bit RGBA PNG.`)
  }

  const encoded = inflateSync(Buffer.concat(imageData))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const encodedRow = y * (stride + 1)
    const filter = encoded[encodedRow] ?? 0
    for (let x = 0; x < stride; x += 1) {
      const value = encoded[encodedRow + x + 1] ?? 0
      const target = y * stride + x
      const left = x >= 4 ? (pixels[target - 4] ?? 0) : 0
      const up = y > 0 ? (pixels[target - stride] ?? 0) : 0
      const upLeft = x >= 4 && y > 0 ? (pixels[target - stride - 4] ?? 0) : 0
      pixels[target] = (value + filterValue(filter, left, up, upLeft)) & 0xff
    }
  }
  return { height, pixels, width }
}

function filterValue(filter: number, left: number, up: number, upLeft: number) {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return Math.floor((left + up) / 2)
    case 4:
      return paeth(left, up, upLeft)
    default:
      throw new Error(`Unsupported PNG row filter ${filter}.`)
  }
}

function paeth(left: number, up: number, upLeft: number) {
  const prediction = left + up - upLeft
  const leftDistance = Math.abs(prediction - left)
  const upDistance = Math.abs(prediction - up)
  const upLeftDistance = Math.abs(prediction - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  return upDistance <= upLeftDistance ? up : upLeft
}

function alphaAt(icon: RgbaPng, x: number, y: number) {
  return icon.pixels[(y * icon.width + x) * 4 + 3]
}

function alphaCoverage(icon: RgbaPng) {
  let visible = 0
  for (let offset = 3; offset < icon.pixels.length; offset += 4) {
    if ((icon.pixels[offset] ?? 0) > 8) visible += 1
  }
  return visible / (icon.width * icon.height)
}
