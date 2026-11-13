/** Closure-free Blob Worker entry, used only by the native qualification preload. */
export function nativeProbeReadbackWorker(): void {
  const scope = globalThis as unknown as {
    onmessage: (event: {
      data: {
        id: number
        frame: {
          allocationSize(options: { format: string }): number
          copyTo(bytes: Uint8Array, options: { format: string }): Promise<unknown>
          close(): void
        }
      }
    }) => void
    postMessage(message: unknown): void
  }
  let busy = false
  scope.onmessage = ({ data: { id, frame } }) => {
    if (busy) {
      frame.close()
      scope.postMessage({
        id,
        result: { error: 'native-probe-observer-overlap' },
        cloneClosedBeforeReply: true,
      })
      return
    }
    busy = true
    void (async () => {
      let result: unknown
      try {
        const length = frame.allocationSize({ format: 'RGBA' })
        if (length <= 0 || length > 8192 * 8192 * 4)
          throw new Error('native-probe-frame-bound')
        const bytes = new Uint8Array(length)
        const readbackStarted = performance.now()
        await frame.copyTo(bytes, { format: 'RGBA' })
        const readbackMs = performance.now() - readbackStarted
        const hashStarted = performance.now()
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
        result = {
          bytes: length,
          hash: hash >>> 0,
          different,
          redPixels,
          readbackMs,
          hashMaxSliceMs: performance.now() - hashStarted,
          readbackWorker: true,
        }
      } catch {
        result = { error: 'native-probe-worker-readback' }
      } finally {
        frame.close()
        busy = false
      }
      // No reply, including an error reply, may retain the transferred clone.
      scope.postMessage({ id, result, cloneClosedBeforeReply: true })
    })()
  }
}
