import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Rectangle } from 'electron'
import {
  captureCapacityTerminalTag,
  type CapacityTerminalLayout,
} from '../src/main/smoke/capacity-terminal-compositor'
import {
  capacityTerminalTagCells,
  CAPACITY_TERMINAL_TAG_COLORS,
} from '../src/main/smoke/capacity-terminal-tags'

const tag = { row: 3000, sequence: 10, columns: 102, rows: 24 }
const layout: CapacityTerminalLayout = {
  engine: 'web',
  x: 241,
  y: 432.25,
  cssWidth: 816,
  cssHeight: 360,
  paneWidth: 817,
  paneHeight: 364.75,
  canvasWidth: 1632,
  canvasHeight: 720,
  scale: 2,
  columns: 102,
  rows: 24,
  cellWidth: 8,
  cellHeight: 15,
  paddingLeft: 0,
  paddingTop: 0,
  fontSize: 13,
}

describe('pinned CapturePage physical pixels in a 1x NativeImage representation', () => {
  it.each([
    [1, 1, undefined],
    [2, 1, undefined],
    [1.25, 1, undefined],
    [1.3, 1, undefined],
    [2, 1.25, undefined],
    [2, 1, 'large-viewport'],
  ] as const)(
    'decodes actual %s screen-scale and %s page-zoom pixels independently of the 1x label',
    async (density, zoom, profile) => {
      const selected = profile
      const actualTag = selected ? { ...tag, columns: 319 } : tag
      const bits = capacityTerminalTagCells(actualTag, selected)
      let rectangle: Rectangle | undefined
      const dimensions = () => {
        if (!rectangle) throw new Error('fixture-capture-not-requested')
        return {
          width: Math.ceil(rectangle.width * density),
          height: Math.ceil(rectangle.height * density),
        }
      }
      const getSize = vi.fn((scale: number) => {
        expect(scale).toBe(1)
        return dimensions()
      })
      const toBitmap = vi.fn((options: { scaleFactor: number }) => {
        expect(options.scaleFactor).toBe(1)
        const { width, height } = dimensions()
        const bytes = Buffer.alloc(width * height * 4)
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const cell = Math.floor(
              (rectangle!.x + x / density - layout.x * zoom) / (8 * zoom),
            )
            const bit = bits[Math.max(0, Math.min(bits.length - 1, cell))]!
            const [red, green, blue] = CAPACITY_TERMINAL_TAG_COLORS[bit]!
            bytes.set([blue, green, red, 255], (y * width + x) * 4)
          }
        return bytes
      })
      const capturePage = vi.fn((requested: Rectangle) => {
        rectangle = requested
        expect(rectangle.width).toBe(
          Math.ceil(
            (selected ? 280 : 216) * zoom + layout.x * zoom - Math.floor(layout.x * zoom),
          ),
        )
        return Promise.resolve({ getScaleFactors: () => [1], getSize, toBitmap })
      })
      const win = {
        webContents: { capturePage, getZoomFactor: () => zoom },
      } as unknown as BrowserWindow
      const observed = await captureCapacityTerminalTag(
        win,
        { ...layout, scale: density },
        23,
        selected,
      )
      expect(observed.tag).toEqual(actualTag)
      expect(observed.pixelProbe.colors).toHaveLength(selected ? 35 : 27)
      expect(getSize).toHaveBeenCalledWith(1)
      expect(toBitmap).toHaveBeenCalledWith({ scaleFactor: 1 })
    },
  )

  it('refuses changed representation and inconsistent byte dimensions', async () => {
    const win = {
      webContents: {
        getZoomFactor: () => 1,
        capturePage: () =>
          Promise.resolve({
            getScaleFactors: () => [2],
            getSize: () => ({ width: 368, height: 2 }),
            toBitmap: () => Buffer.alloc(1),
          }),
      },
    } as unknown as BrowserWindow
    await expect(captureCapacityTerminalTag(win, layout, 23)).rejects.toThrow(
      'capture-representation',
    )
    const malformed = {
      webContents: {
        getZoomFactor: () => 1,
        capturePage: () =>
          Promise.resolve({
            getScaleFactors: () => [1],
            getSize: () => ({ width: 368, height: 2 }),
            toBitmap: () => Buffer.alloc(1),
          }),
      },
    } as unknown as BrowserWindow
    await expect(captureCapacityTerminalTag(malformed, layout, 23)).rejects.toThrow(
      'bitmap-dimensions',
    )
  })
})
