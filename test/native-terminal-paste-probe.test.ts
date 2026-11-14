import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativePasteMemoryObservation,
  nativePasteExpectations,
  nativePasteRecorderSource,
} from '../src/main/smoke/native-terminal-paste'
import { nativeWorkbenchReceiptLine } from '../src/main/smoke/native-terminal-workbench'

function recorder() {
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  })
  const writes: string[] = []
  const exit = vi.fn()
  runInNewContext(nativePasteRecorderSource(), {
    process: {
      stdin,
      stdout: {
        write: (text: string, done?: () => void) => {
          writes.push(text)
          done?.()
          return true
        },
      },
      exit,
    },
    require: () => ({ createHash }),
    Buffer,
    setTimeout,
    clearTimeout,
  })
  const emit = (bytes: string | Buffer) => stdin.emit('data', Buffer.from(bytes))
  return {
    emit,
    command: (value: string) => emit('\x1d' + value + '\x1d'),
    text: () => writes.join(''),
    exit,
    stdin,
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('large-paste recorder protocol (not a native encoder proof)', () => {
  it('defines exact UTF8 source bytes and the oversized LNM result without embedding bodies', () => {
    const [unicode, lnm] = nativePasteExpectations()
    expect(Buffer.byteLength(unicode!.pattern) * unicode!.repeat).toBe(17 * 1024 * 1024)
    expect(unicode!.wireBytes).toBe(17 * 1024 * 1024 + 12)
    expect(lnm!.sourceBytes).toBe(33 * 1024 * 1024)
    expect(lnm!.wireBytes).toBe(66 * 1024 * 1024)
    expect(nativePasteRecorderSource().length).toBeLessThan(4096)
  })
  it('stream-hashes both complete fixed transactions, split handshake and late physical arrival', () => {
    const f = recorder()
    for (const fixture of nativePasteExpectations()) {
      f.command(fixture.name)
      expect(f.text()).toContain(fixture.bracketed ? '\x1b[?2004h' : '\x1b[?2004l')
      expect(f.text()).toContain(fixture.lnm ? '\x1b[20h' : '\x1b[20l')
      f.emit('\x1b[')
      expect(f.text()).not.toContain(fixture.name + '_READY')
      f.emit('0n')
      expect(f.text()).toContain(fixture.name + '_READY')
      if (fixture.bracketed) f.emit('\x1b[200~')
      const pattern = fixture.lnm ? '\r\n' : fixture.pattern
      const block = Buffer.from(pattern.repeat(1024))
      for (let i = 0; i < fixture.repeat; i += 1024) f.emit(block)
      expect(f.text()).not.toContain(fixture.name + '_OK')
      if (fixture.bracketed) f.emit('\x1b[201~')
      f.command('end')
      expect(f.text()).toContain(fixture.name + '_OK')
      expect(f.exit).not.toHaveBeenCalled()
    }
    f.command('quit')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.stdin.setRawMode.mock.calls).toEqual([[true], [false]])
    expect(f.text().length).toBeLessThan(1024)
  })
  it('rejects adapter acknowledgement without a complete recorder transaction', () => {
    const f = recorder()
    f.command('lnm')
    f.emit('\x1b[0n')
    f.emit('\x1b[200~\r\n')
    f.command('end')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.text()).not.toContain('lnm_OK')
  })
  it('bounds a missing physical completion and resets terminal modes on failure', async () => {
    const f = recorder()
    f.command('unicode')
    f.emit('\x1b[0n')
    await vi.advanceTimersByTimeAsync(100000)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.text()).toContain('\x1b[20l\x1b[?2004l')
  })
})

describe('native workbench memory record flow', () => {
  it('streams bounded raw records and keeps representative long-running summaries parseable below the stdout boundary', () => {
    const cases = []
    let emitted = 0
    for (const name of ['unicode', 'lnm']) {
      const observation = new NativePasteMemoryObservation(name, (line) => {
        expect(Buffer.byteLength(line)).toBeLessThan(512)
        const record = JSON.parse(
          line.slice('HVIR_NATIVE_PASTE_MEMORY_SAMPLE '.length),
        ) as { case: string; pid: number; workingSetSize: number }
        expect(record.case).toBe(name)
        expect(record.pid).toBeGreaterThan(0)
        expect(record.workingSetSize).toBeGreaterThan(0)
        emitted++
      })
      for (let index = 0; index < 1024; index++)
        observation.record(
          index * 100,
          Array.from({ length: 32 }, (_, pid) => ({
            pid: pid + 1,
            type: 'Utility',
            workingSetSize: 100000 + index,
            peakWorkingSetSize: 200000 + index,
          })),
        )
      const summary = observation.summary()
      expect(summary.sampleCount).toBe(1024)
      expect(summary.processes[0]).toEqual({
        pid: 1,
        type: 'Utility',
        samples: 1024,
        baselineKiB: 100000,
        lastKiB: 101023,
        minKiB: 100000,
        maxKiB: 101023,
        reportedPeakMaxKiB: 201023,
      })
      cases.push({
        name,
        sourceBytes: name === 'unicode' ? 17 * 1024 * 1024 : 33 * 1024 * 1024,
        wireBytes: name === 'unicode' ? 17 * 1024 * 1024 + 12 : 66 * 1024 * 1024,
        wireSha256: 'a'.repeat(64),
        memory: summary,
        paint: { frames: 400, maxGapMs: 20 },
      })
    }
    const receipt = {
      platform: 'darwin',
      arch: 'arm64',
      nativeInput: { phases: 16, mutationFences: 16 },
      largePaste: { cases, memorySampleRecords: 2048 },
      nativeRenderer: {
        lastFrame: {
          resource: { fourcc: 1, modifier: '18446744073709551615', planes: [] },
        },
      },
    }
    const line = nativeWorkbenchReceiptLine(receipt)
    expect(Buffer.byteLength(line)).toBeLessThan(32 * 1024)
    expect(JSON.parse(line.slice('HVIR_NATIVE_WORKBENCH_OK '.length))).toEqual(receipt)
    expect(emitted).toBe(2 * 1024 * 32)
    expect(line).not.toContain('samplesKiB')
  })
})
