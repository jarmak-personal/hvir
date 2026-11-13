import { describe, expect, it, vi } from 'vitest'
import {
  PtyTerminalOutput,
  PtyTerminalOutputBudget,
} from '../src/main/pty/pty-terminal-output'
import type { PtyPreparedTerminal } from '../src/main/pty/pty-contract'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
function fixture(budget = new PtyTerminalOutputBudget()) {
  const source = { pause: vi.fn<() => void>(), resume: vi.fn<() => void>() }
  const terminal = {
    columns: 80,
    rows: 24,
    connect: vi.fn<PtyPreparedTerminal['connect']>(),
    output: vi.fn<PtyPreparedTerminal['output']>().mockResolvedValue(),
    exited: vi.fn<PtyPreparedTerminal['exited']>().mockResolvedValue(),
    failed: vi.fn<PtyPreparedTerminal['failed']>(),
    dispose: vi.fn<PtyPreparedTerminal['dispose']>().mockResolvedValue(),
  }
  return {
    source,
    terminal,
    budget,
    stream: new PtyTerminalOutput(source, terminal, budget),
  }
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('supervisor-owned native PTY output ingress', () => {
  it('pauses physical delivery and serializes decoded text with active byte credit', async () => {
    const f = fixture(),
      first = deferred(),
      second = deferred()
    f.terminal.output
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    f.stream.output('a')
    expect(f.source.pause).toHaveBeenCalledOnce()
    await flush()
    f.stream.output('é')
    f.stream.output('🙂')
    expect(f.terminal.output.mock.calls).toEqual([['a']])
    expect(f.stream.queuedBytes).toBe(7)
    expect(f.budget.queuedBytes).toBe(7)
    first.resolve()
    await flush()
    expect(f.terminal.output.mock.calls).toEqual([['a'], ['é🙂']])
    expect(f.stream.queuedBytes).toBe(6)
    expect(f.source.resume).not.toHaveBeenCalled()
    second.resolve()
    await flush()
    expect(f.source.resume).toHaveBeenCalledOnce()
    expect(f.budget.queuedBytes).toBe(0)
    await f.stream.dispose()
  })
  it('marks native output unavailable on overrun without replaying or freeing active credit', async () => {
    const f = fixture(),
      active = deferred()
    f.terminal.output.mockReturnValueOnce(active.promise)
    f.stream.output('a'.repeat(65536))
    await flush()
    f.stream.output('b'.repeat(65536))
    expect(f.stream.queuedBytes).toBe(131072)
    f.stream.output('overflow')
    expect(f.terminal.failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'pty-native-output-bound' }),
    )
    expect(f.source.resume).toHaveBeenCalledOnce()
    expect(f.budget.queuedBytes).toBe(65536)
    f.stream.output('ignored')
    active.resolve()
    await flush()
    expect(f.terminal.output).toHaveBeenCalledOnce()
    expect(f.budget.queuedBytes).toBe(0)
    await f.stream.dispose()
  })
  it('retains aggregate credit until physical calls settle even after disposal', async () => {
    const budget = new PtyTerminalOutputBudget()
    const owners = Array.from({ length: 8 }, () => ({
      f: fixture(budget),
      active: deferred(),
    }))
    for (const { f, active } of owners) {
      f.terminal.output.mockReturnValueOnce(active.promise)
      f.stream.output('x'.repeat(131072))
    }
    await flush()
    expect(budget.queuedBytes).toBe(1048576)
    const rejected = fixture(budget)
    rejected.stream.output('x')
    expect(rejected.terminal.failed).toHaveBeenCalledOnce()
    const disposing = owners[0]!.f.stream.dispose()
    expect(budget.queuedBytes).toBe(1048576)
    expect(owners[0]!.f.terminal.dispose).not.toHaveBeenCalled()
    for (const { active } of owners) active.resolve()
    await disposing
    await flush()
    expect(budget.queuedBytes).toBe(0)
    const replacement = fixture(budget)
    replacement.stream.output('new')
    await flush()
    expect(replacement.terminal.output).toHaveBeenCalledExactlyOnceWith('new')
    await Promise.all([
      ...owners.map(({ f }) => f.stream.dispose()),
      rejected.stream.dispose(),
      replacement.stream.dispose(),
    ])
  })
  it('drains only admitted text before publishing natural exit and retaining parser history', async () => {
    const f = fixture(),
      first = deferred(),
      last = deferred()
    f.terminal.output.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    f.stream.output('first')
    await flush()
    f.stream.output('admitted tail')
    const exit = { exitCode: 0, signal: undefined }
    const ended = f.stream.exited(exit)
    f.stream.output('not admitted after physical exit')
    expect(f.terminal.exited).not.toHaveBeenCalled()
    first.resolve()
    await flush()
    expect(f.terminal.output.mock.calls).toEqual([['first'], ['admitted tail']])
    expect(f.terminal.exited).not.toHaveBeenCalled()
    last.resolve()
    await ended
    expect(f.terminal.exited).toHaveBeenCalledExactlyOnceWith(exit)
    expect(f.terminal.dispose).not.toHaveBeenCalled()
    expect(f.budget.queuedBytes).toBe(0)
    await f.stream.dispose()
  })
  it('coalesces exit/dispose drain fences and disposes once after physical completion', async () => {
    const f = fixture(),
      active = deferred()
    f.terminal.output.mockReturnValueOnce(active.promise)
    f.stream.output('active')
    await flush()
    f.stream.output('queued')
    const ended = f.stream.exited({ exitCode: 0, signal: undefined })
    const disposing = f.stream.dispose()
    expect(f.stream.dispose()).toBe(disposing)
    expect(f.budget.queuedBytes).toBe(6)
    expect(f.terminal.dispose).not.toHaveBeenCalled()
    active.resolve()
    await Promise.all([ended, disposing])
    expect(f.terminal.output).toHaveBeenCalledOnce()
    expect(f.terminal.exited).not.toHaveBeenCalled()
    expect(f.terminal.dispose).toHaveBeenCalledOnce()
    expect(f.budget.queuedBytes).toBe(0)
  })
  it('isolates a failed native sink and resumes the original source without replay', async () => {
    const f = fixture(),
      active = deferred()
    f.terminal.output.mockReturnValueOnce(active.promise)
    f.stream.output('first')
    await flush()
    f.stream.output('queued')
    active.reject(new Error('native feed failed'))
    await flush()
    expect(f.terminal.failed).toHaveBeenCalledOnce()
    expect(f.source.resume).toHaveBeenCalledOnce()
    expect(f.budget.queuedBytes).toBe(0)
    f.stream.output('later')
    expect(f.terminal.output).toHaveBeenCalledOnce()
    await f.stream.dispose()
  })
  it('requires physical flow control and does not let a failed observer hold source pause', async () => {
    const f = fixture()
    expect(() => new PtyTerminalOutput({}, f.terminal, f.budget)).toThrow(
      'flow-control-unavailable',
    )
    f.terminal.failed.mockImplementation(() => {
      throw new Error('retired observer')
    })
    expect(() => f.stream.output('x'.repeat(131073))).not.toThrow()
    expect(f.budget.queuedBytes).toBe(0)
    await f.stream.dispose()
  })
})
