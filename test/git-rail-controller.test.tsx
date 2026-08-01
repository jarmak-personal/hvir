// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { GitBranchControls } from '../src/renderer/src/git/GitBranchControls'
import { useGitRailController } from '../src/renderer/src/git/use-git-rail-controller'
import {
  asHostId,
  hostPath,
  localPath,
  type GitBranchModel,
  type GitChanges,
  type HostPath,
} from '../src/shared'

let container: HTMLDivElement
let reactRoot: Root
let controller: ReturnType<typeof useGitRailController> | undefined
let branches: Mock<(root: HostPath) => Promise<GitBranchModel>>
let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  reactRoot = createRoot(container)
  branches = vi.fn()
  invoke = vi.fn((channel: string, request: { readonly root: HostPath }) => {
    if (channel === 'git:branches') return branches(request.root)
    if (channel === 'git:changes') return Promise.resolve(changes())
    return Promise.reject(new Error(`Unexpected IPC ${channel}`))
  })
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
})

afterEach(() => {
  act(() => reactRoot.unmount())
  container.remove()
  controller = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Git rail branch refresh controller', () => {
  it('coalesces an in-flight invalidation burst and retains settled presentation', async () => {
    const active = deferred<GitBranchModel>()
    branches
      .mockResolvedValueOnce(branchModel('feature'))
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce(branchModel('main'))

    await renderController({ gitVersion: 0 })
    expect(branches).toHaveBeenCalledOnce()
    expect(select().value).toBe('feature')
    expect(syncSummary()).not.toContain('Checking remote status')

    await renderController({ gitVersion: 1 })
    expect(branches).toHaveBeenCalledTimes(2)
    expect(select().value).toBe('feature')
    expect(select().disabled).toBe(false)
    expect(syncSummary()).not.toContain('Checking remote status')

    for (let gitVersion = 2; gitVersion <= 40; gitVersion += 1) {
      await renderController({ gitVersion })
    }
    expect(branches).toHaveBeenCalledTimes(2)
    expect(select().value).toBe('feature')

    await act(async () => {
      active.resolve(branchModel('intermediate'))
      await settleEffects()
    })

    expect(branches).toHaveBeenCalledTimes(3)
    expect(select().value).toBe('main')
    expect(syncSummary()).not.toContain('Checking remote status')
  })

  it('clears state on a host-qualified context change and rejects the late completion', async () => {
    const oldContext = deferred<GitBranchModel>()
    const newContext = deferred<GitBranchModel>()
    const sshRoot = hostPath(asHostId('ssh-controller'), '/repo')
    branches
      .mockResolvedValueOnce(branchModel('feature'))
      .mockReturnValueOnce(oldContext.promise)
      .mockReturnValueOnce(newContext.promise)

    await renderController({ gitVersion: 0 })
    await renderController({ gitVersion: 1 })
    expect(select().value).toBe('feature')

    await renderController({ gitVersion: 1, root: sshRoot })
    expect(select().disabled).toBe(true)
    expect(select().value).toBe('__detached__')
    expect(syncSummary()).toContain('Checking remote status')

    await act(async () => {
      oldContext.resolve(branchModel('stale'))
      await settleEffects()
    })
    expect(branches).toHaveBeenCalledTimes(3)
    expect(branches).toHaveBeenLastCalledWith(sshRoot)
    expect(select().value).toBe('__detached__')

    await act(async () => {
      newContext.resolve(branchModel('main'))
      await settleEffects()
    })
    expect(select().value).toBe('main')
    expect(select().disabled).toBe(false)
  })

  it('drains a failed burst to one actionable error without discarding settled state', async () => {
    const active = deferred<GitBranchModel>()
    branches
      .mockResolvedValueOnce(branchModel('feature'))
      .mockReturnValueOnce(active.promise)
      .mockRejectedValueOnce(new Error('latest branch inspection failed'))

    await renderController({ gitVersion: 0 })
    await renderController({ gitVersion: 1 })
    for (let gitVersion = 2; gitVersion <= 20; gitVersion += 1) {
      await renderController({ gitVersion })
    }

    await act(async () => {
      active.reject(new Error('superseded branch inspection failed'))
      await settleEffects()
    })

    expect(branches).toHaveBeenCalledTimes(3)
    expect(select().value).toBe('feature')
    expect(syncSummary()).not.toContain('Checking remote status')
    const errors = container.querySelectorAll('.git-branch-control small.error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.textContent).toBe('latest branch inspection failed')
    await act(settleEffects)
    expect(branches).toHaveBeenCalledTimes(3)
  })

  it('disables switching only for the mutation interval and settles on the new branch', async () => {
    const mutation = deferred<void>()
    const inspection = deferred<GitBranchModel>()
    const onSwitchBranch = vi.fn(() => mutation.promise)
    branches
      .mockResolvedValueOnce(branchModel('feature'))
      .mockReturnValueOnce(inspection.promise)

    await renderController({ gitVersion: 0, onSwitchBranch })
    let operation: Promise<void> | undefined
    act(() => {
      operation = controller?.switchBranch('main')
    })
    expect(select().disabled).toBe(true)

    await act(async () => {
      mutation.resolve()
      await operation
      await settleEffects()
    })
    expect(branches).toHaveBeenCalledTimes(2)
    expect(select().value).toBe('feature')
    expect(select().disabled).toBe(false)

    await act(async () => {
      inspection.resolve(branchModel('main'))
      await settleEffects()
    })
    expect(select().value).toBe('main')
    expect(select().disabled).toBe(false)
  })
})

async function renderController({
  gitVersion,
  root = localPath('/repo'),
  onSwitchBranch = () => Promise.resolve(),
}: {
  readonly gitVersion: number
  readonly root?: HostPath
  readonly onSwitchBranch?: (branch: string) => Promise<void>
}): Promise<void> {
  await act(async () => {
    reactRoot.render(
      <ControllerHarness
        root={root}
        gitVersion={gitVersion}
        onSwitchBranch={onSwitchBranch}
      />,
    )
    await settleEffects()
  })
}

function ControllerHarness({
  root,
  gitVersion,
  onSwitchBranch,
}: {
  readonly root: HostPath
  readonly gitVersion: number
  readonly onSwitchBranch: (branch: string) => Promise<void>
}) {
  controller = useGitRailController({
    root,
    refreshVersion: 0,
    historyRefreshVersion: gitVersion,
    onChanges: ignoreChanges,
    connectionState: 'connected',
    hidden: false,
    historyPaused: false,
    hasDirtyViewerTabs: false,
    onSwitchBranch,
    onFetch: () => Promise.resolve(),
    onPull: () => Promise.resolve(),
    autoFetchIntervalMs: 0,
  })
  return (
    <GitBranchControls
      root={root}
      model={controller.model}
      syncState={controller.syncState}
      onSwitchBranch={(branch) => void controller?.switchBranch(branch)}
      onFetch={controller.fetch}
      onPull={controller.pull}
    />
  )
}

function ignoreChanges(): void {}

function select(): HTMLSelectElement {
  const value = container.querySelector<HTMLSelectElement>('#git-branch-select')
  if (!value) throw new Error('Branch selector missing')
  return value
}

function syncSummary(): string {
  return container.querySelector('[aria-live="polite"]')?.textContent ?? ''
}

function changes(): GitChanges {
  return {
    repositoryState: 'ready',
    workingTree: [],
    branchPoint: [],
    branchPointAvailable: true,
  }
}

function branchModel(current: string): GitBranchModel {
  return {
    repositoryState: 'ready',
    current,
    head: '0123456789012345678901234567890123456789',
    detached: false,
    remoteAvailable: true,
    sync: { upstream: { name: `origin/${current}`, ahead: 0, behind: 0 } },
    branches: [
      { name: current, current: true },
      { name: current === 'main' ? 'feature' : 'main', current: false },
    ],
  }
}

async function settleEffects(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
} {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
