import { afterEach, expect, it, vi } from 'vitest'
import { sourceFixture } from './fixtures/extension-source'
import { ExtensionSourceTrashRequestOwner } from '../src/main/extensions/source-trash'
import { localPath } from '../src/shared/host-path'
import type { ProjectFileOperationCoordinator } from '../src/main/project-file-operations'
import {
  PROJECT_FILE_OPERATION_DEADLINE_MS,
  type ProjectFileOperationProgress,
} from '../src/shared/project-file-operations'
import { SOURCE_LIMITS } from '../src/shared/extensions/source-access'

const fixtures: Array<() => void> = []
afterEach(() => {
  for (const dispose of fixtures.splice(0)) dispose()
  vi.useRealTimers()
})

async function fixture() {
  const f = sourceFixture('workspace')
  await f.grant()
  f.host.stat.mockResolvedValue({ type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 })
  const identity = vi.fn((path: { path: string }) =>
    Promise.resolve(`identity:${path.path}`),
  )
  const deletion = { capability: 'recoverable' as 'recoverable' | 'permanent' }
  const localHost = Object.assign(f.host, {
    fileDeletion: deletion,
    managedTransfer: { entryIdentity: identity },
  })
  const publish = vi.fn(),
    scopes = { assertCurrent: vi.fn() }
  const requests = new ExtensionSourceTrashRequestOwner(
    scopes,
    f.approvals,
    localHost,
    () => true,
    publish,
  )
  fixtures.push(() => {
    requests.dispose()
    f.dispose()
  })
  const owner = { id: 7, generation: 3 },
    path = localPath('/library/skill')
  const input = { source: 'source', workspaceId: 'workspace', path }
  const inputDeleted: Parameters<ProjectFileOperationCoordinator['delete']>[0][] = []
  const files = {
    delete: vi.fn((value: Parameters<ProjectFileOperationCoordinator['delete']>[0]) => {
      inputDeleted.push(value)
      return Promise.resolve({
        outcome: 'started' as const,
        operationId: 'operation',
        generation: 2,
        itemCount: 1,
      })
    }),
    cancel: vi.fn(() => true),
  }
  const begin = async () => {
    const result = requests.request(f.caller, input, owner)
    await vi.waitFor(() => expect(requests.snapshot(owner)).toHaveLength(1))
    return { result, id: requests.snapshot(owner)[0]!.id }
  }
  const complete = (
    effect: 'trashed-entry' | 'none' | 'deletion-state-unknown' = 'trashed-entry',
  ) => {
    const progress: ProjectFileOperationProgress = {
      workspaceRoot: f.root,
      operationId: 'operation',
      generation: 2,
      phase: 'completed',
      completedItems: 1,
      totalItems: 1,
      result: {
        outcome: 'completed',
        operationId: 'operation',
        generation: 2,
        items: [
          {
            itemId: 'delete:0',
            source: path,
            destination: path,
            status: effect === 'trashed-entry' ? 'completed' : 'failed',
            effect,
            reason: effect === 'none' ? 'Trash refused' : undefined,
          },
        ],
      },
    }
    inputDeleted[0]!.publish(progress)
    inputDeleted[0]!.settled?.(progress.result)
  }
  return {
    ...f,
    requests,
    owner,
    input,
    publish,
    files,
    inputDeleted,
    begin,
    complete,
    identity,
    deletion,
    scopes,
  }
}

it('opens one exact review without deletion; only trusted confirmation dispatches and final Files truth completes it', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  expect(f.files.delete).not.toHaveBeenCalled()
  expect(f.requests.snapshot(f.owner)[0]).toMatchObject({
    root: f.root,
    path: f.input.path,
  })
  expect(f.requests.snapshot({ id: 7, generation: 4 })).toEqual([])
  await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(/pending/)
  await f.requests.confirm(f.owner, id, f.files, vi.fn())
  await expect(f.requests.confirm(f.owner, id, f.files, vi.fn())).rejects.toThrow(
    /already/,
  )
  expect(f.inputDeleted[0]!.request).toEqual({
    workspaceRoot: f.root,
    source: f.input.path,
    confirmedRecovery: 'recoverable',
  })
  await f.inputDeleted[0]!.beforeDelete!()
  let settled = false
  void result.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  f.complete()
  await expect(result).resolves.toEqual({ outcome: 'completed' })
  expect(f.requests.snapshot(f.owner)).toEqual([])
})

it('cancels without deletion and rejects foreign renderer or duplicate decisions', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  expect(() => f.requests.cancel({ id: 8, generation: 3 }, id)).toThrow(/current/)
  f.requests.cancel(f.owner, id)
  await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
  await expect(f.requests.confirm(f.owner, id, f.files, vi.fn())).rejects.toThrow(
    /current/,
  )
  expect(f.files.delete).not.toHaveBeenCalled()
})

it('expires an unattended human review without performing or retrying deletion', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const result = f.requests.request(f.caller, f.input, f.owner)
  await vi.advanceTimersByTimeAsync(0)
  const id = f.requests.snapshot(f.owner)[0]!.id
  await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs)
  await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
  await expect(f.requests.confirm(f.owner, id, f.files, vi.fn())).rejects.toThrow(
    /current/,
  )
  expect(f.files.delete).not.toHaveBeenCalled()
})

it.each(['agent', 'action', 'updater'])(
  'rejects %s-origin before observing the filesystem',
  async () => {
    const f = await fixture()
    f.host.realpath.mockClear()
    await expect(
      f.requests.request({ ...f.caller, allowed: false }, f.input, f.owner),
    ).rejects.toThrow(/human/)
    expect(f.host.realpath).not.toHaveBeenCalled()
  },
)

it('refuses root, escaping paths, wrong workspace and permanent-only hosts', async () => {
  const f = await fixture()
  for (const input of [
    { ...f.input, path: f.root },
    { ...f.input, path: localPath('/elsewhere') },
    { ...f.input, workspaceId: 'another' },
  ])
    await expect(f.requests.request(f.caller, input, f.owner)).rejects.toThrow(/exact/)
  f.deletion.capability = 'permanent'
  const result = await f.requests.request(f.caller, f.input, f.owner)
  expect(result.outcome).toBe('refused')
  expect(result.reason).toMatch(/Recoverable/)
  expect(f.publish).not.toHaveBeenCalled()
})

it.each(['leaf', 'ancestor'])(
  'refuses a %s symlink without following its target',
  async (kind) => {
    const f = await fixture()
    const input =
      kind === 'leaf' ? f.input : { ...f.input, path: localPath('/library/link/skill') }
    f.host.stat.mockImplementation((path) =>
      Promise.resolve({
        type:
          path.path === (kind === 'leaf' ? '/library/skill' : '/library/link')
            ? 'symlink'
            : 'dir',
        size: 0,
        mode: 0o755,
        mtimeMs: 0,
      }),
    )
    await expect(f.requests.request(f.caller, input, f.owner)).resolves.toMatchObject({
      outcome: 'refused',
    })
    expect(f.publish).not.toHaveBeenCalled()
  },
)

it.each(['source', 'view', 'renderer', 'workspace', 'host'])(
  'revokes pending review when its %s ends',
  async (kind) => {
    const f = await fixture(),
      { result, id } = await f.begin()
    if (kind === 'source') f.approvals.dispose()
    else if (kind === 'view') f.close()
    else if (kind === 'workspace') f.workspaces.splice(0)
    else if (kind === 'host') f.host.connectionState = 'disconnected'
    else
      f.scopes.assertCurrent.mockImplementation(() => {
        throw new Error('gone')
      })
    f.requests.revalidate()
    await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
    await expect(f.requests.confirm(f.owner, id, f.files, vi.fn())).rejects.toThrow()
    expect(f.files.delete).not.toHaveBeenCalled()
  },
)

it('retains physical preparation capacity after cancellation until the host settles', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.host.realpath.mockImplementation(async (path) => {
    entered()
    await held
    return path
  })
  const result = f.requests.request(f.caller, f.input, f.owner)
  await reached
  f.controller.abort()
  await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
  await expect(
    f.requests.request(
      { ...f.caller, signal: new AbortController().signal },
      f.input,
      f.owner,
    ),
  ).rejects.toThrow(/pending/)
  release()
  await vi.waitFor(() => expect(f.publish).not.toHaveBeenCalled())
})

it.each(['cancel', 'deadline'] as const)(
  'reports no effect when %s ends confirmation validation and retains admission until validation settles',
  async (ending) => {
    const f = await fixture()
    vi.useFakeTimers()
    const result = f.requests.request(f.caller, f.input, f.owner)
    await vi.advanceTimersByTimeAsync(0)
    const id = f.requests.snapshot(f.owner)[0]!.id
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.host.realpath.mockImplementationOnce(async (path) => {
      entered()
      await held
      return path
    })
    const confirming = f.requests.confirm(f.owner, id, f.files, vi.fn())
    const rejected = expect(confirming).rejects.toThrow()
    await reached
    if (ending === 'cancel') f.requests.cancel(f.owner, id)
    else await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs)
    await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
    expect(f.files.delete).not.toHaveBeenCalled()
    await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(
      /pending/,
    )
    release()
    await rejected
    vi.useRealTimers()
    const next = await f.begin()
    f.requests.cancel(f.owner, next.id)
    await next.result
  },
)

it('guards the handoff before submission even when Files has not returned its start reply', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  f.files.delete.mockImplementationOnce(async (input) => {
    f.inputDeleted.push(input)
    await input.beforeDelete!()
    f.requests.cancel(f.owner, id)
    expect(() => input.onSubmitted!()).toThrow()
    return {
      outcome: 'started',
      operationId: 'operation',
      generation: 2,
      itemCount: 1,
    }
  })
  await f.requests.confirm(f.owner, id, f.files, vi.fn())
  await expect(result).resolves.toMatchObject({ outcome: 'cancelled' })
  expect(f.files.cancel).toHaveBeenCalledWith(f.owner, 'operation', 2)
  await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(/pending/)
  f.complete('none')
  const next = await f.begin()
  f.requests.cancel(f.owner, next.id)
  await next.result
})

it('keeps submission uncertainty and admission when cancellation precedes the Files start reply', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  let release!: () => void, submitted!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const reached = new Promise<void>((resolve) => {
    submitted = resolve
  })
  f.files.delete.mockImplementationOnce(async (input) => {
    f.inputDeleted.push(input)
    await input.beforeDelete!()
    input.onSubmitted!()
    submitted()
    await held
    return {
      outcome: 'started',
      operationId: 'operation',
      generation: 2,
      itemCount: 1,
    }
  })
  const confirming = f.requests.confirm(f.owner, id, f.files, vi.fn())
  await reached
  f.requests.cancel(f.owner, id)
  await expect(result).resolves.toMatchObject({ outcome: 'uncertain' })
  expect(f.files.cancel).not.toHaveBeenCalled()
  await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(/pending/)
  release()
  await confirming
  expect(f.files.cancel).toHaveBeenCalledWith(f.owner, 'operation', 2)
  f.complete()
  const next = await f.begin()
  f.requests.cancel(f.owner, next.id)
  await next.result
})

it('leaves the physical deadline to Files after it starts without a competing source timer', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  const result = f.requests.request(f.caller, f.input, f.owner)
  await vi.advanceTimersByTimeAsync(0)
  const id = f.requests.snapshot(f.owner)[0]!.id
  await vi.advanceTimersByTimeAsync(SOURCE_LIMITS.decisionMs - 1)
  await f.requests.confirm(f.owner, id, f.files, vi.fn())
  let settled = false
  void result.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(
    SOURCE_LIMITS.decisionMs + PROJECT_FILE_OPERATION_DEADLINE_MS,
  )
  expect(settled).toBe(false)
  expect(f.files.cancel).not.toHaveBeenCalled()
  f.complete()
  await expect(result).resolves.toEqual({ outcome: 'completed' })
})

it('rejects replaced native directory identity at confirmation and immediately before Trash', async () => {
  const f = await fixture(),
    first = await f.begin()
  f.identity.mockResolvedValue('replacement')
  await expect(f.requests.confirm(f.owner, first.id, f.files, vi.fn())).rejects.toThrow(
    /changed/,
  )
  await expect(first.result).resolves.toMatchObject({ outcome: 'refused' })
  expect(f.files.delete).not.toHaveBeenCalled()
  const second = await f.begin()
  await f.requests.confirm(f.owner, second.id, f.files, vi.fn())
  f.identity.mockResolvedValue('second-replacement')
  await expect(f.inputDeleted[0]!.beforeDelete!()).rejects.toThrow(/changed/)
  f.complete('none')
  await expect(second.result).resolves.toMatchObject({ outcome: 'refused' })
})

it.each(['none', 'deletion-state-unknown'] as const)(
  'preserves the actual %s result',
  async (effect) => {
    const f = await fixture(),
      { result, id } = await f.begin()
    await f.requests.confirm(f.owner, id, f.files, vi.fn())
    f.complete(effect)
    await expect(result).resolves.toMatchObject({
      outcome: effect === 'none' ? 'refused' : 'uncertain',
    })
  },
)

it('retains a cancelled physical operation until its terminal event and never claims rollback', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  const published = vi.fn<(progress: ProjectFileOperationProgress) => void>()
  await f.requests.confirm(f.owner, id, f.files, published)
  f.inputDeleted[0]!.onSubmitted!()
  f.requests.cancel(f.owner, id)
  await expect(result).resolves.toMatchObject({ outcome: 'uncertain' })
  expect(f.files.cancel).toHaveBeenCalledWith(f.owner, 'operation', 2)
  await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(/pending/)
  f.complete()
  expect(published).toHaveBeenCalled()
  const next = await f.begin()
  f.requests.cancel(f.owner, next.id)
  await next.result
})

it('releases physical capacity from the receipt even when a retired renderer receives no final event', async () => {
  const f = await fixture(),
    { result, id } = await f.begin()
  await f.requests.confirm(f.owner, id, f.files, vi.fn())
  f.inputDeleted[0]!.onSubmitted!()
  f.scopes.assertCurrent.mockImplementation(() => {
    throw new Error('retired')
  })
  f.files.cancel.mockImplementation(() => {
    throw new Error('retired')
  })
  expect(() => f.requests.revalidate()).not.toThrow()
  await expect(result).resolves.toMatchObject({ outcome: 'uncertain' })
  f.scopes.assertCurrent.mockReset()
  await expect(f.requests.request(f.caller, f.input, f.owner)).rejects.toThrow(/pending/)
  f.inputDeleted[0]!.settled?.(undefined)
  const next = await f.begin()
  f.requests.cancel(f.owner, next.id)
  await next.result
})
