import { describe, expect, it, vi } from 'vitest'
import type { PtyProcess } from '../src/main/project-host/project-host'
import { PtyStreamAttachment } from '../src/main/pty/pty-stream-attachment'
import {
  CapacityTerminalSourceObservation,
  observeCapacityTerminalSource,
} from '../src/main/smoke/capacity-terminal-source-observation'

const metadata = '\x1b]9999;hvir-capacity;output;12;3012;90;20\x07'

describe('capacity real-source observation', () => {
  it('retains first source receipt across every metadata chunk boundary', () => {
    for (let split = 1; split < metadata.length; split++) {
      const observation = new CapacityTerminalSourceObservation()
      observation.consume(42, metadata.slice(0, split), 10)
      observation.consume(42, metadata.slice(split), 25)
      expect(observation.get('output', 12)).toEqual({
        pid: 42,
        kind: 'output',
        sequence: 12,
        row: 3012,
        columns: 90,
        rows: 20,
        receivedAtMs: 10,
      })
    }
  })

  it('rejects unknown/truncated metadata while finding a later complete controlled marker', () => {
    const observation = new CapacityTerminalSourceObservation()
    observation.consume(42, metadata.replace('output', 'private') + 'x'.repeat(8192), 5)
    expect(observation.get('private', 12)).toBeUndefined()
    observation.consume(42, metadata, 10)
    expect(observation.get('output', 12)?.receivedAtMs).toBe(10)
  })

  it('preserves the real PTY, observes before native feed, and restores the stream owner', async () => {
    let closed = false
    let sourceListener: ((data: string) => void) | undefined
    const receiver = vi.fn()
    const process: PtyProcess = {
      pid: 42,
      get inputClosed() {
        return closed
      },
      onData(listener) {
        sourceListener = listener
        return () => undefined
      },
      onExit() {
        return () => undefined
      },
      write() {
        receiver(this)
      },
      writeConfirmed() {
        receiver(this)
        return Promise.resolve()
      },
      resize() {
        receiver(this)
      },
      kill() {
        receiver(this)
      },
      pause() {
        receiver(this)
      },
      resume() {
        receiver(this)
      },
    }
    const original: unknown = Reflect.get(PtyStreamAttachment.prototype, 'start')
    const observer = observeCapacityTerminalSource()
    const stream = new PtyStreamAttachment()
    const observedBeforeNative: boolean[] = []
    stream.start(
      process,
      () => undefined,
      () => {
        observedBeforeNative.push(!!observer.get(42)?.get('output', 12))
      },
    )
    expect(process.inputClosed).toBe(false)
    closed = true
    expect(process.inputClosed).toBe(true)
    sourceListener?.(metadata)
    expect(observedBeforeNative).toEqual([true])
    process.write('x')
    await process.writeConfirmed('x')
    process.resize(80, 24)
    process.pause?.()
    process.resume?.()
    process.kill()
    expect(receiver.mock.calls).toHaveLength(6)
    for (const [actual] of receiver.mock.calls) expect(actual).toBe(process)
    observer.dispose()
    expect(Reflect.get(PtyStreamAttachment.prototype, 'start')).toBe(original)
    expect(observer.get(42)).toBeUndefined()
    sourceListener?.(metadata)
    expect(observedBeforeNative).toEqual([true, false])
    stream.dispose()
  })
})
