// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { TerminalRuntimeRegistry } from '../src/renderer/src/terminal/terminal-runtime-registry'
import { ghosttyLifecycleRuntimeOptions } from './fixtures/ghostty-lifecycle-runtime-options'
import type { StartPtyResponse } from '../src/shared'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'hvir')
  document.body.replaceChildren()
})
const started: Extract<StartPtyResponse, { outcome: 'started' }> = {
  outcome: 'started',
  id: 'terminal-1',
  instanceId: 'initial-instance',
  pid: 123,
  resumed: false,
  reattached: false,
  identityStatus: 'none',
  capabilities: {
    sessionIdentity: 'none',
    exactResume: false,
    contextPresentation: 'none',
  },
}
function fixture(start: () => Promise<StartPtyResponse>) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const events = new Map<string, (event: unknown) => void>()
  const invoke = vi.fn(() => Promise.resolve(started)),
    send = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      send,
      on: (channel: string, listener: (event: unknown) => void) => {
        events.set(channel, listener)
        return () => events.delete(channel)
      },
    },
  })
  const initialStart = { start: vi.fn(start), cancel: vi.fn() }
  const options = {
    ...ghosttyLifecycleRuntimeOptions(),
    supportsResume: false,
    resumeOnStart: false,
    harnessSessionId: undefined,
    initialStart,
    onStartFailed: vi.fn(),
  }
  const registry = new TerminalRuntimeRegistry()
  const runtime = registry.acquire(options)
  const host = document.createElement('div')
  document.body.append(host)
  runtime.attach(host)
  return { registry, runtime, initialStart, invoke, send, events, options }
}

it('uses the one-use start only for the initial handoff and ordinary pty:start after the user restarts an exited terminal', async () => {
  const f = fixture(() => Promise.resolve(started))
  try {
    await vi.waitFor(() => expect(f.options.onStarted).toHaveBeenCalledOnce())
    expect(f.initialStart.start).toHaveBeenCalledOnce()
    expect(f.invoke).not.toHaveBeenCalled()
    f.events.get('pty:exit')?.({ id: started.id, exitCode: 0 })
    expect(f.runtime.snapshot().exited).toBe(true)
    f.runtime.restart()
    await vi.waitFor(() =>
      expect(f.invoke).toHaveBeenCalledWith(
        'pty:start',
        expect.objectContaining({ sessionId: started.id }),
      ),
    )
    expect(f.initialStart.start).toHaveBeenCalledOnce()
  } finally {
    f.registry.dispose()
  }
})

it('does not fall back to a shell on a failed initial handoff and cancels a disposed pending start', async () => {
  let reject!: (reason: Error) => void
  const f = fixture(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  await vi.waitFor(() => expect(f.initialStart.start).toHaveBeenCalledOnce())
  reject(Error('Setup grant revoked'))
  await vi.waitFor(() =>
    expect(f.options.onStartFailed).toHaveBeenCalledWith('Setup grant revoked'),
  )
  expect(f.invoke).not.toHaveBeenCalled()
  f.registry.dispose()
  expect(f.initialStart.cancel).toHaveBeenCalledOnce()

  let finish!: (value: StartPtyResponse) => void
  const pending = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await vi.waitFor(() => expect(pending.initialStart.start).toHaveBeenCalledOnce())
  pending.registry.dispose()
  expect(pending.initialStart.cancel).toHaveBeenCalledOnce()
  finish(started)
  await vi.waitFor(() =>
    expect(pending.send).toHaveBeenCalledWith('pty:kill', { id: started.id }),
  )
  expect(pending.options.onStarted).not.toHaveBeenCalled()
  expect(pending.invoke).not.toHaveBeenCalled()
})
