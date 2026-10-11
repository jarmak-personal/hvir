import type { ExtensionConnectorOutput } from '../src/shared/extensions/connectors'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import type { ExecResult } from '../src/shared/fs-types'

const fixtures: ReturnType<typeof connectorFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
  vi.useRealTimers()
})
function fixture(context: 'application' | 'workspace' = 'application', bytes?: number) {
  const value = connectorFixture(context, bytes)
  fixtures.push(value)
  return value
}
function pending() {
  let resolve!: (value: ExecResult) => void
  const promise = new Promise<ExecResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const successful: ExecResult = { code: 0, signal: null, stdout: 'ok', stderr: '' }
describe('finite connector execution', () => {
  it('retains complete host-qualified workspace identities through connector authorization and native dispatch', async () => {
    const f = fixture('workspace')
    await f.approve()
    const workspace = 'workspace:remote:/' + 'nested-project/'.repeat(16),
      admitted = f.caller.context('42-workspace')!
    const authorizeHost = vi.fn()
    const caller = {
      ...f.caller,
      authorizeHost,
      context: (id: string | undefined) =>
        id === workspace
          ? {
              ...admitted,
              value: {
                ...admitted.value,
                workspace: { ...admitted.value.workspace!, id: workspace },
              },
            }
          : undefined,
    }
    expect((await f.execution.execute(caller, { ...f.input, workspace })).outcome).toBe(
      'completed',
    )
    expect(authorizeHost).toHaveBeenCalledWith('remote', workspace)
    expect(f.host.exec).toHaveBeenCalledOnce()
  })

  it('bounds application-wide native admission across installations without queueing', async () => {
    const f = fixture('application', 1024),
      deferred = pending()
    await f.approve()
    f.host.exec.mockImplementation(() => deferred.promise)
    const callers = []
    for (let index = 0; index < 5; index++) {
      const activation = {
        ...f.activation,
        installationId: 'installation-' + index,
        generation: 'generation-' + index,
      }
      f.active.set(activation.installationId, activation)
      const prepared = await f.approvals.prepare(
        {
          installationId: activation.installationId,
          connector: 'tool',
          host: 'local',
          executable: '/installed/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      )
      await f.approvals.approve(prepared.token)
      for (let action = 0; action < 4; action++)
        callers.push({
          ...f.caller,
          activation,
          action: `action-${index}-${action}`,
          current: () => {
            if (f.active.get(activation.installationId) !== activation)
              throw new Error('Revoked')
          },
        })
    }
    const calls = callers.map((caller) => f.execution.execute(caller, f.input))
    await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledTimes(16))
    deferred.resolve(successful)
    const results = await Promise.all(calls)
    expect(results.filter((entry) => entry.outcome === 'completed')).toHaveLength(16)
    expect(
      results.filter(
        (entry) => entry.outcome === 'not-started' && entry.reason === 'capacity',
      ),
    ).toHaveLength(4)
  })
  it('bounds canonical admission before dispatch and holds unfinished host work charged', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.approve()
    const path = f.host.realpath.mock.calls[0]![0]
    let resolve!: (value: typeof path) => void
    const pendingPath = new Promise<typeof path>((done) => {
      resolve = done
    })
    f.host.realpath.mockImplementation(() => pendingPath)
    const calls = Array.from({ length: 4 }, () => f.execution.execute(f.caller, f.input))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await Promise.all(calls)).toEqual(
      Array(4).fill(
        expect.objectContaining({ outcome: 'not-started', reason: 'deadline' }),
      ),
    )
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'capacity',
    })
    expect(f.host.exec).not.toHaveBeenCalled()
    resolve(path)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.host.exec).not.toHaveBeenCalled()
  })
  it.each(['application', 'workspace'] as const)(
    'runs an approved %s connector through the pinned host and context and returns explicit status',
    async (context) => {
      const f = fixture(context)
      await f.approve()
      const result = await f.execution.execute(f.caller, f.input)
      expect(result).toMatchObject({
        outcome: 'completed',
        host: context === 'application' ? 'local' : 'remote',
        code: 0,
        truncated: false,
      })
      expect(f.host.exec).toHaveBeenCalledWith(
        '/installed/tool',
        ['--json', 'status'],
        expect.objectContaining({
          cwd:
            context === 'application'
              ? { hostId: 'local', path: '/state/scratch' }
              : { hostId: 'remote', path: '/workspace' },
          env: { TOOL_HOME: '/library' },
          maxBuffer: 4 * 1024 * 1024,
          allowTruncatedOutput: true,
        }),
      )
      expect(
        f.execution.output(f.caller, {
          receipt: result.receipt,
          stream: 'stdout',
          offset: 0,
        })?.data,
      ).toBe('result')
    },
  )
  it('reports not-started without native work for missing approval, ended demand, forged context and disconnect', async () => {
    const f = fixture()
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'unapproved',
    })
    await f.approve()
    expect(
      await f.execution.execute(f.caller, { ...f.input, workspace: 'forged' }),
    ).toMatchObject({ outcome: 'not-started' })
    expect(
      await f.execution.execute(f.caller, { ...f.input, host: 'forged' }),
    ).toMatchObject({ outcome: 'not-started' })
    f.endDemand()
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'context-ended',
    })
    f.disconnect()
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'disconnected',
    })
    expect(f.host.exec).not.toHaveBeenCalled()
  })
  it('never hashes executable contents and rechecks changed canonical symlink targets', async () => {
    const f = fixture()
    await f.approve()
    f.host.stat.mockResolvedValue({ type: 'file', mode: 0o755, size: 8000, mtimeMs: 2 })
    expect((await f.execution.execute(f.caller, f.input)).outcome).toBe('completed')
    f.host.realpath.mockResolvedValue({
      ...f.host.realpath.mock.calls[0]![0],
      path: '/new/target',
    })
    expect(
      await f.execution.execute(f.caller, { ...f.input, args: ['changed'] }),
    ).toMatchObject({ outcome: 'not-started', reason: 'unapproved' })
    expect(f.host.exec).toHaveBeenCalledOnce()
  })
  it('clips an adapter chunk overshoot, preserves UTF-8, and never presents truncation as a completed response', async () => {
    const f = fixture('application', 7)
    await f.approve()
    f.host.exec.mockResolvedValueOnce({
      ...successful,
      stdout: '😀😀😀',
      stderr: 'error',
    })
    const result = await f.execution.execute(f.caller, f.input)
    expect(result).toMatchObject({
      outcome: 'interrupted-uncertain',
      truncated: true,
      reason: 'output-limit',
      stdoutBytes: 4,
      stderrBytes: 3,
    })
    expect(
      f.execution.output(f.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      })?.data,
    ).toBe('😀')
    expect(
      f.execution.output(f.caller, {
        receipt: result.receipt,
        stream: 'stderr',
        offset: 0,
      })?.data,
    ).toBe('err')
  })
  it('pages a large JSON-sensitive response inside complete bridge envelopes and refuses sibling receipt forgery', async () => {
    const f = fixture()
    await f.approve()
    const expected = '\u0001\\"😀'.repeat(1500)
    f.host.exec.mockResolvedValueOnce({ ...successful, stdout: expected })
    const result = await f.execution.execute(f.caller, f.input)
    let offset: number | null = 0,
      output = ''
    while (offset !== null) {
      const page: ExtensionConnectorOutput = f.execution.output(f.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset,
      })!
      expect(
        Buffer.byteLength(
          JSON.stringify({
            kind: 'result',
            id: 'x'.repeat(80),
            ok: true,
            value: page,
            warnings: Array(16).fill('Ignored unknown field: ' + 'x'.repeat(80)),
          }),
        ),
      ).toBeLessThanOrEqual(EXTENSION_LIMITS.messageBytes)
      output += page.data
      offset = page.nextOffset
    }
    expect(output).toBe(expected)
    expect(() =>
      f.execution.output(
        { ...f.caller, view: 'sibling' },
        { receipt: result.receipt, stream: 'stdout', offset: 0 },
      ),
    ).toThrow('another caller')
    expect(
      f.execution.output(f.caller, { receipt: result.receipt, release: true }),
    ).toBeNull()
    expect(() =>
      f.execution.output(f.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      }),
    ).toThrow('stale')
  })
  it('shares only identical refresh sources and separates explicit action execution from refresh', async () => {
    const f = fixture(),
      deferred = pending()
    await f.approve()
    f.host.exec.mockImplementation(() => deferred.promise)
    const first = f.execution.execute(f.caller, f.input)
    await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledOnce())
    const second = f.execution.execute({ ...f.caller, view: 'other' }, f.input)
    const action = f.execution.execute(
      { ...f.caller, action: 'admitted-action' },
      f.input,
    )
    await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledTimes(2))
    deferred.resolve(successful)
    expect((await first).outcome).toBe('completed')
    expect((await second).outcome).toBe('completed')
    expect((await action).outcome).toBe('completed')
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'frequency',
    })
  })
  it('canceling one shared consumer does not interrupt another consumer', async () => {
    const f = fixture(),
      deferred = pending(),
      secondController = new AbortController()
    await f.approve()
    f.host.exec.mockImplementation(() => deferred.promise)
    const first = f.execution.execute(f.caller, f.input)
    await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledOnce())
    const second = f.execution.execute(
      { ...f.caller, view: 'second', signal: secondController.signal },
      f.input,
    )
    await vi.waitFor(() => expect(f.host.realpath).toHaveBeenCalledTimes(4))
    f.controller.abort()
    expect(await first).toMatchObject({ outcome: 'interrupted-uncertain' })
    expect(f.host.exec.mock.calls[0]![2]?.signal?.aborted).toBe(false)
    deferred.resolve(successful)
    expect((await second).outcome).toBe('completed')
  })
  it('ends refresh on lost demand while an independently admitted hidden action finishes', async () => {
    const f = fixture(),
      deferred = pending()
    await f.approve()
    f.host.exec.mockImplementation(() => deferred.promise)
    const refresh = f.execution.execute(f.caller, f.input)
    const action = f.execution.execute({ ...f.caller, action: 'action' }, f.input)
    await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledTimes(2))
    f.endDemand()
    expect(await refresh).toMatchObject({
      outcome: 'interrupted-uncertain',
      reason: 'context-ended',
    })
    deferred.resolve(successful)
    expect((await action).outcome).toBe('completed')
  })
  it.each(['revoke', 'disconnect', 'context', 'exit'] as const)(
    'releases caller authority on %s and late transport completion cannot restore output',
    async (event) => {
      const f = fixture(),
        deferred = pending()
      await f.approve()
      f.host.exec.mockImplementation(() => deferred.promise)
      const result = f.execution.execute(f.caller, f.input)
      await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledOnce())
      if (event === 'revoke') await f.approvals.revoke('installation', 'tool')
      else if (event === 'disconnect') f.disconnect()
      else if (event === 'context') f.endContext()
      else f.execution.dispose()
      const interrupted = await result
      expect(interrupted.outcome).toBe('interrupted-uncertain')
      expect(interrupted.receipt).toBeUndefined()
      deferred.resolve(successful)
      await Promise.resolve()
      expect(f.host.exec).toHaveBeenCalledOnce()
    },
  )
  it('reports dispatched failures conservatively without replay, and exit status does not mean domain success', async () => {
    const f = fixture()
    await f.approve()
    f.host.exec.mockRejectedValueOnce(new Error('remote channel failed after execution'))
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'interrupted-uncertain',
      reason: 'transport',
    })
    f.host.exec.mockResolvedValueOnce({ ...successful, code: 23 })
    expect(
      await f.execution.execute({ ...f.caller, action: 'action' }, f.input),
    ).toMatchObject({ outcome: 'completed', code: 23 })
    expect(f.host.exec).toHaveBeenCalledTimes(2)
  })
  it('expires retained pages without prolonging action lifetime', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.approve()
    const result = await f.execution.execute({ ...f.caller, action: 'action' }, f.input)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(() =>
      f.execution.output(
        { ...f.caller, action: 'action' },
        { receipt: result.receipt, stream: 'stdout', offset: 0 },
      ),
    ).toThrow('stale')
  })
  it('times out callers, keeps unsettled native capacity charged, and never hides uncertain effects as not-started', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      deferred = pending()
    await f.approve()
    f.host.exec.mockImplementation(() => deferred.promise)
    const calls = Array.from({ length: 4 }, (_, index) =>
      f.execution.execute({ ...f.caller, action: 'action-' + index }, f.input),
    )
    await vi.advanceTimersByTimeAsync(120_001)
    expect(await Promise.all(calls)).toEqual(
      Array(4).fill(
        expect.objectContaining({ outcome: 'interrupted-uncertain', reason: 'deadline' }),
      ),
    )
    expect(
      await f.execution.execute({ ...f.caller, action: 'new' }, f.input),
    ).toMatchObject({ outcome: 'not-started', reason: 'capacity' })
    deferred.resolve(successful)
    await vi.advanceTimersByTimeAsync(0)
    f.host.exec.mockResolvedValueOnce(successful)
    expect(
      (await f.execution.execute({ ...f.caller, action: 'new' }, f.input)).outcome,
    ).toBe('completed')
  })
})
