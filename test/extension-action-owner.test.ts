import { describe, expect, it, vi } from 'vitest'
import {
  ExtensionActionOwner,
  type ExtensionActionGuestPort,
} from '../src/main/extensions/action-owner'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'
import type { ExtensionView } from '../src/shared/extensions/workbench'

function fixture() {
  const revision = validateCapturedExtension({
    sourceIdentity: '1:1',
    files: new Map([
      [
        'hvir-extension.json',
        new TextEncoder().encode(
          JSON.stringify(
            exampleManifest({
              actions: [
                {
                  id: 'describe',
                  title: 'Describe',
                  view: 'detail',
                  agents: true,
                  effects: { delete: false, replace: false },
                },
              ],
            }),
          ),
        ),
      ],
      ['index.html', new Uint8Array()],
      ['detail.html', new Uint8Array()],
    ]),
  })
  const activation = { installationId: 'one', generation: 'first', revision }
  const view: ExtensionView = {
    id: 'view',
    installationId: 'one',
    contributionId: 'detail',
    title: 'Detail',
    extensionName: 'Example',
    partition: 'partition',
    url: 'hvir-extension://view/detail.html',
    context: { surface: 'viewer', visible: true },
  }
  const ports: ExtensionActionGuestPort = {
    open: vi.fn<ExtensionActionGuestPort['open']>(
      (_owner, _id, _view, _options, admit) => {
        admit()
        return Promise.resolve(view)
      },
    ),
    dispatch: vi.fn(() => true),
    runnable: vi.fn(),
    cancelAction: vi.fn(),
    assertView: vi.fn(),
  }
  const actions = new ExtensionActionOwner(ports)
  const owner = { id: 1, generation: 1 }
  return { actions, ports, activation, owner, view }
}

describe('finite named extension actions', () => {
  it('opens visibly without focus and preserves caller/context with exactly one delivery', async () => {
    const data = fixture()
    let ready = false
    vi.mocked(data.ports.dispatch).mockImplementation(() => ready)
    const result = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      { selected: 'pinned' },
      { surface: 'viewer' },
      'agent',
      'standing',
      () => undefined,
    )
    await Promise.resolve()
    expect(data.ports.open).toHaveBeenCalledWith(
      data.owner,
      'one',
      'detail',
      { context: { surface: 'viewer' }, focus: false },
      expect.any(Function),
    )
    ready = true
    data.actions.ready('view')
    data.actions.ready('view')
    const invocation = vi.mocked(data.ports.dispatch).mock.calls.at(-1)![1]
    expect(invocation).toMatchObject({
      caller: 'agent',
      authorization: 'standing',
      input: { selected: 'pinned' },
    })
    expect(data.ports.dispatch).toHaveBeenCalledTimes(2) // one not-yet-negotiated attempt, one delivery
    expect(() => data.actions.result('foreign', invocation.id, null)).toThrow(
      'stale or forged',
    )
    data.actions.result('view', invocation.id, { done: true })
    await expect(result).resolves.toEqual({ done: true })
    data.actions.ready('view')
    expect(data.ports.dispatch).toHaveBeenCalledTimes(2)
  })

  it('starts its finite deadline before opening and rejects late admission', async () => {
    vi.useFakeTimers()
    try {
      const data = fixture()
      let finish!: () => void
      const waiting = new Promise<void>((resolve) => {
        finish = resolve
      })
      vi.mocked(data.ports.open).mockImplementation(
        async (_owner, _id, _view, _options, admit) => {
          await waiting
          admit()
          return data.view
        },
      )
      const result = data.actions.invoke(
        data.owner,
        data.activation,
        'describe',
        null,
        { surface: 'viewer' },
        'human',
        'interactive',
        () => undefined,
      )
      const rejected = expect(result).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(120_001)
      await rejected
      finish()
      await Promise.resolve()
      await Promise.resolve()
      expect(data.ports.dispatch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserves per-activation opening slots while unrelated installations keep capacity', async () => {
    const data = fixture()
    vi.mocked(data.ports.open).mockImplementation(() => new Promise(() => undefined))
    const requests = Array.from({ length: 4 }, () =>
      data.actions
        .invoke(
          data.owner,
          data.activation,
          'describe',
          null,
          { surface: 'viewer' },
          'human',
          'interactive',
          () => undefined,
        )
        .catch(() => null),
    )
    expect(() =>
      data.actions.invoke(
        data.owner,
        data.activation,
        'describe',
        null,
        { surface: 'viewer' },
        'human',
        'interactive',
        () => undefined,
      ),
    ).toThrow('capacity')
    const other = { ...data.activation, installationId: 'two', generation: 'other' }
    requests.push(
      data.actions
        .invoke(
          data.owner,
          other,
          'describe',
          null,
          { surface: 'viewer' },
          'human',
          'interactive',
          () => undefined,
        )
        .catch(() => null),
    )
    data.actions.revokeInstallation(data.activation)
    data.actions.revokeInstallation(other)
    await Promise.all(requests)
  })

  it('cancels opening on context revocation and finite hidden work on explicit close', async () => {
    const data = fixture()
    let current = true
    const result = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      null,
      { surface: 'viewer' },
      'human',
      'interactive',
      () => {
        if (!current) throw new Error('context ended')
      },
    )
    await Promise.resolve()
    const invocation = vi.mocked(data.ports.dispatch).mock.calls[0]![1]
    expect(data.actions.provenance('view', invocation.id)?.caller).toBe('human')
    current = false
    data.actions.revalidate()
    await expect(result).rejects.toThrow('context ended')
    expect(data.ports.cancelAction).toHaveBeenCalledWith('view', invocation.id)
    expect(data.ports.runnable).toHaveBeenLastCalledWith('view', invocation.id, false)
  })
  it('readiness expires only its invalid invocation while a current sibling is delivered', async () => {
    const data = fixture()
    let current = true
    vi.mocked(data.ports.dispatch).mockReturnValue(false)
    const expired = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      null,
      { surface: 'viewer' },
      'agent',
      'standing',
      () => {
        if (!current) throw new Error('authority expired')
      },
    )
    const rejected = expect(expired).rejects.toThrow('authority expired')
    const sibling = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      'sibling',
      { surface: 'viewer' },
      'human',
      'interactive',
      () => undefined,
    )
    await Promise.resolve()
    current = false
    vi.mocked(data.ports.dispatch).mockReturnValue(true)
    expect(() => data.actions.ready('view')).not.toThrow()
    await rejected
    const invocation = vi.mocked(data.ports.dispatch).mock.calls.at(-1)![1]
    expect(invocation.input).toBe('sibling')
    data.actions.result('view', invocation.id, 'done')
    await expect(sibling).resolves.toBe('done')
  })

  it('does not admit a child opening after its parent provenance expires', async () => {
    const data = fixture()
    const parent = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      null,
      { surface: 'viewer' },
      'agent',
      'standing',
      () => undefined,
    )
    await Promise.resolve()
    const invocation = vi.mocked(data.ports.dispatch).mock.calls[0]![1]
    let finish!: () => void
    const opening = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.mocked(data.ports.open).mockImplementation(
      async (_owner, _id, _view, _options, admit) => {
        await opening
        admit()
        return data.view
      },
    )
    const child = data.actions.invoke(
      data.owner,
      data.activation,
      'describe',
      null,
      { surface: 'viewer' },
      invocation.caller,
      invocation.authorization,
      () => {
        if (!data.actions.provenance('view', invocation.id))
          throw new Error('parent expired')
      },
    )
    const rejected = expect(child).rejects.toThrow('parent expired')
    data.actions.result('view', invocation.id, 'done')
    await parent
    await rejected
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(data.ports.dispatch).toHaveBeenCalledTimes(1)
  })

  it('bounds application opening capacity and releases cancelled admission slots', async () => {
    const data = fixture()
    vi.mocked(data.ports.open).mockImplementation(() => new Promise(() => undefined))
    const activations = Array.from({ length: 5 }, (_, index) => ({
      ...data.activation,
      installationId: String(index),
      generation: String(index),
    }))
    const controllers = Array.from({ length: 16 }, () => new AbortController())
    const pending = controllers.map((controller, index) =>
      data.actions
        .invoke(
          data.owner,
          activations[Math.floor(index / 4)]!,
          'describe',
          null,
          { surface: 'viewer' },
          'human',
          'interactive',
          () => undefined,
          controller.signal,
        )
        .catch(() => null),
    )
    expect(() =>
      data.actions.invoke(
        data.owner,
        activations[4]!,
        'describe',
        null,
        { surface: 'viewer' },
        'human',
        'interactive',
        () => undefined,
      ),
    ).toThrow('capacity')
    controllers[0]!.abort()
    pending.push(
      data.actions
        .invoke(
          data.owner,
          activations[4]!,
          'describe',
          null,
          { surface: 'viewer' },
          'human',
          'interactive',
          () => undefined,
        )
        .catch(() => null),
    )
    for (const activation of activations) data.actions.revokeInstallation(activation)
    await Promise.all(pending)
    expect(data.ports.dispatch).not.toHaveBeenCalled()
  })
})
