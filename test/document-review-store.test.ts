import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentReviewStore } from '../src/main/document-review/document-review-store'
import { LocalHost } from '../src/main/project-host/local-host'
import {
  asHostId,
  hostPath,
  localPath,
  type DocumentReviewModel,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

describe('document review store', () => {
  let directory: string
  let host: LocalHost
  let file: ReturnType<typeof localPath>
  let store: DocumentReviewStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-document-review-'))
    host = new LocalHost()
    await host.connect()
    file = localPath(join(directory, 'document-review-drafts.json'))
    store = await DocumentReviewStore.load(host, file)
  })

  afterEach(async () => {
    await store.dispose(100).catch(() => undefined)
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('restores exact local and SSH workspace identities after restart', async () => {
    const localWorkspace = workspace('project:main', localPath('/repo'))
    const sshWorkspace = workspace(
      'project:remote',
      hostPath(asHostId('ssh:review'), '/srv/repo'),
    )
    await store.save(0, model(localWorkspace, localPath('/repo/local.md'), 'local'))
    await store.save(
      0,
      model(
        sshWorkspace,
        hostPath(asHostId('ssh:review'), '/srv/repo/remote.md'),
        'remote',
      ),
    )
    await store.flush()

    const restored = await DocumentReviewStore.load(host, file)
    expect(restored.read(localWorkspace)).toMatchObject({
      revision: 1,
      model: { comments: [{ body: 'local' }] },
    })
    expect(restored.read(sshWorkspace)).toMatchObject({
      revision: 1,
      model: { comments: [{ body: 'remote' }] },
    })
    expect(
      restored.read({ ...sshWorkspace, id: 'project:other-worktree' }),
    ).toMatchObject({ revision: 0, model: { comments: [] } })
    expect(
      restored.read({
        ...sshWorkspace,
        root: hostPath(asHostId('ssh:other'), '/srv/repo'),
      }),
    ).toMatchObject({ revision: 0, model: { comments: [] } })
    await restored.dispose()
  })

  it.each([
    ['corrupt' as const, '{not-json'],
    ['future-version' as const, JSON.stringify({ version: 999, workspaces: [] })],
  ])('quarantines and reports %s user-authored data', async (kind, content) => {
    await store.dispose()
    await host.writeFile(file, content)
    store = await DocumentReviewStore.load(host, file)

    expect(store.notice()).toMatchObject({ kind, writeBlocked: false })
    const recoveryFile = store.notice()?.recoveryFile
    expect(recoveryFile).toBeTruthy()
    await expect(host.readTextFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await host.readTextFile(localPath(join(directory, recoveryFile!)))).toBe(
      content,
    )

    const localWorkspace = workspace('project:main', localPath('/repo'))
    await store.save(0, model(localWorkspace, localPath('/repo/readme.md'), 'kept'))
    expect(await host.readTextFile(file)).toContain('kept')
  })

  it('blocks replacement when quarantine itself cannot preserve the file', async () => {
    await store.dispose()
    await host.writeFile(file, '{broken')
    vi.spyOn(host.fileTransfer, 'renameNoReplace').mockRejectedValueOnce(
      new Error('read only'),
    )
    store = await DocumentReviewStore.load(host, file)

    expect(store.notice()).toEqual({ kind: 'corrupt', writeBlocked: true })
    const localWorkspace = workspace('project:main', localPath('/repo'))
    expect(() =>
      store.save(0, model(localWorkspace, localPath('/repo/readme.md'), 'no overwrite')),
    ).toThrow(/preserved document-review file/)
    expect(await host.readTextFile(file)).toBe('{broken')
  })

  it('orders writes and retains the last valid candidate after a failed write', async () => {
    const localWorkspace = workspace('project:main', localPath('/repo'))
    const first = model(localWorkspace, localPath('/repo/one.md'), 'one')
    const second = model(localWorkspace, localPath('/repo/two.md'), 'two')
    const actualWrite = host.writeFile.bind(host)
    const writes: string[] = []
    const gates = [deferred<void>(), deferred<void>()]
    vi.spyOn(host, 'writeFile').mockImplementation(async (path, content, options) => {
      writes.push(
        typeof content === 'string' ? content : Buffer.from(content).toString('utf8'),
      )
      await gates[writes.length - 1]!.promise
      return actualWrite(path, content, options)
    })

    const savingFirst = store.save(0, first)
    const savingSecond = store.save(1, second)
    await settle()
    expect(writes).toHaveLength(1)
    gates[0]!.resolve()
    await savingFirst
    await settle()
    expect(writes).toHaveLength(2)
    gates[1]!.resolve()
    await savingSecond
    expect(writes[0]).toContain('one')
    expect(writes[1]).toContain('two')

    vi.restoreAllMocks()
    vi.spyOn(host, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    const failed = model(localWorkspace, localPath('/repo/failed.md'), 'still here')
    await expect(store.save(2, failed)).rejects.toThrow(/disk full/)
    expect(store.read(localWorkspace)).toMatchObject({
      revision: 3,
      model: { comments: [{ body: 'still here' }] },
    })
  })

  it('rejects an invalid model before writing its bounded envelope', () => {
    const localWorkspace = workspace('project:main', localPath('/repo'))
    const valid = model(localWorkspace, localPath('/repo/readme.md'), 'valid')
    const invalid: DocumentReviewModel = {
      ...valid,
      comments: [{ ...valid.comments[0]!, body: 'x'.repeat(9 * 1024) }],
    }
    expect(() => store.save(0, invalid)).toThrow(/Invalid bounded/)
  })
})

function workspace(
  id: string,
  root: ReviewWorkspaceIdentity['root'],
): ReviewWorkspaceIdentity {
  return { id, root }
}

function model(
  target: ReviewWorkspaceIdentity,
  document: ReviewWorkspaceIdentity['root'],
  body: string,
): DocumentReviewModel {
  const content = 'before\ntarget\nafter\n'
  const digest = createHash('sha256').update(content).digest('hex')
  return {
    workspace: target,
    comments: [
      {
        id: `comment-${body.replaceAll(' ', '-')}`,
        workspace: target,
        document,
        body,
        lifecycle: 'draft',
        anchor: {
          snapshot: {
            algorithm: 'sha256',
            digest,
            byteLength: Buffer.byteLength(content),
          },
          range: { startLine: 2, endLine: 2 },
          excerpt: 'target',
          contextBefore: 'before\n',
          contextAfter: '\nafter',
          state: { status: 'current' },
        },
      },
    ],
    batches: [],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
