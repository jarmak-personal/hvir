import { createHash } from 'node:crypto'

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
      expect(fixture.store.retryLoad).toHaveBeenCalledOnce()
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
        snapshot: {
          digest: createHash('sha256').update(content).digest('hex'),
          byteLength: Buffer.byteLength(content),
        },
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

  it('revokes prepared-delivery snapshots with the renderer owner', async () => {
    const fixture = createFixture(asHostId('local'), localPath('/repo'), vi.fn())
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const request = {
      workspace: fixture.workspace,
      workspaceGeneration: restored.workspaceGeneration,
    }

    expect(fixture.coordinator.deliverySnapshot(fixture.owner, request)).toMatchObject({
      workspaceGeneration: restored.workspaceGeneration,
      revision: 0,
      model: fixture.model,
      host: fixture.host,
    })

    await fixture.resources.revokeOwner(fixture.owner.id)

    expect(() => fixture.coordinator.deliverySnapshot(fixture.owner, request)).toThrow(
      /stale|revoked/,
    )
  })

  it.each([
    ['worktree', { id: 'other', root: localPath('/repo') }],
    [
      'host',
      {
        id: 'project:worktree',
        root: hostPath(asHostId('ssh:other'), '/repo'),
      },
    ],
  ])('rejects a model injected from another %s', async (_kind, modelWorkspace) => {
    const fixture = createFixture(asHostId('local'), localPath('/repo'), vi.fn())
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )

    await expect(
      fixture.coordinator.save(fixture.owner, {
        workspace: fixture.workspace,
        workspaceGeneration: restored.workspaceGeneration,
        expectedRevision: 0,
        model: emptyModel(modelWorkspace),
      }),
    ).rejects.toThrow(/model belongs to another workspace identity/)
    expect(fixture.store.save).not.toHaveBeenCalled()
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

  it('atomically persists exact included drafts as sent and releases their batch slots', async () => {
    const root = localPath('/repo')
    const workspace: ReviewWorkspaceIdentity = { id: 'project:worktree', root }
    const model = modelWithDraft(workspace)
    const save = vi.fn((_revision: number, candidate: DocumentReviewModel) =>
      Promise.resolve({ revision: 8, model: candidate }),
    )
    const fixture = createFixture(root.hostId, root, vi.fn(), 'connected', {
      read: vi.fn(() => ({ revision: 7, model })),
      save,
    })
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )

    const sent = await fixture.coordinator.markSent(fixture.owner, {
      workspace,
      workspaceGeneration: restored.workspaceGeneration,
      expectedRevision: 7,
      commentIds: ['draft-comment'],
    })

    expect(save).toHaveBeenCalledExactlyOnceWith(
      7,
      expect.objectContaining({
        comments: [expect.objectContaining({ lifecycle: 'sent' })],
        batches: [],
      }),
    )
    expect(sent).toMatchObject({
      revision: 8,
      model: {
        comments: [expect.objectContaining({ lifecycle: 'sent' })],
        batches: [],
      },
    })
  })

  it('rejects stale, duplicate, or non-draft sent transitions before persistence', async () => {
    const root = localPath('/repo')
    const workspace: ReviewWorkspaceIdentity = { id: 'project:worktree', root }
    const model = modelWithDraft(workspace)
    const save = vi.fn()
    const fixture = createFixture(root.hostId, root, vi.fn(), 'connected', {
      read: vi.fn(() => ({ revision: 7, model })),
      save,
    })
    const restored = await fixture.coordinator.activate(
      fixture.owner,
      fixture.workspace,
      fixture.host,
    )
    const base = {
      workspace,
      workspaceGeneration: restored.workspaceGeneration,
      expectedRevision: 7,
    }

    await expect(
      fixture.coordinator.markSent(fixture.owner, {
        ...base,
        commentIds: ['draft-comment', 'draft-comment'],
      }),
    ).rejects.toThrow(/unique bounded/)
    await expect(
      fixture.coordinator.markSent(fixture.owner, {
        ...base,
        expectedRevision: 6,
        commentIds: ['draft-comment'],
      }),
    ).rejects.toThrow(/changed during submission/)
    await expect(
      fixture.coordinator.markSent(fixture.owner, {
        ...base,
        commentIds: ['missing'],
      }),
    ).rejects.toThrow(/exact included drafts/)
    expect(save).not.toHaveBeenCalled()
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
    retryLoad: vi.fn(() => Promise.resolve()),
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

function modelWithDraft(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  return {
    workspace,
    comments: [
      {
        id: 'draft-comment',
        workspace,
        document: hostPath(workspace.root.hostId, `${workspace.root.path}/review.md`),
        body: 'Please update this.',
        lifecycle: 'draft',
        anchor: {
          snapshot: { algorithm: 'sha256', digest: 'a'.repeat(64), byteLength: 6 },
          range: { startLine: 1, endLine: 1 },
          excerpt: 'Target',
          contextBefore: '',
          contextAfter: '',
          state: { status: 'current' },
        },
      },
    ],
    batches: [{ id: 'active-review', workspace, commentIds: ['draft-comment'] }],
  }
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
