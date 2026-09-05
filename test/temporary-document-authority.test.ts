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

describe('temporary document read authority', () => {
  it.each([
    ['local', '/tmp'],
    ['local', '/private/tmp'],
    ['ssh-dev', '/tmp'],
    ['ssh-mac', '/private/tmp'],
  ])(
    'confines %s documents to canonical %s without registering a project',
    async (id, canonicalRoot) => {
      const f = fixture(id, canonicalRoot)
      const access = await authorizeDocumentRead(f.authority, {
        path: f.qualify('/tmp/plan.md'),
        workspaceRoot: f.root,
      })
      expect(access.path).toEqual(f.qualify(`${canonicalRoot}/plan.md`))
      expect(access.host).toBe(f.host)
      expect(access.temporary).toBe(true)
      if (canonicalRoot === '/private/tmp') {
        const alias = await authorizeDocumentRead(f.authority, {
          path: f.qualify('/private/tmp/plan.html'),
          workspaceRoot: f.root,
        })
        expect(alias.path).toEqual(f.qualify('/private/tmp/plan.html'))
      }
    },
  )

  it.each([
    '/tmp-lookalike/plan.md',
    '/etc/plan.md',
    '/var/folders/plan.md',
    '/tmp/code.ts',
    '/tmp',
  ])('rejects unsupported %s', async (path) => {
    const f = fixture()
    await expect(
      authorizeDocumentRead(f.authority, {
        path: localPath(path),
        workspaceRoot: f.root,
      }),
    ).rejects.toThrow()
    expect(f.realpath).not.toHaveBeenCalled()
  })

  it('requires exact host, normalized path, and originating active workspace', async () => {
    const f = fixture('ssh-dev')
    for (const request of [
      { path: f.qualify('/tmp/plan.md') },
      { path: localPath('/tmp/plan.md'), workspaceRoot: f.root },
      { path: f.qualify('/tmp/plan.md'), workspaceRoot: f.qualify('/other') },
      {
        path: { hostId: asHostId('ssh-dev'), path: '/tmp/../etc/plan.md' } as HostPath,
        workspaceRoot: f.root,
      },
    ])
      await expect(authorizeDocumentRead(f.authority, request)).rejects.toThrow()
    expect(f.realpath).not.toHaveBeenCalled()
  })

  it('does not trust escaping symlinks, redirected temporary roots, or Linux alias lookalikes', async () => {
    const f = fixture()
    f.realpath.mockImplementation((path) =>
      Promise.resolve(
        path.path === '/tmp' ? localPath('/tmp') : localPath('/etc/secret.md'),
      ),
    )
    await expect(
      authorizeDocumentRead(f.authority, {
        path: localPath('/tmp/plan.md'),
        workspaceRoot: f.root,
      }),
    ).rejects.toThrow(/symlink/)
    f.realpath.mockResolvedValue(localPath('/outside'))
    await expect(
      authorizeDocumentRead(f.authority, {
        path: localPath('/tmp/plan.md'),
        workspaceRoot: f.root,
      }),
    ).rejects.toThrow(/root/)
    const linux = fixture()
    await expect(
      authorizeDocumentRead(linux.authority, {
        path: localPath('/private/tmp/plan.md'),
        workspaceRoot: linux.root,
      }),
    ).rejects.toThrow(/root/)
  })

  it('revalidates workspace and connection after asynchronous resolution', async () => {
    const f = fixture()
    const access = await authorizeDocumentRead(f.authority, {
      path: localPath('/tmp/plan.md'),
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
        path: localPath('/tmp/plan.md'),
        workspaceRoot: disconnected.root,
      }),
    ).rejects.toThrow(/disconnected/)
  })

  it('keeps image-only reads separate from documents and mutation authority', async () => {
    const f = fixture()
    const request = { path: localPath('/tmp/image.png'), workspaceRoot: f.root }
    expect((await authorizeDocumentRead(f.authority, request, 'asset')).temporary).toBe(
      true,
    )
    await expect(authorizeDocumentRead(f.authority, request)).rejects.toThrow()
    await expect(f.authority.projectPath(localPath('/tmp/plan.md'))).rejects.toThrow(
      /escapes/,
    )
  })

  it('uses real LocalHost canonicalization for aliases, missing files, and escaping symlinks', async () => {
    const directory = await mkdtemp('/tmp/hvir-document-authority-')
    const host = new LocalHost()
    const root = localPath(`${directory}/project`)
    try {
      await mkdir(root.path)
      await writeFile(`${directory}/plan.md`, '# Plan')
      await symlink('/etc/hosts', `${directory}/escape.md`)
      const authority = new IpcAuthority({
        getProject: () => ({ root, host }),
        getRegisteredWorkspaceRoot: () => root,
        getProjectState: () => ({ projects: [] }) as unknown as ProjectState,
      })
      const request = { path: localPath(`${directory}/plan.md`), workspaceRoot: root }
      const access = await authorizeDocumentRead(authority, request)
      expect((await host.readFile(access.path)).toString()).toBe('# Plan')
      await expect(
        authorizeDocumentRead(authority, {
          ...request,
          path: localPath(`${directory}/escape.md`),
        }),
      ).rejects.toThrow(/symlink/)
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
