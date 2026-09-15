import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import { readSkillagerDocument } from '../src/main/skillager/skillager-document-read'
import { localPath, joinHostPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'

async function fixture(kind: 'library' | 'stub' = 'library') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-skill-document-')))
  const library = {
    id: 'library',
    root: localPath(join(root, 'library')),
    skillsRoot: localPath(join(root, 'library/skills')),
  }
  const workspaceRoot = localPath(join(root, 'project'))
  const skillRoot =
    kind === 'library'
      ? joinHostPath(library.skillsRoot, 'example')
      : joinHostPath(workspaceRoot, '.agents/skills/example')
  await mkdir(join(skillRoot.path, 'notes'), { recursive: true })
  await mkdir(workspaceRoot.path, { recursive: true })
  await writeFile(join(skillRoot.path, 'SKILL.md'), '# Actual current body\r\n')
  await writeFile(join(skillRoot.path, 'notes/guide.md'), '# Guide')
  await writeFile(join(skillRoot.path, 'image.png'), Uint8Array.of(1, 2, 3))
  await writeFile(join(skillRoot.path, 'page.html'), '<h1>Current HTML</h1>')
  const host = new LocalHost(),
    resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const unexpected = vi.fn(() => Promise.reject(Error('Unexpected acceptance operation')))
  const previews = {
    create: vi.fn(() => ({ id: 'html', url: 'hvir-preview://document/html/index.html' })),
    release: vi.fn(),
  }
  const reviews = new SkillagerReviewOwner(
    { review: unexpected, history: unexpected, diff: unexpected, accept: unexpected },
    resources.scopes,
    previews,
    { previewExposure: unexpected, updateSourceHash: unexpected },
  )
  let live = true
  const assertCurrent = () => {
    if (!live) throw Error('Revoked document')
  }
  const grant = {
    selection: {
      executable: localPath('/skillager'),
      catalog: localPath(join(root, 'catalog')),
      environment: {},
      version: 'skillager 0.9.2',
      library,
    },
    assertCurrent,
  }
  const access = {
    host,
    root: kind === 'library' ? library.skillsRoot : workspaceRoot,
    assertCurrent,
  }
  const cli = {
    documentAccess: vi.fn(() => Promise.resolve(access)),
    validateDocument: vi.fn(() => Promise.resolve()),
  }
  const project = vi.fn(() => Promise.resolve(access))
  const request: SkillagerContentRequest = {
    connectionId: 'connection',
    requestId: 1,
    agent: 'codex',
    workspaceRoot,
    selection: {
      kind,
      skillId: 'lib/example',
      libraryId: kind === 'library' ? library.id : undefined,
      root: skillRoot,
      path: joinHostPath(skillRoot, 'SKILL.md'),
    },
  }
  onTestFinished(async () => {
    await reviews.revoke()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    skillRoot,
    host,
    resources,
    owner,
    previews,
    reviews,
    unexpected,
    grant,
    access,
    cli,
    project,
    request,
    revoke: () => {
      live = false
    },
  }
}
it.each(['library', 'stub'] as const)(
  'reads %s current bytes with its own host grant, no acceptance authority, and releases content/HTML',
  async (kind) => {
    const f = await fixture(kind)
    const document = await f.reviews.openDocument(
      f.owner,
      f.request,
      f.grant,
      f.cli,
      f.project,
    )
    expect(document.content.text).toBe('# Actual current body\r\n')
    expect(document).not.toHaveProperty('reviewId')
    expect(document).not.toHaveProperty('canAccept')
    expect(f.cli.documentAccess).toHaveBeenCalledTimes(kind === 'library' ? 1 : 0)
    expect(f.project).toHaveBeenCalledTimes(kind === 'library' ? 0 : 1)
    const request = { ...f.request, contentId: document.contentId, entry: 'page.html' }
    expect((await f.reviews.documentContent(f.owner, request)).htmlUrl).toContain(
      'hvir-preview:',
    )
    expect(() =>
      f.reviews.content(f.owner, {
        ...f.request,
        reviewId: document.contentId,
        entry: 'SKILL.md',
      }),
    ).toThrow()
    await f.reviews.releaseDocument(f.owner, document.contentId)
    expect(f.previews.release).toHaveBeenCalledWith('html')
    await expect(f.reviews.documentContent(f.owner, request)).rejects.toThrow(
      'no longer open',
    )
    expect(f.unexpected).not.toHaveBeenCalled()
  },
)
it('refuses foreign library/project paths before reading and requires the local no-follow capability', async () => {
  const f = await fixture()
  await expect(
    f.reviews.openDocument(
      f.owner,
      { ...f.request, selection: { ...f.request.selection, libraryId: 'other' } },
      f.grant,
      f.cli,
      f.project,
    ),
  ).rejects.toThrow('Reconnect')
  expect(f.cli.documentAccess).not.toHaveBeenCalled()
  await expect(
    f.reviews.openDocument(
      f.owner,
      { ...f.request, selection: { ...f.request.selection, kind: 'project-original' } },
      f.grant,
      f.cli,
      f.project,
    ),
  ).rejects.toThrow('outside this project')
  await expect(
    readSkillagerDocument(
      {
        ...f.access,
        host: {
          ...f.access.host,
          hostId: f.host.hostId,
          stat: f.host.stat.bind(f.host),
          realpath: f.host.realpath.bind(f.host),
          fileTransfer: {
            readFileChunks: (path, options) =>
              f.host.fileTransfer.readFileChunks(path, options),
          },
        },
      },
      f.skillRoot,
      f.request.selection.path,
      AbortSignal.timeout(1000),
      true,
    ),
  ).rejects.toThrow('unavailable')
})
it('confines automatic images even through aliases and refuses non-images before physical reads', async () => {
  const f = await fixture('stub')
  const document = await f.reviews.openDocument(
    f.owner,
    f.request,
    f.grant,
    f.cli,
    f.project,
  )
  const request = { ...f.request, contentId: document.contentId }
  await f.reviews.documentContent(f.owner, { ...request, entry: 'notes/guide.md' })
  await symlink('../image.png', join(f.skillRoot.path, 'notes/escape.png'))
  const read = vi.spyOn(f.host.fileTransfer, 'readFileChunks')
  await expect(
    f.reviews.documentContent(f.owner, {
      ...request,
      entry: 'notes/escape.png',
      documentEntry: 'notes/guide.md',
    }),
  ).rejects.toThrow('escapes')
  await expect(
    f.reviews.documentContent(f.owner, {
      ...request,
      entry: 'page.html',
      documentEntry: 'SKILL.md',
    }),
  ).rejects.toThrow('Only image')
  expect(read).not.toHaveBeenCalled()
  expect(
    (
      await f.reviews.documentContent(f.owner, {
        ...request,
        entry: 'image.png',
        documentEntry: 'SKILL.md',
      })
    ).image?.bytes,
  ).toEqual(Buffer.from([1, 2, 3]))
})
it('cancels an in-flight read on renderer revocation and never publishes its late bytes', async () => {
  const f = await fixture()
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.cli.validateDocument.mockImplementation(async () => {
    entered()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    f.revoke()
  })
  const pending = f.reviews.openDocument(f.owner, f.request, f.grant, f.cli, f.project)
  const refusal = expect(pending).rejects.toThrow()
  await started
  await f.resources.destroyOwner(f.owner.id)
  await refusal
  expect(f.previews.create).not.toHaveBeenCalled()
})
it('refuses escaping symlinks and a file over the retained byte limit before streaming', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'outside'), 'outside')
  await symlink(join(f.root, 'outside'), join(f.skillRoot.path, 'escape.md'))
  const stream = vi.spyOn(f.host.fileTransfer, 'readFileChunksNoFollow')
  await expect(
    readSkillagerDocument(
      f.access,
      f.skillRoot,
      joinHostPath(f.skillRoot, 'escape.md'),
      AbortSignal.timeout(1000),
      true,
    ),
  ).rejects.toThrow('escapes')
  vi.spyOn(f.host, 'stat').mockResolvedValue({
    type: 'file',
    size: 8 * 1024 * 1024 + 1,
    mode: 0o644,
    mtimeMs: 1,
  })
  await expect(
    readSkillagerDocument(
      f.access,
      f.skillRoot,
      f.request.selection.path,
      AbortSignal.timeout(1000),
      true,
    ),
  ).rejects.toThrow('8 MiB')
  expect(stream).not.toHaveBeenCalled()
})
