// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionDialog } from '../src/renderer/src/workspaces/SessionDialog'
import type { SshHostChooserPort } from '../src/renderer/src/workspaces/ssh-configuration-client'
import { localPath } from '../src/shared/host-path'
import type { AddSshHostRequest } from '../src/shared/ssh-configuration'
import type { ProjectHostOption } from '../src/shared/ipc/project'

const local: ProjectHostOption = {
  hostId: 'local',
  label: 'Local',
  kind: 'local',
  connectionState: 'connected',
  watchTier: 'native',
}
const remote = (alias: string): ProjectHostOption => ({
  hostId: alias,
  label: alias,
  kind: 'ssh',
  connectionState: 'disconnected',
  watchTier: 'polling',
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function settle(action: () => unknown): Promise<void> {
  await act(async () => {
    action()
    await Promise.resolve()
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function mount(
  changes: Partial<SshHostChooserPort> = {},
  initialHosts: readonly ProjectHostOption[] = [local],
) {
  const port: SshHostChooserPort = {
    snapshot: () => Promise.resolve(initialHosts),
    defaults: vi.fn(() => Promise.resolve({ username: 'picard', port: 22 })),
    refresh: vi.fn(() => Promise.resolve(initialHosts)),
    save: vi.fn((fields: AddSshHostRequest) =>
      Promise.resolve([local, remote(fields.alias)]),
    ),
    pickIdentity: vi.fn(() => Promise.resolve(localPath('/keys/work key'))),
    ...changes,
  }
  let catalogSnapshot = initialHosts
  const snapshot = changes.snapshot ?? (() => Promise.resolve(catalogSnapshot))
  const refreshEffect = port.refresh
  const saveEffect = port.save
  const wrapped: SshHostChooserPort = {
    ...port,
    snapshot,
    refresh: async () => {
      const next = await refreshEffect()
      catalogSnapshot = next
      return next
    },
    save: async (fields) => {
      const next = await saveEffect(fields)
      catalogSnapshot = next
      return next
    },
  }
  const onCancel = vi.fn()
  const onConnect = vi.fn(() =>
    Promise.reject(new Error('Remote is offline; retry Connect')),
  )
  await settle(() =>
    root.render(
      <SessionDialog
        hosts={initialHosts}
        sshConfiguration={wrapped}
        currentRoot={localPath('/project')}
        suspended={false}
        onCancel={onCancel}
        onConnect={onConnect}
        onBrowse={() => Promise.resolve({ path: localPath('/'), directories: [] })}
        folderPicker={{
          start: () => Promise.resolve({ pickerId: 'picker' }),
          browse: () => Promise.resolve({ path: localPath('/'), directories: [] }),
          createDirectory: () => Promise.resolve(localPath('/created')),
          close: () => Promise.resolve(),
        }}
        onDisconnect={() => Promise.resolve(local)}
        onOpen={() => Promise.reject(new Error('Unexpected open'))}
        onOpened={vi.fn()}
      />,
    ),
  )
  return { port, onCancel, onConnect }
}

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text,
  )
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}
async function click(text: string) {
  await settle(() => button(text).click())
}
function input(label: string): HTMLInputElement {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!field) throw new Error(`Missing field ${label}`)
  return field
}
function change(label: string, value: string) {
  act(() => {
    const field = input(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field,
      value,
    )
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function fill() {
  await click('Add SSH host')
  change('SSH alias', 'added')
  change('Hostname or IP address', 'new.example.test')
}
function selected() {
  return container.querySelector('[role="option"][aria-selected="true"]')?.textContent
}

async function submit() {
  await settle(() =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
}

describe('SSH host chooser', () => {
  it('defaults to the local username and port, supports options, and cancels without writing', async () => {
    const { port, onCancel } = await mount()
    await fill()
    expect(input('Username').value).toBe('picard')
    expect(input('Port').value).toBe('22')
    expect(document.activeElement).toBe(input('SSH alias'))
    await click('Choose identity file…')
    expect(container.textContent).toContain('/keys/work key')
    await click('Clear')
    expect(container.textContent).toContain('Use existing authentication defaults')
    await settle(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(container.querySelector('form')).toBeNull()
    expect(port.save).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('saves fields, selects the returned alias, expires feedback at four seconds, and keeps offline hosts for retry', async () => {
    vi.useFakeTimers()
    const { port, onConnect } = await mount()
    await fill()
    change('Port', '2222')
    await click('Choose identity file…')
    await submit()
    expect(port.save).toHaveBeenCalledWith({
      alias: 'added',
      hostname: 'new.example.test',
      username: 'picard',
      port: 2222,
      identityFile: localPath('/keys/work key'),
    })
    expect(onConnect).not.toHaveBeenCalled()
    expect(selected()).toContain('added')
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Saved to ~/.ssh/config',
    )
    await settle(() => vi.advanceTimersByTime(3999))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    await settle(() => vi.advanceTimersByTime(1))
    expect(container.querySelector('[role="status"]')).toBeNull()
    await click('Connect')
    expect(onConnect).toHaveBeenCalledWith('added')
    expect(container.textContent).toContain('Remote is offline; retry Connect')
    expect(selected()).toContain('added')
    expect(button('Connect').disabled).toBe(false)
  })

  it('retains fields and exposes validation/save failure for correction', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSH alias already exists'))
      .mockResolvedValue([local, remote('corrected')])
    await mount({ save })
    await fill()
    await submit()
    expect(input('SSH alias').value).toBe('added')
    expect(input('Hostname or IP address').value).toBe('new.example.test')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'already exists',
    )
    change('SSH alias', 'corrected')
    await submit()
    expect(selected()).toContain('corrected')
  })

  it('refreshes on open/focus, preserves selection, and retains its usable list on failure', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce([local, remote('existing')])
      .mockResolvedValueOnce([local, remote('existing'), remote('external')])
      .mockRejectedValueOnce(new Error('Permission denied'))
    const { port } = await mount({ refresh })
    expect(port.refresh).toHaveBeenCalledOnce()
    await settle(() =>
      container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]!.click(),
    )
    await settle(() => window.dispatchEvent(new Event('focus')))
    expect(container.textContent).toContain('external')
    expect(selected()).toContain('existing')
    await settle(() => window.dispatchEvent(new Event('focus')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Permission denied',
    )
    expect(container.textContent).toContain('external')
    expect(selected()).toContain('existing')
  })

  it('restores the main catalog snapshot when a newly opened chooser cannot refresh', async () => {
    await mount({
      snapshot: () => Promise.resolve([local, remote('cached')]),
      refresh: () => Promise.reject(new Error('Config is unreadable')),
    })
    expect(container.textContent).toContain('cached')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Config is unreadable',
    )
  })

  it('rejects superseded refresh results and keeps a saved alias selected', async () => {
    const old = deferred<readonly ProjectHostOption[]>()
    const recent = deferred<readonly ProjectHostOption[]>()
    const refresh = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(recent.promise)
    await mount({ refresh })
    await settle(() => window.dispatchEvent(new Event('focus')))
    await settle(() => Promise.resolve())
    await settle(() => recent.resolve([local, remote('external')]))
    await settle(() => old.resolve([local, remote('stale')]))
    expect(container.textContent).toContain('external')
    expect(container.textContent).not.toContain('stale')
    await fill()
    await submit()
    expect(selected()).toContain('added')
  })

  it('ignores refresh, defaults and save delivery after dismissal and releases listeners/timers', async () => {
    vi.useFakeTimers()
    const refresh = deferred<readonly ProjectHostOption[]>()
    const defaults = deferred<{ username: string; port: number }>()
    const save = deferred<readonly ProjectHostOption[]>()
    const { port } = await mount({
      refresh: vi.fn(() => refresh.promise),
      defaults: () => defaults.promise,
      save: () => save.promise,
    })
    await fill()
    change('Username', 'riker')
    await submit()
    await settle(() => root.render(null))
    await settle(() => {
      defaults.resolve({ username: 'late', port: 22 })
      save.resolve([local, remote('added')])
      refresh.resolve([local, remote('late')])
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.textContent).toBe('')
    expect(port.refresh).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a running feedback timer when the chooser closes', async () => {
    vi.useFakeTimers()
    await mount()
    await fill()
    await submit()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await settle(() => root.render(null))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects defaults from a cancelled form when another form starts', async () => {
    const old = deferred<{ username: string; port: number }>()
    const defaults = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ username: 'current', port: 22 })
    await mount({ defaults })
    await fill()
    await click('Cancel')
    await fill()
    await settle(() => old.resolve({ username: 'stale', port: 22 }))
    expect(input('Username').value).toBe('current')
  })
})
