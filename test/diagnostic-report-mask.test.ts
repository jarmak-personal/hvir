import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { write: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  nativeImage: {},
}))

import {
  ElectronDiagnosticReportActions,
  maskDiagnosticBitmap,
} from '../src/main/diagnostics/electron-diagnostic-report-actions'
import { localPath } from '../src/shared'

describe('diagnostic screenshot mask', () => {
  it('masks exact scaled owned-surface rectangles and clamps outside geometry', () => {
    const source = Buffer.alloc(4 * 4 * 4, 255)
    const masked = maskDiagnosticBitmap(source, 4, 4, 2, 2, [
      { surface: 'terminal', x: 0, y: 0, width: 1, height: 1 },
      { surface: 'web-pane', x: 1, y: 1, width: 10, height: 10 },
    ])

    expect(pixel(masked, 4, 0, 0)).toEqual([32, 32, 32, 255])
    expect(pixel(masked, 4, 1, 1)).toEqual([32, 32, 32, 255])
    expect(pixel(masked, 4, 2, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(masked, 4, 3, 3)).toEqual([32, 32, 32, 255])
    expect(source.every((value) => value === 255)).toBe(true)
  })

  it('rejects inconsistent bitmap geometry', () => {
    expect(() => maskDiagnosticBitmap(Buffer.alloc(3), 1, 1, 1, 1, [])).toThrow(
      'Invalid capture geometry',
    )
  })

  it('writes the exact reviewed serialization to the explicit save path', async () => {
    const writeFile = vi.fn(() => Promise.resolve())
    const actions = new ElectronDiagnosticReportActions({ writeFile })
    const destination = localPath('/reviewed/diagnostic.json')
    const reviewed = '{"reviewed":true}\n'

    await actions.writeSave(destination, reviewed)

    expect(writeFile).toHaveBeenCalledWith(destination, reviewed)
  })
})

function pixel(bitmap: Buffer, width: number, x: number, y: number): number[] {
  const offset = (y * width + x) * 4
  return [...bitmap.subarray(offset, offset + 4)]
}
