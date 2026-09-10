import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { IpcAuthority } from '../src/main/ipc/authority-router'
import { authorizeDocumentRead } from '../src/main/viewer/document-read-authority'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import {
  asHostId,
  hostPath,
  localPath,
  type HostPath,
  type ProjectState,
} from '../src/shared'

function fixture(id = 'local', canonicalRoot = '/tmp') {
  const qualify = (path: string): HostPath => hostPath(asHostId(id), path)
  let root = qualify('/project')
  const realpath = vi.fn((path: HostPath) => {
    if (path.path === '/tmp') return Promise.resolve(qualify(canonicalRoot))
    return Promise.resolve(qualify(path.path.replace(/^\/tmp\//, `${canonicalRoot}/`)))
  })
  const host = {
    hostId: asHostId(id),
    connectionState: 'connected',
    realpath,
  } as unknown as ProjectHost
  const authority = new IpcAuthority({
    getProject: () => ({ root, host }),
    getRegisteredWorkspaceRoot: () => root,
    getProjectState: () => ({ projects: [] }) as unknown as ProjectState,
  })
  return {
    authority,
    host,
    realpath,
    qualify,
    root,
    switch: () => {
      root = qualify('/other')
    },
  }
}

describe('outside-project document authority', () => {
  it.each(['local', 'ssh-dev'])(
    'admits supported locations and formats on %s without mutation authority',
    async (id) => {
      const f = fixture(id)
      for (const name of [
        '/sibling-worktree/main.ts',
        '/agents/result.json',
        '/scratch/report.md',
        '/tmp/code.ts',
        '/private/tmp/report.html',
        '/etc/hosts',
      ]) {
        const path = f.qualify(name)
        const access = await authorizeDocumentRead(f.authority, {
          path,
          workspaceRoot: f.root,
        })
        expect(access.path).toEqual(path)
        expect(access.external).toBe(true)
        expect(access.host).toBe(f.host)
        await expect(f.authority.projectPath(path)).rejects.toThrow(/escapes/)
      }
    },
  )

  it('canonicalizes macOS temporary aliases with the same rule as other files', async () => {
    const f = fixture('local', '/private/tmp')
    const access = await authorizeDocumentRead(f.authority, {
      path: f.qualify('/tmp/code.ts'),
      workspaceRoot: f.root,
    })
    expect(access.path).toEqual(f.qualify('/private/tmp/code.ts'))
    expect(access.external).toBe(true)
  })

  it('classifies a project symlink by its resolved target', async () => {
    const f = fixture()
    f.realpath.mockImplementation((path) =>
      Promise.resolve(
        path.path === '/project/link.ts' ? f.qualify('/scratch/main.ts') : path,
      ),
    )
    const access = await authorizeDocumentRead(f.authority, {
      path: f.qualify('/project/link.ts'),
      workspaceRoot: f.root,
    })
    expect(access.path).toEqual(f.qualify('/scratch/main.ts'))
    expect(access.external).toBe(true)
    await expect(f.authority.projectPath(f.qualify('/project/link.ts'))).rejects.toThrow(
      /symlink/,
    )
  })

  it('requires exact host, normalized path, and originating active workspace', async () => {
    const f = fixture('ssh-dev')
    for (const request of [
      { path: f.qualify('/scratch/plan.md') },
      { path: localPath('/scratch/plan.md'), workspaceRoot: f.root },
      { path: f.qualify('/scratch/plan.md'), workspaceRoot: f.qualify('/other') },
      {
        path: { hostId: asHostId('ssh-dev'), path: '/tmp/../etc/plan.md' } as HostPath,
        workspaceRoot: f.root,
      },
    ])
      await expect(authorizeDocumentRead(f.authority, request)).rejects.toThrow()
    expect(f.realpath).not.toHaveBeenCalled()
  })

  it.each(['local', 'ssh-dev'])(
    'confines automatic %s images to the source directory',
    async (id) => {
      const f = fixture(id)
      const request = {
        workspaceRoot: f.root,
        documentPath: f.qualify('/scratch/report.md'),
      }
      for (const name of ['/scratch/chart.png', '/scratch/assets/chart.png']) {
        const access = await authorizeDocumentRead(
          f.authority,
          { ...request, path: f.qualify(name) },
          'asset',
        )
        expect(access.path).toEqual(f.qualify(name))
        expect(access.external).toBe(true)
      }
      for (const path of [
        f.qualify('/private/chart.png'),
        f.qualify('/scratch-lookalike/chart.png'),
        f.qualify('/project/chart.png'),
        f.qualify('/scratch/code.ts'),
        hostPath(asHostId('another'), '/scratch/chart.png'),
      ]) {
        await expect(
          authorizeDocumentRead(f.authority, { ...request, path }, 'asset'),
        ).rejects.toThrow()
      }
      await expect(
        authorizeDocumentRead(
          f.authority,
          { path: f.qualify('/scratch/chart.png'), workspaceRoot: f.root },
          'asset',
        ),
      ).rejects.toThrow(/source document/)
      // Canonical containment applies even when the image looks like a sibling.
      f.realpath.mockImplementation((path) =>
        Promise.resolve(
          path.path === '/scratch/link.png' ? f.qualify('/private/chart.png') : path,
        ),
      )
      await expect(
        authorizeDocumentRead(
          f.authority,
          { ...request, path: f.qualify('/scratch/link.png') },
          'asset',
        ),
      ).rejects.toThrow(/asset directory/)
      // Explicit document activation is independent of automatic asset admission.
      expect(
        (
          await authorizeDocumentRead(f.authority, {
            path: f.qualify('/private/chart.png'),
            workspaceRoot: f.root,
          })
        ).external,
      ).toBe(true)
    },
  )

  it('uses the canonical document directory, including a symlinked document', async () => {
    const f = fixture()
    f.realpath.mockImplementation((path) =>
      Promise.resolve(
        path.path === '/scratch/report.md' ? f.qualify('/agent/result/report.md') : path,
      ),
    )
    const request = {
      workspaceRoot: f.root,
      documentPath: f.qualify('/scratch/report.md'),
    }
    await expect(
      authorizeDocumentRead(
        f.authority,
        { ...request, path: f.qualify('/scratch/chart.png') },
        'asset',
      ),
    ).rejects.toThrow(/asset directory/)
    expect(
      (
        await authorizeDocumentRead(
          f.authority,
          { ...request, path: f.qualify('/agent/result/chart.png') },
          'asset',
        )
      ).path,
    ).toEqual(f.qualify('/agent/result/chart.png'))
  })

  it('rejects late resolution after workspace departure or disconnect', async () => {
    const f = fixture()
    const access = await authorizeDocumentRead(f.authority, {
      path: f.qualify('/scratch/plan.md'),
      workspaceRoot: f.root,
    })
    f.switch()
    expect(access.assertCurrent).toThrow(/workspace/)
    const disconnected = fixture()
    disconnected.realpath.mockImplementation((path) => {
      Object.assign(disconnected.host, { connectionState: 'disconnected' })
      return Promise.resolve(path)
    })
    await expect(
      authorizeDocumentRead(disconnected.authority, {
        path: disconnected.qualify('/scratch/plan.md'),
        workspaceRoot: disconnected.root,
      }),
    ).rejects.toThrow(/disconnected/)
  })

  it('uses real LocalHost resolution for symlinks, assets, and missing files', async () => {
    const directory = await mkdtemp('/tmp/hvir-document-authority-')
    const host = new LocalHost()
    const root = localPath(`${directory}/project`)
    try {
      await mkdir(root.path)
      await mkdir(`${directory}/scratch`)
      await writeFile(`${directory}/scratch/plan.md`, '# Plan')
      await writeFile(`${directory}/scratch/chart.png`, 'fixture')
      await symlink(`${directory}/scratch/plan.md`, `${root.path}/plan.md`)
      await symlink(`${directory}/scratch/chart.png`, `${root.path}/chart.png`)
      const authority = new IpcAuthority({
        getProject: () => ({ root, host }),
        getRegisteredWorkspaceRoot: () => root,
        getProjectState: () => ({ projects: [] }) as unknown as ProjectState,
      })
      const request = { path: localPath(`${root.path}/plan.md`), workspaceRoot: root }
      const access = await authorizeDocumentRead(authority, request)
      expect(access.external).toBe(true)
      expect((await host.readFile(access.path)).toString()).toBe('# Plan')
      const image = await authorizeDocumentRead(
        authority,
        {
          ...request,
          path: localPath(`${root.path}/chart.png`),
          documentPath: access.path,
        },
        'asset',
      )
      expect(image.path).toEqual(
        await host.realpath(localPath(`${directory}/scratch/chart.png`)),
      )
      await expect(
        authorizeDocumentRead(authority, {
          ...request,
          path: localPath(`${directory}/missing.md`),
        }),
      ).rejects.toThrow()
    } finally {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

it('keeps external aliases into a project read-only with document-scoped assets', async () => {
  const f = fixture()
  f.realpath.mockImplementation((path) =>
    Promise.resolve(
      path.path === '/scratch/alias.md' ? f.qualify('/project/docs/plan.md') : path,
    ),
  )
  expect(
    (
      await authorizeDocumentRead(f.authority, {
        path: f.qualify('/scratch/alias.md'),
        workspaceRoot: f.root,
      })
    ).external,
  ).toBe(true)
  const request = {
    workspaceRoot: f.root,
    documentPath: f.qualify('/project/docs/plan.md'),
  }
  await expect(
    authorizeDocumentRead(
      f.authority,
      { ...request, path: f.qualify('/project/private/chart.png') },
      'asset',
    ),
  ).rejects.toThrow(/asset directory/)
  expect(
    (
      await authorizeDocumentRead(
        f.authority,
        { ...request, path: f.qualify('/project/docs/chart.png') },
        'asset',
      )
    ).external,
  ).toBe(true)
})
