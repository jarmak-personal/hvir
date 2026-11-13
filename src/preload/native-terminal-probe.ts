/** Standalone native-boundary qualification; never loaded by the workbench. */
import { ipcRenderer, sharedTexture } from 'electron'

let beats = 0
const timer = setInterval(() => {
  beats++
  ipcRenderer.send('native-probe-heartbeat', beats)
}, 10)
interface ProbeFrame {
  allocationSize(options: { format: string }): number
  copyTo(bytes: Uint8Array, options: { format: string }): Promise<unknown>
  close(): void
}
type Held = { frame: ProbeFrame; texture: Electron.SharedTextureImported }
const held = new Set<Held>()
let hold = false
async function readFrame(frame: ProbeFrame) {
  const length = frame.allocationSize({ format: 'RGBA' })
  if (length <= 0 || length > 8192 * 8192 * 4) throw new Error('native-probe-frame-bound')
  const bytes = new Uint8Array(length)
  await frame.copyTo(bytes, { format: 'RGBA' })
  let hash = 2166136261
  let different = false
  let redPixels = 0
  for (let i = 0; i < bytes.length; i++) {
    const value = bytes[i] ?? 0
    if (
      i % 4 === 0 &&
      value > 150 &&
      (bytes[i + 1] ?? 255) < 100 &&
      (bytes[i + 2] ?? 255) < 100
    )
      redPixels++
    hash = Math.imul(hash ^ value, 16777619)
    if (i >= 4 && value !== bytes[i % 4]) different = true
  }
  return { bytes: length, hash: hash >>> 0, different, redPixels }
}
sharedTexture.setSharedTextureReceiver(
  async ({ importedSharedTexture: texture }, metadata: unknown) => {
    let frame: ProbeFrame | undefined
    let retained = false
    try {
      frame = texture.getVideoFrame() as unknown as ProbeFrame
      const metrics = await readFrame(frame)
      if (hold) {
        if (held.size >= 3) throw new Error('native-probe-held-bound')
        held.add({ frame, texture })
        retained = true
      }
      ipcRenderer.send('native-probe-frame', { metadata, ...metrics, beats })
    } catch {
      ipcRenderer.send('native-probe-failure')
    } finally {
      if (!retained) {
        frame?.close()
        texture.release()
      }
    }
  },
)
ipcRenderer.on('native-probe-hold', () => {
  hold = true
  ipcRenderer.send('native-probe-held-armed', true)
})
ipcRenderer.on('native-probe-check-held', () => {
  void (async () => {
    try {
      if (!held.size) throw new Error('native-probe-no-held-frame')
      for (const { frame } of held) {
        const { redPixels, bytes, hash } = await readFrame(frame)
        ipcRenderer.send('native-probe-held-valid', { redPixels, bytes, hash })
      }
    } catch {
      ipcRenderer.send('native-probe-failure')
    }
  })()
})
ipcRenderer.on('native-probe-release-held', () => {
  hold = false
  for (const { frame, texture } of held) {
    frame.close()
    texture.release()
  }
  held.clear()
})
ipcRenderer.once('native-probe-stop', () => clearInterval(timer))
ipcRenderer.send('native-probe-ready', {
  sandboxed: process.sandboxed,
  contextIsolated: process.contextIsolated,
})

ipcRenderer.on('native-probe-block', () => {
  ipcRenderer.send('native-probe-block-started')
  const deadline = performance.now() + 1800
  while (performance.now() < deadline) {
    /* Deliberately stall this disposable renderer to exercise Electron's real transfer timeout. */
  }
})
