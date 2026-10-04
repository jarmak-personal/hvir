import { describe, expect, it, vi } from 'vitest'
import {
  TerminalCommandHandoffOwner,
  type TerminalCommandRequest,
} from '../src/main/terminal/command-handoff-owner'
import { createPtySupervisorFixture } from './fixtures/pty-supervisor-fixture'

function held() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function fixture(revalidate?: () => Promise<void>) {
  const f = createPtySupervisorFixture()
  const controller = new AbortController()
  let request!: TerminalCommandRequest
  const owner = { id: 17, generation: 0 }
  const handoffs = new TerminalCommandHandoffOwner((_owner, value) => {
    request = value
  })
  const result = handoffs.request({
    owner,
    workspaceId: 'workspace',
    root: f.root,
    command: { executable: '/tool', args: ['setup'], environment: {} },
    current: () => undefined,
    signal: controller.signal,
    revalidate,
  })
  const lease = handoffs.consume(request.ticket, {
    owner,
    terminalId: request.terminalId,
    workspaceId: request.workspaceId,
    root: f.root,
  })
  const start = async () => {
    let transferred = false
    try {
      const managed = await f.spawn({
        sessionId: request.terminalId,
        signal: lease.signal,
        beforeDispatch: lease.prepareDispatch,
        onDispatch: lease.dispatched,
      })
      lease.current()
      transferred = true
      return managed
    } finally {
      lease.finish(transferred)
    }
  }
  return { f, controller, handoffs, result, start }
}

describe('command handoff at the physical PTY boundary', () => {
  it.each(['default-shell', 'agent-environment', 'final-revalidation'] as const)(
    'prevents physical dispatch after cancellation during %s',
    async (boundary) => {
      const gate = held(),
        entered = vi.fn()
      const inspect = async () => {
        entered()
        await gate.promise
      }
      const value = fixture(boundary === 'final-revalidation' ? inspect : undefined)
      if (boundary === 'default-shell')
        value.f.defaultShell.mockImplementationOnce(async () => {
          await inspect()
          return '/bin/sh'
        })
      const environment = vi.fn(async () => {
        if (boundary === 'agent-environment') await inspect()
        return { env: {} }
      })
      value.f.supervisor.agentEnvironment(environment)
      const starting = value.start()
      const rejected = expect(starting).rejects.toThrow()
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      value.controller.abort()
      expect(await value.result).toMatchObject({ outcome: 'not-started' })
      expect(value.f.snapshot().spawns).toHaveLength(0)
      gate.release()
      await rejected
      expect(value.f.snapshot().spawns).toHaveLength(0)
      if (boundary === 'default-shell') expect(environment).not.toHaveBeenCalled()
      value.handoffs.dispose()
    },
  )

  it('reports in-flight physical execution as uncertain and kills late completion', async () => {
    const value = fixture(),
      physical = value.f.deferNextSpawn()
    const starting = value.start()
    const rejected = expect(starting).rejects.toThrow()
    await vi.waitFor(() => expect(value.f.snapshot().spawns).toHaveLength(1))
    value.controller.abort()
    expect(await value.result).toMatchObject({ outcome: 'interrupted-uncertain' })
    physical.resolve()
    await rejected
    expect(physical.pty.kill).toHaveBeenCalledOnce()
    expect(value.f.supervisor.list()).toEqual([])
    value.handoffs.dispose()
  })

  it('leaves an ordinary terminal alive after the handoff when its invocation is revoked', async () => {
    const value = fixture()
    const managed = await value.start()
    expect(await value.result).toMatchObject({ outcome: 'handed-off' })
    value.controller.abort()
    value.handoffs.dispose()
    expect(value.f.supervisor.get(managed.id)).toBeDefined()
    expect(value.f.pty.kill).not.toHaveBeenCalled()
  })
})
