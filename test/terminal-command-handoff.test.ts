import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalCommandHandoffOwner,
  type TerminalCommandRequest,
} from '../src/main/terminal/command-handoff-owner'
import { localPath } from '../src/shared/host-path'

afterEach(() => vi.useRealTimers())

function fixture() {
  let request!: TerminalCommandRequest
  const owner = { id: 42, generation: 7 },
    root = localPath('/project')
  const controller = new AbortController(),
    current = vi.fn()
  const handoffs = new TerminalCommandHandoffOwner((_owner, value) => {
    request = value
  })
  const command = {
    executable: '/tool',
    args: ['setup', '', '$(inert)'],
    environment: { TEST: 'configuration' },
  }
  const result = handoffs.request({
    owner,
    workspaceId: 'workspace',
    root,
    command,
    current,
    signal: controller.signal,
  })
  return {
    handoffs,
    owner,
    root,
    controller,
    current,
    command,
    result,
    get request() {
      return request
    },
    consume: () =>
      handoffs.consume(request.ticket, {
        owner,
        terminalId: request.terminalId,
        workspaceId: request.workspaceId,
        root,
      }),
  }
}

describe('terminal command handoff admission', () => {
  it('retains a slow decision within its action lifetime, then expires only the fresh ticket', async () => {
    vi.useFakeTimers()
    let request!: TerminalCommandRequest
    let decide!: (accepted: boolean) => void
    const prepare = new Promise<boolean>((resolve) => {
      decide = resolve
    })
    const published = vi.fn((_owner, value: TerminalCommandRequest) => {
      request = value
    })
    const handoffs = new TerminalCommandHandoffOwner(published)
    const result = handoffs.request({
      owner: { id: 42, generation: 7 },
      workspaceId: 'workspace',
      root: localPath('/project'),
      command: { executable: '/tool', args: [], environment: {} },
      current: () => undefined,
      signal: new AbortController().signal,
      prepare: () => prepare,
      decisionTimeoutMs: 120_000,
    })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(published).not.toHaveBeenCalled()
    decide(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(published).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(() =>
      handoffs.consume('wrong-ticket', {
        owner: { id: 42, generation: 7 },
        terminalId: request.terminalId,
        workspaceId: request.workspaceId,
        root: request.root,
      }),
    ).toThrow('stale')
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({
      outcome: 'not-started',
      reason: 'Terminal admission expired; run this action again',
    })
    expect(() =>
      handoffs.consume(request.ticket, {
        owner: { id: 42, generation: 7 },
        terminalId: request.terminalId,
        workspaceId: request.workspaceId,
        root: request.root,
      }),
    ).toThrow('stale')
    handoffs.dispose()
  })

  it('expires a stalled decision with an actionable refusal and cannot publish its late acceptance', async () => {
    vi.useFakeTimers()
    let decide!: (accepted: boolean) => void
    const prepare = new Promise<boolean>((resolve) => {
        decide = resolve
      }),
      published = vi.fn()
    const handoffs = new TerminalCommandHandoffOwner(published)
    const result = handoffs.request({
      owner: { id: 42, generation: 7 },
      workspaceId: 'workspace',
      root: localPath('/project'),
      command: { executable: '/tool', args: [], environment: {} },
      current: () => undefined,
      signal: new AbortController().signal,
      prepare: () => prepare,
      decisionTimeoutMs: 120_000,
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await result).toMatchObject({
      outcome: 'not-started',
      reason: 'Terminal launch decision expired; run this action again',
    })
    decide(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(published).not.toHaveBeenCalled()
    handoffs.dispose()
  })

  it('issues a new identity, refuses retargeting, and consumes only once', async () => {
    const f = fixture()
    for (const change of [
      { terminalId: 'existing' },
      { workspaceId: 'alias-same-root' },
      { root: localPath('/other') },
      { owner: { id: 42, generation: 8 } },
    ])
      expect(() =>
        f.handoffs.consume(f.request.ticket, {
          owner: f.owner,
          terminalId: f.request.terminalId,
          workspaceId: f.request.workspaceId,
          root: f.root,
          ...change,
        }),
      ).toThrow('stale')
    const admitted = f.consume()
    expect(admitted.command).toEqual(f.command)
    expect(() => f.consume()).toThrow('stale')
    admitted.dispatched()
    admitted.finish(true)
    expect(await f.result).toEqual({
      outcome: 'handed-off',
      terminalId: f.request.terminalId,
    })
    f.controller.abort()
    expect(admitted.signal.aborted).toBe(true)
    expect(() => f.consume()).toThrow('stale')
    f.handoffs.dispose()
  })

  it('reports cancellation before physical dispatch as not started', async () => {
    const f = fixture(),
      admitted = f.consume()
    f.controller.abort()
    expect(await f.result).toMatchObject({ outcome: 'not-started' })
    expect(() => admitted.dispatched()).toThrow()
    admitted.finish(false)
    f.handoffs.dispose()
  })

  it('keeps a lost completion uncertain after physical dispatch', async () => {
    const f = fixture(),
      admitted = f.consume()
    admitted.dispatched()
    f.controller.abort()
    expect(await f.result).toMatchObject({ outcome: 'interrupted-uncertain' })
    admitted.finish(true)
    expect(await f.result).toMatchObject({ outcome: 'interrupted-uncertain' })
    f.handoffs.dispose()
  })

  it('retains all four physical admissions after caller cancellation until actual settlement', async () => {
    const requests: TerminalCommandRequest[] = []
    const handoffs = new TerminalCommandHandoffOwner((_owner, request) =>
      requests.push(request),
    )
    const owner = { id: 42, generation: 7 },
      root = localPath('/project')
    const start = async () => {
      const controller = new AbortController()
      const result = handoffs.request({
        owner,
        workspaceId: 'workspace',
        root,
        command: { executable: '/tool', args: [], environment: {} },
        current: () => undefined,
        signal: controller.signal,
      })
      const request = requests.at(-1)!
      const lease = handoffs.consume(request.ticket, {
        owner,
        terminalId: request.terminalId,
        workspaceId: request.workspaceId,
        root,
      })
      await lease.prepareDispatch()
      lease.dispatched()
      controller.abort()
      return { result, lease }
    }
    const held = await Promise.all(Array.from({ length: 4 }, start))
    for (const entry of held)
      expect(await entry.result).toMatchObject({ outcome: 'interrupted-uncertain' })
    for (let n = 0; n < 8; n++) await expect(start()).rejects.toThrow('unavailable')
    held[0]!.lease.finish(false)
    const replacement = await start()
    // Repeated old settlement cannot release the new admission's capacity.
    held[0]!.lease.finish(false)
    await expect(start()).rejects.toThrow('unavailable')
    handoffs.dispose()
    await expect(start()).rejects.toThrow('unavailable')
    replacement.lease.finish(true)
    expect(await replacement.result).toMatchObject({ outcome: 'interrupted-uncertain' })
    for (const entry of held.slice(1)) entry.lease.finish(false)
  })

  it('settles authority even when renderer revocation delivery fails', async () => {
    let request!: TerminalCommandRequest
    const owner = { id: 42, generation: 7 },
      root = localPath('/project')
    const handoffs = new TerminalCommandHandoffOwner(
      (_owner, value) => {
        request = value
      },
      () => {
        throw new Error('delivery failed')
      },
    )
    const start = () =>
      handoffs.request({
        owner,
        workspaceId: 'workspace',
        root,
        command: { executable: '/tool', args: [], environment: {} },
        current: () => undefined,
        signal: new AbortController().signal,
      })
    const result = start()
    const old = request
    const lease = handoffs.consume(request.ticket, {
      owner,
      terminalId: request.terminalId,
      workspaceId: request.workspaceId,
      root,
    })
    expect(() => lease.finish(false)).toThrow('delivery failed')
    expect(await result).toMatchObject({ outcome: 'not-started' })
    expect(() =>
      handoffs.consume(old.ticket, {
        owner,
        terminalId: old.terminalId,
        workspaceId: old.workspaceId,
        root,
      }),
    ).toThrow('stale')
    expect(() => lease.dispatched()).toThrow('settled')
    lease.finish(false)
    // All capacity is available after the failed notification's physical settlement.
    const replacements = Array.from({ length: 4 }, () => {
      const promise = start()
      const admission = handoffs.consume(request.ticket, {
        owner,
        terminalId: request.terminalId,
        workspaceId: request.workspaceId,
        root,
      })
      return { promise, admission }
    })
    expect(start).toThrow('unavailable')
    for (const replacement of replacements) {
      expect(() => replacement.admission.finish(false)).toThrow('delivery failed')
      expect(await replacement.promise).toMatchObject({ outcome: 'not-started' })
    }
    handoffs.dispose()
  })

  it('revokes consumed admissions on disposal and rejects future admission', async () => {
    const f = fixture(),
      admitted = f.consume()
    f.handoffs.dispose()
    expect(admitted.signal.aborted).toBe(true)
    expect(await f.result).toMatchObject({ outcome: 'not-started' })
    expect(() =>
      f.handoffs.request({
        owner: f.owner,
        workspaceId: 'workspace',
        root: f.root,
        command: f.command,
        current: f.current,
        signal: new AbortController().signal,
      }),
    ).toThrow('unavailable')
    admitted.finish(false)
    f.handoffs.dispose()
  })
})
