import { describe, expect, it, vi } from 'vitest'

import { DocumentReviewCoordinator } from '../src/main/document-review/document-review-coordinator'
import type { ProjectHost, ReadFileOptions } from '../src/main/project-host'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  asHostId,
  hostPath,
  localPath,
  type DocumentReviewModel,
  type HostId,
  type HostPath,
  type ReviewWorkspaceIdentity,
  type TextWorkload,
} from '../src/shared'

type ReviewRead = (
  path: HostPath,
  maxBytes: number,
  options?: ReadFileOptions,
) => Promise<TextWorkload>

describe('document review coordinator', () => {
  it.each([
    ['local', asHostId('local'), localPath('/repo')],
    ['SSH', asHostId('ssh:review'), hostPath(asHostId('ssh:review'), '/repo')],
  ])(
    'uses the same bounded cancellable read for %s workspaces',
    async (_kind, id, root) => {
      const content = 'before\ntarget\nafter\n'
      const readTextFilePrefix = vi.fn<ReviewRead>(() =>
        Promise.resolve(workload(content)),
      )
      const fixture = createFixture(id, root, readTextFilePrefix)
      const restored = await fixture.coordinator.activate(
        fixture.owner,
        fixture.workspace,
        fixture.host,
      )
      const document = hostPath(id, `${root.path}/review.md`)

      await expect(
        fixture.coordinator.revalidate(
          fixture.owner,
          request(fixture.workspace, restored.workspaceGeneration, document),
          document,
        ),
      ).resolves.toMatchObject({
        status: 'read',
        document,
        content,
        snapshot: { byteLength: Buffer.byteLength(content) },
      })
      expect(readTextFilePrefix.mock.calls[0]?.slice(0, 2)).toEqual([
        document,
        4 * 1024 * 1024,
      ])
      expect(readTextFilePrefix.mock.calls[0]?.[2]).toMatchObject({
        pollingInterest: true,
      })
      expect(readTextFilePrefix.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal)
    },
  )

  it('restores durable drafts while disconnected and reports revalidation unavailable', async () => {
    const fixture = createFixture(
      asHostId('ssh:offline'),
      hostPath(asHostId('ssh:offline'), '/repo'),
      vi.fn(),
      'disconnected',
    )
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const document = hostPath(fixture.host.hostId, '/repo/review.md')
    await expect(
      fixture.coordinator.revalidate(
        fixture.owner,
        request(fixture.workspace, restored.workspaceGeneration, document),
        document,
      ),
    ).resolves.toEqual({
      status: 'stale',
      document,
      reason: 'host-unavailable',
    })
  })

  it('classifies incomplete, invalid, and deleted reads without losing the draft', async () => {
    const root = localPath('/repo')
    const document = localPath('/repo/review.md')
    const read = vi
      .fn()
      .mockResolvedValueOnce({ content: 'partial', byteLength: 7, complete: false })
      .mockResolvedValueOnce(workload('bad\0text'))
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    const fixture = createFixture(root.hostId, root, read)
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const revalidate = () =>
      fixture.coordinator.revalidate(
        fixture.owner,
        request(fixture.workspace, restored.workspaceGeneration, document),
        document,
      )

    await expect(revalidate()).resolves.toMatchObject({ reason: 'incomplete-read' })
    await expect(revalidate()).resolves.toMatchObject({ reason: 'invalid-text' })
    await expect(revalidate()).resolves.toMatchObject({ reason: 'deleted' })
    expect(fixture.store.read().model).toBe(fixture.model)
  })

  it('rejects exact-workspace escapes and stale renderer generations', async () => {
    const fixture = createFixture(asHostId('local'), localPath('/repo'), vi.fn())
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const outside = localPath('/other/review.md')
    await expect(
      fixture.coordinator.revalidate(
        fixture.owner,
        request(fixture.workspace, restored.workspaceGeneration, outside),
        outside,
      ),
    ).rejects.toThrow(/escapes its exact workspace/)

    await expect(
      fixture.coordinator.save(fixture.owner, {
        workspace: fixture.workspace,
        workspaceGeneration: restored.workspaceGeneration + 1,
        expectedRevision: 0,
        model: fixture.model,
      }),
    ).rejects.toThrow(/generation is stale/)
  })

  it('aborts in-flight reads and rejects late writes on workspace revocation', async () => {
    const readStarted = deferred<void>()
    const readTextFilePrefix = vi.fn(
      (_path: HostPath, _limit: number, options: ReadFileOptions = {}) =>
        new Promise<TextWorkload>((_resolve, reject) => {
          if (!options.signal) throw new Error('Test read requires an owned signal')
          const signal = options.signal
          readStarted.resolve()
          signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = signal.reason
              reject(reason instanceof Error ? reason : new Error('Read aborted'))
            },
            { once: true },
          )
        }),
    )
    const save = deferred<{
      readonly revision: number
      readonly model: DocumentReviewModel
    }>()
    const fixture = createFixture(
      asHostId('local'),
      localPath('/repo'),
      readTextFilePrefix,
      'connected',
      {
        save: vi.fn(() => save.promise),
      },
    )
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const document = localPath('/repo/review.md')
    const reading = fixture.coordinator.revalidate(
      fixture.owner,
      request(fixture.workspace, restored.workspaceGeneration, document),
      document,
    )
    const saving = fixture.coordinator.save(fixture.owner, {
      workspace: fixture.workspace,
      workspaceGeneration: restored.workspaceGeneration,
      expectedRevision: 0,
      model: fixture.model,
    })
    await readStarted.promise
    await fixture.resources.revokeOwner(fixture.owner.id)

    await expect(reading).rejects.toThrow(/revoked/)
    save.resolve({ revision: 1, model: fixture.model })
    await expect(saving).rejects.toThrow(/revoked/)
  })
})

function createFixture(
  hostId: HostId,
  root: HostPath,
  readTextFilePrefix: ReviewRead,
  connectionState: ProjectHost['connectionState'] = 'connected',
  storeOverrides: Record<string, unknown> = {},
) {
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(42)
  const workspace: ReviewWorkspaceIdentity = { id: 'project:worktree', root }
  const model = emptyModel(workspace)
  const store = {
    notice: vi.fn(() => undefined),
    read: vi.fn(() => ({ revision: 0, model })),
    save: vi.fn((_revision: number, candidate: DocumentReviewModel) =>
      Promise.resolve({ revision: 1, model: candidate }),
    ),
    ...storeOverrides,
  }
  const host = {
    hostId,
    connectionState,
    readTextFilePrefix,
  } as unknown as ProjectHost
  const coordinator = new DocumentReviewCoordinator({ store, resources })
  return { coordinator, host, model, owner, resources, store, workspace }
}

function emptyModel(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  return { workspace, comments: [], batches: [] }
}

function request(
  workspace: ReviewWorkspaceIdentity,
  workspaceGeneration: number,
  document: HostPath,
) {
  return { workspace, workspaceGeneration, document }
}

function workload(content: string): TextWorkload {
  return {
    content,
    byteLength: Buffer.byteLength(content),
    lineCount: content.split('\n').length,
    complete: true,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
