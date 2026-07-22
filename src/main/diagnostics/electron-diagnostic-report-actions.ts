import { createHash } from 'node:crypto'

import { BrowserWindow, clipboard, dialog, nativeImage } from 'electron'

import {
  MAX_DIAGNOSTIC_REPORT_SCREENSHOT_BYTES,
  localPath,
  type DiagnosticCaptureMask,
  type DiagnosticReportScreenshot,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererOwner } from '../renderer-resource-scopes'

export interface DiagnosticReportActions {
  capture(
    owner: RendererOwner,
    masks: readonly DiagnosticCaptureMask[],
  ): Promise<DiagnosticReportScreenshot>
  copy(serialized: string, screenshot?: DiagnosticReportScreenshot): void
  selectSave(owner: RendererOwner): Promise<HostPath | undefined>
  writeSave(path: HostPath, serialized: string): Promise<void>
}

/** Electron-only screenshot, clipboard, and explicit local-save edge. */
export class ElectronDiagnosticReportActions implements DiagnosticReportActions {
  constructor(private readonly host: Pick<ProjectHost, 'writeFile'>) {}

  async capture(
    owner: RendererOwner,
    masks: readonly DiagnosticCaptureMask[],
  ): Promise<DiagnosticReportScreenshot> {
    const window = windowFor(owner)
    const image = await window.webContents.capturePage()
    const size = image.getSize(1)
    if (size.width < 1 || size.height < 1) throw new Error('Empty capture')
    const bitmap = image.toBitmap({ scaleFactor: 1 })
    const viewport = window.getContentBounds()
    const masked = maskDiagnosticBitmap(
      bitmap,
      size.width,
      size.height,
      viewport.width,
      viewport.height,
      masks,
    )
    const png = nativeImage
      .createFromBitmap(masked, {
        width: size.width,
        height: size.height,
        scaleFactor: 1,
      })
      .toPNG()
    if (png.byteLength > MAX_DIAGNOSTIC_REPORT_SCREENSHOT_BYTES) {
      throw new ScreenshotTooLargeError()
    }
    return {
      mediaType: 'image/png',
      width: size.width,
      height: size.height,
      bytes: png.byteLength,
      sha256: createHash('sha256').update(png).digest('hex'),
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      masked: [...new Set(masks.map(({ surface }) => surface))],
    }
  }

  copy(serialized: string, screenshot?: DiagnosticReportScreenshot): void {
    clipboard.write({
      text: serialized,
      ...(screenshot ? { image: nativeImage.createFromDataURL(screenshot.dataUrl) } : {}),
    })
  }

  async selectSave(owner: RendererOwner): Promise<HostPath | undefined> {
    const window = windowFor(owner)
    const selected = await dialog.showSaveDialog(window, {
      title: 'Save reviewed diagnostic report',
      defaultPath: 'hvir-diagnostic-report.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    return selected.canceled || !selected.filePath
      ? undefined
      : localPath(selected.filePath)
  }

  writeSave(path: HostPath, serialized: string): Promise<void> {
    return this.host.writeFile(path, serialized)
  }
}

export class ScreenshotTooLargeError extends Error {}

export function maskDiagnosticBitmap(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  masks: readonly DiagnosticCaptureMask[],
): Buffer {
  if (
    imageWidth < 1 ||
    imageHeight < 1 ||
    viewportWidth < 1 ||
    viewportHeight < 1 ||
    bitmap.byteLength !== imageWidth * imageHeight * 4
  ) {
    throw new Error('Invalid capture geometry')
  }
  const output = Buffer.from(bitmap)
  const scaleX = imageWidth / viewportWidth
  const scaleY = imageHeight / viewportHeight
  for (const mask of masks) {
    const left = clamp(Math.floor(mask.x * scaleX), 0, imageWidth)
    const top = clamp(Math.floor(mask.y * scaleY), 0, imageHeight)
    const right = clamp(Math.ceil((mask.x + mask.width) * scaleX), 0, imageWidth)
    const bottom = clamp(Math.ceil((mask.y + mask.height) * scaleY), 0, imageHeight)
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * imageWidth + x) * 4
        output[offset] = 32
        output[offset + 1] = 32
        output[offset + 2] = 32
        output[offset + 3] = 255
      }
    }
  }
  return output
}

function windowFor(owner: RendererOwner): BrowserWindow {
  const window = BrowserWindow.getAllWindows().find(
    (candidate) => candidate.webContents.id === owner.id,
  )
  if (!window || window.isDestroyed()) throw new Error('Renderer window unavailable')
  return window
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
