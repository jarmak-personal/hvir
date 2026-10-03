import { afterEach, describe, expect, it } from 'vitest'
import { sourceFixture } from './fixtures/extension-source'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
const fixtures: ReturnType<typeof sourceFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.dispose()
})
function fixture(context: 'application' | 'workspace' = 'application') {
  const f = sourceFixture(context)
  fixtures.push(f)
  return f
}
function barrier() {
  let resume!: () => void, entered!: () => void
  const blocked = new Promise<void>((resolve) => {
      resume = resolve
    }),
    reached = new Promise<void>((resolve) => {
      entered = resolve
    })
  return { resume, entered, blocked, reached }
}
describe('trusted extension source grants', () => {
  it('requires a distinct trusted root decision and retains only the current declaration', async () => {
    const f = fixture()
    await f.approvals.start()
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    const prepared = await f.approvals.prepare(
      { installationId: 'installation', source: 'source', root: f.root },
      () => {},
    )
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    await f.approvals.approve(prepared.token)
    expect(f.approvals.status(f.activation)).toEqual([
      { source: 'source', granted: true, root: f.root },
    ])
    const newActivation = { ...f.activation, generation: 'new-generation' }
    f.active.set('installation', newActivation)
    expect(f.approvals.get(newActivation, 'source')).toBeDefined()
    const changed = {
      ...newActivation,
      revision: {
        ...newActivation.revision,
        manifest: {
          ...newActivation.revision.manifest,
          access: [{ ...f.declaration, description: 'Changed scope request' }],
        },
      },
    }
    f.active.set('installation', changed)
    expect(f.approvals.get(changed, 'source')).toBeUndefined()
  })
  it.each(['writable', 'canonical', 'save'] as const)(
    'revocation wins over approval suspended in %s',
    async (boundary) => {
      const f = fixture()
      await f.approvals.start()
      const prepared = await f.approvals.prepare(
        { installationId: 'installation', source: 'source', root: f.root },
        () => {},
      )
      const b = barrier()
      if (boundary === 'writable')
        f.authority.assertWritable.mockImplementationOnce(async () => {
          b.entered()
          await b.blocked
        })
      else if (boundary === 'canonical')
        f.host.realpath.mockImplementationOnce(async (path) => {
          b.entered()
          await b.blocked
          return path
        })
      else {
        const save = f.authority.saveSourceGrants.getMockImplementation()!
        f.authority.saveSourceGrants.mockImplementationOnce(async (value, current) => {
          b.entered()
          await b.blocked
          await save(value, current)
        })
      }
      const approving = f.approvals.approve(prepared.token),
        rejected = expect(approving).rejects.toThrow(/revoked|ended/)
      await b.reached
      const revoking = f.approvals.revoke('installation', 'source')
      b.resume()
      await rejected
      await revoking
      expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
      expect(f.state()).toEqual([])
    },
  )
  it('keeps replacement and revocation ordered while persistence is suspended', async () => {
    const f = fixture()
    await f.grant()
    const replacement = await f.approvals.prepare(
      { installationId: 'installation', source: 'source', root: f.root },
      () => {},
    )
    const b = barrier(),
      save = f.authority.saveSourceGrants.getMockImplementation()!
    f.authority.saveSourceGrants.mockImplementationOnce(async (value, current) => {
      b.entered()
      await b.blocked
      await save(value, current)
    })
    const replacing = f.approvals.approve(replacement.token)
    const rejected = expect(replacing).rejects.toThrow(/revoked|ended/)
    await b.reached
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    const revoking = f.approvals.revoke('installation', 'source')
    b.resume()
    await rejected
    await revoking
    expect(f.state()).toEqual([])
    await f.approvals.start()
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
  })
  it('cannot re-create a prepared decision after revocation during inspection', async () => {
    const f = fixture()
    await f.approvals.start()
    const b = barrier()
    f.host.realpath.mockImplementationOnce(async (path) => {
      b.entered()
      await b.blocked
      return path
    })
    const preparing = f.approvals.prepare(
        { installationId: 'installation', source: 'source', root: f.root },
        () => {},
      ),
      rejected = expect(preparing).rejects.toThrow(/revoked/)
    await b.reached
    const revoking = f.approvals.revoke('installation', 'source')
    b.resume()
    await rejected
    await revoking
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
  })
  it('rejects remote application roots, guessed workspace roots and changed canonical roots', async () => {
    const f = fixture()
    await f.approvals.start()
    await expect(
      f.approvals.prepare(
        {
          installationId: 'installation',
          source: 'source',
          root: hostPath(asHostId('remote'), '/library'),
        },
        () => {},
      ),
    ).rejects.toThrow(/local/)
    const prepared = await f.approvals.prepare(
      { installationId: 'installation', source: 'source', root: f.root },
      () => {},
    )
    f.host.realpath.mockResolvedValueOnce(localPath('/other'))
    await expect(f.approvals.approve(prepared.token)).rejects.toThrow(/changed/)
    const workspace = fixture('workspace')
    await workspace.approvals.start()
    await expect(
      workspace.approvals.prepare(
        { installationId: 'installation', source: 'source', root: f.root },
        () => {},
      ),
    ).rejects.toThrow(/registered/)
  })
  it('persists one exact registered workspace choice and refuses later registration, root or host changes', async () => {
    const f = fixture('workspace')
    await f.grant()
    expect(f.state()).toEqual([
      {
        installationId: 'installation',
        declaration: f.declaration,
        workspaceId: 'workspace',
        root: f.root,
      },
    ])
    await f.approvals.start()
    expect(f.approvals.get(f.activation, 'source')).toMatchObject({
      workspaceId: 'workspace',
      root: f.root,
    })
    f.workspaces.push({ ...f.workspaces[0]!, id: 'future' })
    f.workspaces.shift()
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    await expect(
      f.approvals.prepare(
        { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
        () => {},
      ),
    ).rejects.toThrow(/registered/)
    f.workspaces[0] = {
      ...f.workspaces[0]!,
      id: 'workspace',
      root: localPath('/replacement'),
    }
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    f.workspaces[0] = { ...f.workspaces[0], root: f.root }
    f.host.connectionState = 'disconnected'
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
  })
  it('rejects workspace replacement while the prepared decision is suspended in save', async () => {
    const f = fixture('workspace')
    await f.approvals.start()
    const prepared = await f.approvals.prepare(
      { installationId: 'installation', source: 'source', workspaceId: 'workspace' },
      () => {},
    )
    const b = barrier(),
      save = f.authority.saveSourceGrants.getMockImplementation()!
    f.authority.saveSourceGrants.mockImplementationOnce(async (value, current) => {
      b.entered()
      await b.blocked
      await save(value, current)
    })
    const approving = f.approvals.approve(prepared.token),
      rejected = expect(approving).rejects.toThrow(/ended/)
    await b.reached
    f.workspaces[0] = { ...f.workspaces[0]!, root: localPath('/replacement') }
    b.resume()
    await rejected
    expect(f.state()).toEqual([])
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
  })
  it('forgets grants while retaining external content untouched', async () => {
    const f = fixture()
    await f.grant()
    expect(f.approvals.forget('installation')).toEqual([])
    expect(f.approvals.get(f.activation, 'source')).toBeUndefined()
    expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
  })
})
