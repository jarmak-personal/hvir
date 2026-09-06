import { describe, expect, it, vi } from 'vitest'
import { PtyStreamAttachment } from '../src/main/pty/pty-stream-attachment'
import { PtySessionLifetime } from '../src/main/pty/pty-session-lifetime'
import { TestPtyProcess } from './fixtures/pty-supervisor-fixture'

describe('PTY stream attachment', () => {
  it('trims partial chunks and rearms replay only on an authorized transfer', () => {
    const pty = new TestPtyProcess()
    const stream = new PtyStreamAttachment()
    stream.start(pty, () => undefined)
    pty.emitData('x'.repeat(256 * 1024 - 2))
    pty.emitData('tail')
    const data: string[] = []
    const detach = stream.attach({ onData: (chunk) => data.push(chunk) })
    expect(data.join('')).toBe('x'.repeat(256 * 1024 - 4) + 'tail')
    void detach()
    pty.emitData('ordinary detached output')
    stream.detachForTransfer()
    pty.emitData('transfer output')
    const next = vi.fn()
    stream.attach({ onData: next })
    expect(next).toHaveBeenCalledExactlyOnceWith('transfer output')
    stream.dispose()
    stream.dispose()
    expect(pty.dataListeners.size).toBe(0)
    expect(pty.kill).not.toHaveBeenCalled()
  })
})

describe('PTY resource lifetime', () => {
  it('revokes before reverse-order child disposal and kills once', () => {
    const pty = new TestPtyProcess()
    const lifetime = new PtySessionLifetime(pty)
    const disposed: string[] = []
    lifetime.own(() => {
      expect(lifetime.current).toBe(false)
      disposed.push('stream')
    })
    lifetime.own(() => {
      expect(lifetime.current).toBe(false)
      disposed.push('observation')
    })
    const onExit = vi.fn()
    lifetime.start(onExit, () => undefined)
    lifetime.terminate()
    lifetime.terminate()
    const late = vi.fn()
    lifetime.own(late)
    pty.emitExit({ exitCode: 0, signal: undefined })
    expect(disposed).toEqual(['observation', 'stream'])
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(late).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    expect(pty.exitListeners.size).toBe(0)
  })

  it('drains a synchronous exit subscription without retaining late listener cleanup', () => {
    const pty = new TestPtyProcess()
    const disposeExit = vi.fn()
    vi.spyOn(pty, 'onExit').mockImplementation((listener) => {
      listener({ exitCode: 0, signal: undefined })
      return disposeExit
    })
    const lifetime = new PtySessionLifetime(pty)
    const disposed = vi.fn()
    lifetime.own(disposed)
    const onExit = vi.fn()
    const afterExit = vi.fn()
    lifetime.start(onExit, afterExit)
    lifetime.terminate()
    expect(onExit).toHaveBeenCalledOnce()
    expect(afterExit).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
    expect(disposeExit).toHaveBeenCalledOnce()
    expect(pty.kill).not.toHaveBeenCalled()
  })
})
