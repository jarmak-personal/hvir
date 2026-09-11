import type { ExecResult } from '../src/shared'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { BufferedExecOutput } from '../src/main/project-host/buffered-exec-output'
import { SkillagerProcess } from '../src/main/skillager/skillager-process'

const limits = { stdout: 1024, stderr: 128, deadlineMs: 2000 }
afterEach(() => vi.useRealTimers())

describe('Skillager process lifetime through buffered ProjectHost', () => {
  it('enforces independent byte bounds and preserves existing combined/NUL record bounds', () => {
    const budget = new BufferedExecOutput(
      { maxBuffer: 100, maxStdoutBytes: 10, maxStderrBytes: 3 },
      100,
    )
    budget.add('stdout', Buffer.from('12345'))
    budget.add('stderr', Buffer.from('123'))
    expect(budget.exceeded).toBe(false)
    budget.add('stderr', Buffer.from('4'))
    expect(budget.exceeded).toBe(true)
    const nul = new BufferedExecOutput({ maxStdoutNulRecords: 1 }, 100)
    nul.add('stdout', Buffer.from('file\0'))
    expect(nul.exceeded).toBe(true)
    const total = new BufferedExecOutput({ maxBuffer: 5 }, 100)
    total.add('stdout', Buffer.from('123'))
    total.add('stderr', Buffer.from('456'))
    expect(total.exceeded).toBe(true)
  })
  it('retains admission until the host confirms close after cancellation', async () => {
    const closing: Array<() => void> = []
    const runner = new SkillagerProcess({
      exec: vi.fn(
        (_command: string, _args: readonly string[], options?: ExecOptions) =>
          new Promise<ExecResult>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              closing.push(() => reject(new Error('aborted'))),
            )
          }),
      ),
    })
    const firstAbort = new AbortController()
    const first = runner
      .run('skillager', [], { signal: firstAbort.signal }, limits)
      .catch((error: unknown) => error)
    const secondAbort = new AbortController()
    const second = runner
      .run('skillager', [], { signal: secondAbort.signal }, limits)
      .catch((error: unknown) => error)
    firstAbort.abort()
    await expect(runner.run('skillager', [], {}, limits)).rejects.toMatchObject({
      reason: 'busy',
    })
    closing.shift()!()
    expect(await first).toMatchObject({ reason: 'cancelled' })
    const disposed = runner.dispose()
    closing.shift()!()
    expect(await second).toMatchObject({ reason: 'cancelled' })
    await disposed
  })
  it('kills real local process groups for timeout, abort, and disposal', async () => {
    const host = new LocalHost()
    const runner = new SkillagerProcess(host)
    try {
      const script = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'
      await expect(
        runner.run(process.execPath, ['-e', script], {}, { ...limits, deadlineMs: 50 }),
      ).rejects.toMatchObject({ reason: 'timeout' })
      const controller = new AbortController()
      const task = runner.run(
        process.execPath,
        ['-e', script],
        { signal: controller.signal },
        limits,
      )
      controller.abort()
      await expect(task).rejects.toMatchObject({ reason: 'cancelled' })
      const active = runner
        .run(process.execPath, ['-e', script], {}, limits)
        .catch((error: unknown) => error)
      await runner.dispose()
      expect(await active).toMatchObject({ reason: 'cancelled' })
      await expect(runner.run('true', [], {}, limits)).rejects.toMatchObject({
        reason: 'cancelled',
      })
    } finally {
      await runner.dispose()
      await host.dispose()
    }
  })
  it.each(['stdout', 'stderr'] as const)(
    'fails honestly on real %s overflow without exposing command diagnostics',
    async (stream) => {
      const host = new LocalHost()
      const runner = new SkillagerProcess(host)
      try {
        await expect(
          runner.run(
            process.execPath,
            ['-e', `process.${stream}.write("PRIVATE".repeat(1000))`],
            {},
            limits,
          ),
        ).rejects.toMatchObject({
          reason: 'output-limit',
          message: 'Skillager output exceeded the supported size.',
        })
      } finally {
        await runner.dispose()
        await host.dispose()
      }
    },
  )
})
