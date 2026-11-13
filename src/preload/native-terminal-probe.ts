/** Standalone native-boundary qualification; never loaded by the workbench. */
import { ipcRenderer, sharedTexture } from 'electron'
import { nativeProbeReadbackWorker } from './native-terminal-probe-readback'

let beats = 0
let phase: number | undefined
let lastBeat = performance.now()
function heartbeat(): void {
  const now = performance.now()
  ipcRenderer.send('native-probe-heartbeat', { beats, phase, gapMs: now - lastBeat })
  lastBeat = now
}
const timer = setInterval(() => {
  beats++
  heartbeat()
}, 10)
ipcRenderer.on('native-probe-phase', (_event, value: { id: number; name?: string }) => {
  if (phase !== undefined) heartbeat()
  phase = value.name === undefined ? undefined : value.id
  lastBeat = performance.now()
  ipcRenderer.send('native-probe-phase-ready', { id: value.id })
})
interface ProbeFrame {
  clone(): ProbeFrame
  allocationSize(options: { format: string }): number
  copyTo(bytes: Uint8Array, options: { format: string }): Promise<unknown>
  close(): void
}
type Held = { frame: ProbeFrame; texture: Electron.SharedTextureImported }
const held = new Set<Held>()
let hold = false
interface Readback {
  bytes: number
  hash: number
  different: boolean
  redPixels: number
  readbackMs: number
  hashMaxSliceMs: number
  readbackWorker: true
  cloneClosedBeforeReply: true
}
interface Observer {
  postMessage(message: unknown, transfer: unknown[]): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onmessageerror: (() => void) | null
}
let observer: Observer | undefined
let observerId = 0
let stopped = false
let active:
  | {
      id: number
      reject(error: Error): void
      resolve(value: Readback): void
      timeout: ReturnType<typeof setTimeout>
    }
  | undefined
function stopObserver(): void {
  stopped = true
  observer?.terminate()
  observer = undefined
  if (active) {
    clearTimeout(active.timeout)
    active.reject(new Error('native-probe-observer-stopped'))
    active = undefined
  }
}
function readFrame(frame: ProbeFrame): Promise<Readback> {
  if (stopped || active) return Promise.reject(new Error('native-probe-observer-bound'))
  if (!observer) {
    const source = `(${nativeProbeReadbackWorker.toString()})()`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      const Worker = (globalThis as unknown as { Worker: new (url: string) => Observer })
        .Worker
      observer = new Worker(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    observer.onerror = stopObserver
    observer.onmessageerror = stopObserver
    observer.onmessage = ({ data }) => {
      const value = data as {
        id?: number
        result?: Partial<Readback> & { error?: string }
        cloneClosedBeforeReply?: boolean
      }
      const result = value?.result
      if (
        !active ||
        value?.id !== active.id ||
        value.cloneClosedBeforeReply !== true ||
        !result ||
        result.error ||
        result.readbackWorker !== true ||
        !Number.isInteger(result.bytes) ||
        !result.bytes ||
        result.bytes > 8192 * 8192 * 4 ||
        !Number.isInteger(result.hash) ||
        typeof result.different !== 'boolean' ||
        !Number.isInteger(result.redPixels) ||
        ![result.readbackMs, result.hashMaxSliceMs].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
        )
      ) {
        stopObserver()
        return
      }
      const completed = active
      active = undefined
      clearTimeout(completed.timeout)
      completed.resolve({ ...result, cloneClosedBeforeReply: true } as Readback)
    }
  }
  const target = observer
  let clone: ProbeFrame
  try {
    clone = frame.clone()
  } catch (error) {
    stopObserver()
    throw error
  }
  return new Promise((resolve, reject) => {
    const id = ++observerId
    active = { id, resolve, reject, timeout: setTimeout(stopObserver, 10000) }
    try {
      target.postMessage({ id, frame: clone }, [clone])
    } catch {
      clone.close()
      stopObserver()
    }
  })
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
ipcRenderer.once('native-probe-stop', () => {
  clearInterval(timer)
  stopped = true
  stopObserver()
})
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
