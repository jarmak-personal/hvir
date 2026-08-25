// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionDialog } from '../src/renderer/src/workspaces/SessionDialog'
import {
  asHostId,
  hostPath,
  type BrowseHostResponse,
  type ConnectedHost,
  type DirEntry,
  type HostPath,
  type ProjectHostOption,
  type ProjectState,
} from '../src/shared'
import type { ProjectFolderPickerPort } from '../src/renderer/src/workspaces/project-folder-picker-client'

const localHost: ProjectHostOption = {
  hostId: 'local',
  label: 'Local',
  kind: 'local',
  connectionState: 'connected',
  watchTier: 'native',
}

const sshHost: ProjectHostOption = {
  hostId: 'ssh-dev',
  label: 'dev',
  kind: 'ssh',
  connectionState: 'connected',
  watchTier: 'polling',
}

const directoryChildren: Readonly<Record<string, readonly string[]>> = {
  '/': ['projects', 'srv'],
  '/projects': ['initial', 'other', 'recent', 'tree', 'typed'],
  '/srv': ['initial', 'recent', 'tree', 'typed'],
}

const frameCallbacks = new Map<number, FrameRequestCallback>()
const scrollIntoView = vi.fn()
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
)
let nextFrame = 1
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  frameCallbacks.clear()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frameCallbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameCallbacks.delete(id)
  })
  scrollIntoView.mockReset()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('SessionDialog folder selection', () => {
  it('reveals initial and typed paths while keeping confirmation separate from Enter', async () => {
    const onBrowse = vi.fn((hostId: string, path: string) =>
      Promise.resolve(browseResponse(hostId, path)),
    )
    const onOpen = vi.fn((hostId: string, path: string) =>
      Promise.resolve(projectState(hostId, path)),
    )
    const onOpened = vi.fn()
    renderDialog({
      currentHost: localHost,
      suggestedPath: '/projects/initial',
      onBrowse,
      onOpen,
      onOpened,
    })

    await chooseFolder()
    await waitFor(() => selectedRow('/projects/initial') !== undefined)

    const input = pathInput()
    const show = button('Show in tree')
    const use = button('Use this folder')
    expect(input.value).toBe('/projects/initial')
    expect(document.activeElement).toBe(input)
    expect(use.disabled).toBe(false)
    expect(show.closest('form')).toBe(input.closest('form'))
    expect(use.closest('form')).toBe(input.closest('form'))
    expect(buttonOrUndefined('Open selected folder')).toBeUndefined()
    expect(scrollIntoView.mock.instances).toContain(selectedRow('/projects/initial'))

    changeInput('/projects/typed')
    expect(use.disabled).toBe(true)
    submitPathForm()
    await waitFor(() => selectedRow('/projects/typed') !== undefined)

    expect(onBrowse).toHaveBeenCalledWith('local', '/projects/typed')
    expect(onOpen).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
    expect(scrollIntoView.mock.instances).toContain(selectedRow('/projects/typed'))

    changeInput('/projects/other')
    await clickButton('Show in tree')
    await waitFor(() => selectedRow('/projects/other') !== undefined)
    expect(onBrowse).toHaveBeenCalledWith('local', '/projects/other')
    expect(onOpen).not.toHaveBeenCalled()

    await clickButton('Use this folder')
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith('local', '/projects/other')
    expect(onOpened).toHaveBeenCalledOnce()
  })

  it.each([
    ['local', localHost, '/projects/initial', '/projects/missing'],
    ['SSH', sshHost, '/srv/initial', '/srv/missing'],
  ])(
    'disables interaction while resolving and rejects an invalid path on the %s host',
    async (_label, currentHost, suggestedPath, missingPath) => {
      let rejectMissing!: (reason: Error) => void
      const missing = new Promise<BrowseHostResponse>((_resolve, reject) => {
        rejectMissing = reject
      })
      const onBrowse = vi.fn((hostId: string, path: string) =>
        path === missingPath ? missing : Promise.resolve(browseResponse(hostId, path)),
      )
      const onOpen = vi.fn((hostId: string, path: string) =>
        Promise.resolve(projectState(hostId, path)),
      )
      renderDialog({ currentHost, suggestedPath, onBrowse, onOpen })

      await chooseFolder()
      await waitFor(() => selectedRow(suggestedPath) !== undefined)
      changeInput(missingPath)
      submitPathForm()

      expect(pathInput().disabled).toBe(true)
      expect(button('Show in tree').disabled).toBe(true)
      expect(button('Use this folder').disabled).toBe(true)

      await act(async () => {
        rejectMissing(new Error(`Folder not found: ${missingPath}`))
        await Promise.resolve()
      })
      await waitFor(
        () => document.body.textContent?.includes('Folder not found') === true,
      )

      expect(pathInput().value).toBe(missingPath)
      expect(pathInput().disabled).toBe(false)
      expect(document.activeElement).toBe(pathInput())
      expect(button('Use this folder').disabled).toBe(true)
      expect(selectedRow(suggestedPath)).toBeUndefined()
      expect(onBrowse).toHaveBeenCalledWith(currentHost.hostId, missingPath)
      expect(onOpen).not.toHaveBeenCalled()
    },
  )

  it('keeps recent, typed, and tree selections qualified to the connected SSH host', async () => {
    localStorage.setItem('hvir:recent-folders:ssh-dev', JSON.stringify(['/srv/recent']))
    const onBrowse = vi.fn((hostId: string, path: string) =>
      Promise.resolve(browseResponse(hostId, path)),
    )
    const onOpen = vi.fn((hostId: string, path: string) =>
      Promise.resolve(projectState(hostId, path)),
    )
    const onOpened = vi.fn()
    renderDialog({
      currentHost: sshHost,
      suggestedPath: '/srv/initial',
      onBrowse,
      onOpen,
      onOpened,
    })

    await chooseFolder()
    await waitFor(() => selectedRow('/srv/initial') !== undefined)

    await clickButton('/srv/recent')
    await waitFor(() => selectedRow('/srv/recent') !== undefined)
    expect(pathInput().value).toBe('/srv/recent')

    changeInput('/srv/typed')
    await clickButton('Show in tree')
    await waitFor(() => selectedRow('/srv/typed') !== undefined)

    act(() => directoryRow('/srv/tree')?.click())
    await waitFor(() => selectedRow('/srv/tree') !== undefined)
    expect(pathInput().value).toBe('/srv/tree')

    expect(onBrowse.mock.calls.every(([hostId]) => hostId === 'ssh-dev')).toBe(true)
    await clickButton('Use this folder')
    expect(onOpen).toHaveBeenCalledWith('ssh-dev', '/srv/tree')
    expect(onOpened).toHaveBeenCalledOnce()
  })

  it('uses ordinary browsing for the tree and picker authority for selection', async () => {
    const onBrowse = vi.fn((hostId: string, path: string) =>
      Promise.resolve(browseResponse(hostId, path)),
    )
    const onPickerBrowse = vi.fn((_pickerId: string, path: string) =>
      Promise.resolve(browseResponse('local', path)),
    )
    renderDialog({
      currentHost: localHost,
      suggestedPath: '/projects/initial',
      onBrowse,
      onPickerBrowse,
      onOpen: (hostId, path) => Promise.resolve(projectState(hostId, path)),
    })

    await chooseFolder()
    await waitFor(() => selectedRow('/projects/initial') !== undefined)
    expect(onBrowse).toHaveBeenCalledWith('local', '/')
    expect(onBrowse).toHaveBeenCalledWith('local', '/projects')
    expect(onPickerBrowse).toHaveBeenCalledWith('picker-1', '/projects/initial')
    expect(onPickerBrowse).not.toHaveBeenCalledWith('picker-1', '/')

    onBrowse.mockClear()
    onPickerBrowse.mockClear()
    act(() => directoryRow('/projects/tree')?.click())
    await waitFor(() => selectedRow('/projects/tree') !== undefined)

    expect(onPickerBrowse).toHaveBeenCalledExactlyOnceWith(
      'picker-1',
      '/projects/tree',
    )
    expect(onBrowse).toHaveBeenCalledExactlyOnceWith('local', '/projects/tree')
  })

  it.each([
    ['local', localHost, '/projects/initial'],
    ['SSH', sshHost, '/srv/initial'],
  ])(
    'creates, reveals, selects, and opens a folder on the %s host',
    async (_label, currentHost, suggestedPath) => {
      let createdName: string | undefined
      const onBrowse = vi.fn((hostId: string, path: string) => {
        const response = browseResponse(hostId, path)
        return Promise.resolve(
          path === suggestedPath && createdName
            ? {
                ...response,
                directories: [
                  ...response.directories,
                  { name: createdName, type: 'dir' as const },
                ],
              }
            : response,
        )
      })
      const onCreateDirectory = vi.fn(
        (_pickerId: string, parent: HostPath, name: string) => {
          createdName = name
          return Promise.resolve(hostPath(parent.hostId, `${parent.path}/${name}`))
        },
      )
      const onOpen = vi.fn((hostId: string, path: string) =>
        Promise.resolve(projectState(hostId, path)),
      )
      renderDialog({
        currentHost,
        suggestedPath,
        onBrowse,
        onCreateDirectory,
        onOpen,
      })

      await chooseFolder()
      await waitFor(() => selectedRow(suggestedPath) !== undefined)
      await clickButton('New folder')
      expect(button('Create').disabled).toBe(true)
      changeNamedInput('New folder name', 'new-project')
      await clickButton('Create')
      await waitFor(() => selectedRow(`${suggestedPath}/new-project`) !== undefined)

      expect(onCreateDirectory).toHaveBeenCalledWith(
        'picker-1',
        hostPath(asHostId(currentHost.hostId), suggestedPath),
        'new-project',
      )
      expect(pathInput().value).toBe(`${suggestedPath}/new-project`)
      await clickButton('Use this folder')
      expect(onOpen).toHaveBeenCalledWith(
        currentHost.hostId,
        `${suggestedPath}/new-project`,
      )
    },
  )

  it('keeps the selected parent unchanged and shows a create conflict', async () => {
    const onCreateDirectory = vi
      .fn<ProjectFolderPickerPort['createDirectory']>()
      .mockRejectedValue(new Error('The destination already exists'))
    const onOpen = vi.fn((hostId: string, path: string) =>
      Promise.resolve(projectState(hostId, path)),
    )
    renderDialog({
      currentHost: localHost,
      suggestedPath: '/projects/initial',
      onBrowse: (hostId, path) => Promise.resolve(browseResponse(hostId, path)),
      onCreateDirectory,
      onOpen,
    })

    await chooseFolder()
    await waitFor(() => selectedRow('/projects/initial') !== undefined)
    await clickButton('New folder')
    changeNamedInput('New folder name', 'existing')
    await clickButton('Create')
    await waitFor(
      () =>
        document.body.textContent?.includes('The destination already exists') === true,
    )

    expect(pathInput().value).toBe('/projects/initial')
    expect(selectedRow('/projects/initial')).toBeTruthy()
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="New folder name"]')
        ?.value,
    ).toBe('existing')
    expect(onOpen).not.toHaveBeenCalled()
  })
})

function renderDialog({
  currentHost,
  suggestedPath,
  onBrowse,
  onPickerBrowse,
  onCreateDirectory = (_pickerId, parent, name) =>
    Promise.resolve(hostPath(parent.hostId, `${parent.path}/${name}`)),
  onOpen,
  onOpened = vi.fn(),
}: {
  readonly currentHost: ProjectHostOption
  readonly suggestedPath: string
  readonly onBrowse: (hostId: string, path: string) => Promise<BrowseHostResponse>
  readonly onPickerBrowse?: ProjectFolderPickerPort['browse']
  readonly onCreateDirectory?: ProjectFolderPickerPort['createDirectory']
  readonly onOpen: (hostId: string, path: string) => Promise<ProjectState>
  readonly onOpened?: (state: ProjectState) => void
}): void {
  const connected: ConnectedHost = { host: currentHost, suggestedPath }
  const folderPicker: ProjectFolderPickerPort = {
    start: () => Promise.resolve({ pickerId: 'picker-1' }),
    browse:
      onPickerBrowse ??
      ((_pickerId, path) => onBrowse(currentHost.hostId, path)),
    createDirectory: onCreateDirectory,
    close: () => Promise.resolve(),
  }
  act(() => {
    root.render(
      <SessionDialog
        hosts={[localHost, sshHost]}
        currentRoot={hostPath(asHostId(currentHost.hostId), '/current')}
        suspended={false}
        onCancel={vi.fn()}
        onConnect={() => Promise.resolve(connected)}
        onBrowse={onBrowse}
        folderPicker={folderPicker}
        onDisconnect={() => Promise.resolve(currentHost)}
        onOpen={onOpen}
        onOpened={onOpened}
      />,
    )
  })
  flushFrames()
}

async function chooseFolder(): Promise<void> {
  await clickButton('Choose folder')
  flushFrames()
}

function browseResponse(hostId: string, path: string): BrowseHostResponse {
  const directories: readonly DirEntry[] = (directoryChildren[path] ?? []).map(
    (name) => ({ name, type: 'dir' }),
  )
  return {
    path: hostPath(asHostId(hostId), path),
    directories,
  }
}

function projectState(hostId: string, path: string): ProjectState {
  return {
    revision: 0,
    root: hostPath(asHostId(hostId), path),
    connectionState: 'connected',
    watchTier: hostId === 'local' ? 'native' : 'polling',
    projects: [],
    activeProjectId: 'project',
    activeWorkspaceId: 'workspace',
  }
}

function pathInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Folder path"]',
  )
  if (!input) throw new Error('Missing folder path input')
  return input
}

function selectedRow(path: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.folder-browser .directory-row.selected',
    ),
  ].find((row) => row.title === path)
}

function directoryRow(path: string): HTMLButtonElement | undefined {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('.folder-browser .directory-row'),
  ].find((row) => row.title === path)
}

function button(label: string): HTMLButtonElement {
  const match = buttonOrUndefined(label)
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function buttonOrUndefined(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
}

function changeInput(value: string): void {
  const input = pathInput()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function changeNamedInput(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing input '${label}'`)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value,
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submitPathForm(): void {
  const form = pathInput().form
  if (!form) throw new Error('Folder path input is not inside a form')
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}

function flushFrames(): void {
  act(() => {
    while (frameCallbacks.size > 0) {
      const callbacks = [...frameCallbacks.values()]
      frameCallbacks.clear()
      for (const callback of callbacks) callback(performance.now())
    }
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error('Timed out waiting for session dialog state')
}
