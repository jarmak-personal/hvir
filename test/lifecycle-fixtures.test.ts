import { access } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import { asHostId, asHarnessProviderId, hostPath } from '../src/shared'
import { createHarnessProfileFixture } from './fixtures/harness-profile-fixture'
import { createPtySupervisorFixture } from './fixtures/pty-supervisor-fixture'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

describe('domain-owned lifecycle fixtures', () => {
  it('isolates profile stores, revisions, grants, launch specs, and provider state', async () => {
    const [first, second] = await Promise.all([
      createHarnessProfileFixture(),
      createHarnessProfileFixture(),
    ])
    const canonicalOutside = await first.host.realpath(first.outsideRoot)
    const grant = await first.store.authorizePath(canonicalOutside)
    const created = await first.store.save({
      input: first.input({
        args: [
          first.literal('--add-dir'),
          { parts: [{ kind: 'path', source: 'binding', binding: 'outside' }] },
        ],
        pathBindings: [{ name: 'outside', path: canonicalOutside, grantId: grant.id }],
      }),
    })
    const revised = await first.store.save({
      id: created.id,
      expectedLaunchRevision: created.launchRevision,
      expectedMetadataRevision: created.metadataRevision,
      input: { ...created, args: [...created.args, first.literal('--search')] },
    })
    const resolved = await first.resolve(revised, 'fresh', first.workspaceRoot)

    expect(first.directory).not.toBe(second.directory)
    expect(second.store.list()).toHaveLength(1)
    expect(revised.launchRevision).toBe(created.launchRevision + 1)
    expect(first.store.hasPathGrant(grant.id, canonicalOutside)).toBe(true)
    expect(second.store.hasPathGrant(grant.id, canonicalOutside)).toBe(false)
    expect(resolved).toMatchObject({
      provider: { manifest: { id: asHarnessProviderId('codex') } },
      spec: { file: 'codex' },
    })
    expect(resolved.spec.args).toContain(canonicalOutside.path)

    await Promise.all([first.dispose(), first.dispose()])
    await expect(access(first.directory)).rejects.toThrow()
    expect(second.store.list()).toHaveLength(1)
  })

  it('keeps PTY seams host-qualified and rejects a spawn completed after teardown', async () => {
    const local = createPtySupervisorFixture()
    const sshHostId = asHostId('ssh-fixture')
    const ssh = createPtySupervisorFixture({
      hostId: sshHostId,
      root: hostPath(sshHostId, '/srv/project'),
    })
    await Promise.all([
      local.spawn({ sessionId: 'local-session' }),
      ssh.spawn({ sessionId: 'ssh-session' }),
    ])

    expect(local.snapshot()).toMatchObject({
      sessions: [{ id: 'local-session', cwd: local.root }],
      diagnostics: [{ kind: 'pty-spawned', hostKind: 'local' }],
    })
    expect(ssh.snapshot()).toMatchObject({
      sessions: [{ id: 'ssh-session', hostId: sshHostId, cwd: ssh.root }],
      diagnostics: [{ kind: 'pty-spawned', hostKind: 'ssh' }],
    })

    const partial = createPtySupervisorFixture()
    const { spawnPty } = partial
    const deferred = partial.deferNextSpawn()
    const spawning = partial.spawn({ sessionId: 'partial-start' })
    await vi.waitFor(() => expect(spawnPty).toHaveBeenCalledOnce())
    partial.dispose()
    partial.dispose()
    deferred.resolve()

    await expect(spawning).rejects.toThrow('cancelled before it started')
    expect(deferred.pty.kill).toHaveBeenCalledOnce()
    expect(partial.snapshot().sessions).toEqual([])
  })

  it('revokes renderer generations before deterministic LIFO cleanup completes', async () => {
    const fixture = createRendererResourceFixture()
    const owner = fixture.activateOwner()
    const deferred = fixture.deferredCleanup()
    fixture.register(owner, { lifetime: 'renderer', type: 'attention' }, 'first')
    fixture.register(
      owner,
      {
        lifetime: 'workspace',
        type: 'pty-session',
        root: fixture.sshRoot,
        id: 'terminal',
      },
      'second',
      () => deferred.promise,
    )

    const transition = fixture.rolloverOwner(owner.id)

    expect(fixture.scopes.isCurrent(owner)).toBe(false)
    expect(fixture.scopes.isCurrent(transition.owner)).toBe(true)
    expect(() =>
      fixture.register(
        owner,
        {
          lifetime: 'workspace',
          type: 'pty-session',
          root: fixture.localRoot,
          id: 'late',
        },
        'late',
      ),
    ).toThrow('has been revoked')
    await vi.waitFor(() => expect(fixture.snapshot().events).toContain('disposed:second'))
    expect(fixture.snapshot().events).not.toContain('disposed:first')

    deferred.resolve()
    await transition.cleanup
    expect(fixture.snapshot().events).toEqual([
      'owner:10:1',
      'disposed:second',
      'rollover:10:2',
      'disposed:first',
    ])
    await Promise.all([
      fixture.destroyOwner(transition.owner.id),
      fixture.destroyOwner(transition.owner.id),
      fixture.dispose(),
      fixture.dispose(),
    ])
  })
})
