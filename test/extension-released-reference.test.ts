import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ExtensionActionOwner,
  type ExtensionActionGuestPort,
} from '../src/main/extensions/action-owner'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { releasedExtension } from './fixtures/released-extension'
import { connectorFixture } from './fixtures/extension-connector'

afterEach(() => vi.useRealTimers())

function releasedGuest(
  send: (message: {
    kind: string
    id?: string
    capability?: string
    input?: unknown
    value?: unknown
  }) => void,
) {
  const listeners = new Set<(message: unknown) => void>()
  const handlers = new Map<string, Map<string, () => void | Promise<void>>>()
  const elements = new Map(
    [
      'status',
      'open-detail',
      'mark-session',
      'native-run',
      'native-next',
      'native-status',
      'native-output',
      'native-args',
    ].map((id) => [
      id,
      {
        textContent: '',
        disabled: false,
        value: '["--version"]',
        addEventListener: (event: string, handler: () => void | Promise<void>) => {
          const events = handlers.get(id) ?? new Map<string, () => void | Promise<void>>()
          events.set(event, handler)
          handlers.set(id, events)
        },
        removeEventListener: (event: string) => handlers.get(id)?.delete(event),
      },
    ]),
  )
  const events = new Map<string, () => void>()
  const bridge = {
    send,
    onMessage: (callback: (message: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
  runInNewContext(
    readFileSync('test/fixtures/extensions/0.3.0/reference/reference.js', 'utf8'),
    {
      window: {
        hvirExtension: bridge,
        hvirUI: { bindPresentation: () => () => undefined },
        setTimeout,
        clearTimeout,
        addEventListener: (name: string, callback: () => void) =>
          events.set(name, callback),
        removeEventListener: (name: string) => events.delete(name),
      },
      document: { getElementById: (id: string) => elements.get(id) },
      Date,
    },
  )
  return {
    emit: (message: unknown) => {
      for (const callback of listeners) callback(message)
    },
    click: (id: string) => handlers.get(id)?.get('click')?.(),
    element: (id: string) => elements.get(id)!,
    close: () => events.get('pagehide')?.(),
    listeners,
  }
}

it.each(['describe-session', 'preview-replacement'])(
  'completes released %s with actual main action provenance and cancels late results on close',
  async (action) => {
    vi.useFakeTimers()
    const revision = releasedExtension('reference')
    const activation = { installationId: 'released', generation: 'current', revision }
    const view = {
      id: 'view',
      installationId: 'released',
      contributionId: 'detail',
      title: 'Detail',
      extensionName: 'Reference',
      partition: 'partition',
      url: 'hvir-extension://view/detail.html',
      context: {
        surface: 'viewer',
        visible: true,
        session: { id: 'exact-session', title: 'Session' },
      },
    } as ExtensionView
    const ports: ExtensionActionGuestPort = {
      open: (_owner, _id, _view, _options, admit) => {
        admit()
        return Promise.resolve(view)
      },
      dispatch: (_view, invocation: ExtensionInvocation) => {
        guest.emit({ kind: 'action', invocation })
        return true
      },
      runnable: vi.fn(),
      cancelAction: vi.fn(),
      assertView: () => undefined,
    }
    const actions = new ExtensionActionOwner(ports)
    const results = vi.fn()
    const guest = releasedGuest((message) => {
      if (message.kind === 'action-result') {
        results(message.value)
        actions.result(view.id, message.id!, message.value)
      }
    })
    try {
      const result = actions.invoke(
        { id: 1, generation: 1 },
        activation,
        action,
        { delayMs: 500 },
        { surface: 'viewer', sessionId: 'exact-session' },
        'agent',
        'standing',
        () => undefined,
      )
      await vi.advanceTimersByTimeAsync(500)
      await expect(result).resolves.toEqual({
        session: 'exact-session',
        caller: 'agent',
        ...(action === 'preview-replacement'
          ? { previewOnly: true, changedFiles: 0 }
          : {}),
      })
      expect(results).toHaveBeenCalledOnce()
      const pending = actions.invoke(
        { id: 1, generation: 1 },
        activation,
        action,
        { delayMs: 500 },
        { surface: 'viewer' },
        'guest',
        'unapproved',
        () => undefined,
      )
      const rejected = expect(pending).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(0)
      guest.close()
      actions.revokeView(view.id)
      await rejected
      await vi.advanceTimersByTimeAsync(1000)
      expect(results).toHaveBeenCalledOnce()
      expect(guest.listeners.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      guest.close()
      actions.revokeView(view.id)
    }
  },
)

it('released controls gate optional native access, consume real approved execution/output, and retain exact session/view requests', async () => {
  const native = connectorFixture(
    'application',
    undefined,
    undefined,
    releasedExtension('reference'),
  )
  await native.approvals.start()
  const approval = await native.approvals.prepare(
    {
      installationId: 'installation',
      connector: 'installed-tool',
      host: 'local',
      executable: '/installed/tool',
      configuration: { args: [], env: {} },
    },
    () => undefined,
  )
  await native.approvals.approve(approval.token)
  const controls: unknown[] = []
  const guest = releasedGuest((message) => {
    if (message.kind !== 'request') return
    if (
      message.capability === 'connector.execute' ||
      message.capability === 'connector.output'
    ) {
      const operation =
        message.capability === 'connector.execute'
          ? native.execution.execute(native.caller, message.input)
          : Promise.resolve(native.execution.output(native.caller, message.input))
      void operation.then((value) =>
        guest.emit({ kind: 'result', id: message.id, ok: true, value }),
      )
    } else controls.push(message)
  })
  try {
    guest.emit({ kind: 'hello', contract: '1.0', capabilities: ['viewer.open-own'] })
    expect(guest.element('native-run').disabled).toBe(true)
    guest.emit({
      kind: 'hello',
      contract: '1.0',
      capabilities: ['viewer.open-own', 'connector.execute', 'connector.output'],
    })
    expect(guest.element('native-run').disabled).toBe(false)
    guest.emit({
      kind: 'context',
      context: { visible: true, session: { id: 'exact-session' } },
    })
    await guest.click('open-detail')
    await guest.click('mark-session')
    expect(controls).toMatchObject([
      { capability: 'viewer.open-own', input: { contributionId: 'detail' } },
      {
        capability: 'contributions.publish',
        input: { session: 'exact-session', item: 'session', label: 'Marked' },
      },
    ])
    await guest.click('native-run')
    await vi.waitFor(() =>
      expect(guest.element('native-status').textContent).toContain('completed'),
    )
    expect(native.finiteExec.tryExec).toHaveBeenCalledWith(
      '/installed/tool',
      ['--version'],
      expect.any(Object),
    )
    expect(guest.element('native-status').textContent).toContain('completed')
    expect(guest.element('native-output').textContent).toBe('result')
    await native.approvals.revoke('installation', 'installed-tool')
    await guest.click('native-run')
    await vi.waitFor(() =>
      expect(guest.element('native-status').textContent).toContain('unapproved'),
    )
    expect(native.finiteExec.tryExec).toHaveBeenCalledTimes(1)
    expect(guest.element('native-status').textContent).not.toContain('completed')
    guest.close()
    expect(guest.listeners.size).toBe(0)
  } finally {
    guest.close()
    native.dispose()
  }
})
