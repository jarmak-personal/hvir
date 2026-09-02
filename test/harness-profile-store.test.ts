import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HarnessProfileStore,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import { LocalHost } from '../src/main/project-host/local-host'
import { asHarnessProfileId, asHarnessProviderId, localPath } from '../src/shared'
import {
  createHarnessProfileFixture,
  type HarnessProfileFixture,
} from './fixtures/harness-profile-fixture'

describe('HarnessProfileStore', () => {
  let directory: string
  let host: LocalHost
  let store: HarnessProfileStore
  let input: HarnessProfileFixture['input']
  let literal: HarnessProfileFixture['literal']

  beforeEach(async () => {
    const fixture = await createHarnessProfileFixture()
    directory = fixture.directory
    host = fixture.host
    store = fixture.store
    input = fixture.input
    literal = fixture.literal
  })

  it('computes only immutable bare Shell and keeps harness defaults as templates', () => {
    expect(store.list().map(({ id }) => id)).toEqual(['plain-shell-default'])
    expect(providerTemplateProfiles().map(({ id }) => id)).toEqual([
      'claude-code-default',
      'codex-default',
      'pi-default',
      'gemini-cli-default',
      'github-copilot-cli-default',
      'cursor-cli-default',
    ])
    expect(() =>
      store.save({
        id: asHarnessProfileId('plain-shell-default'),
        input: input({
          displayName: 'Changed',
          providerId: asHarnessProviderId('plain-shell'),
        }),
      }),
    ).toThrow(/immutable/)
  })

  it('materializes selected templates as editable global profiles in catalog order', async () => {
    const created = await store.materializeTemplates([
      asHarnessProviderId('codex'),
      asHarnessProviderId('claude-code'),
    ])
    expect(created.map(({ providerId }) => providerId)).toEqual(['claude-code', 'codex'])
    expect(
      created.every(({ builtIn, scope }) => !builtIn && scope.kind === 'global'),
    ).toBe(true)
    expect(store.list()[0]?.id).toBe('plain-shell-default')

    const another = await store.materializeTemplates([asHarnessProviderId('claude-code')])
    expect(another[0]?.id).not.toBe(created[0]?.id)
    expect(
      store.list().filter(({ providerId }) => providerId === 'claude-code'),
    ).toHaveLength(2)
  })

  it('imports only exact legacy default ids and launch revisions', async () => {
    const imported = await store.importLegacyDefaults([
      {
        providerId: asHarnessProviderId('claude-code'),
        profileId: asHarnessProfileId('claude-code-default'),
        launchRevision: 3,
      },
      {
        providerId: asHarnessProviderId('codex'),
        profileId: asHarnessProfileId('codex-default'),
        launchRevision: 1,
      },
    ])
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({
      id: 'claude-code-default',
      providerId: 'claude-code',
      launchRevision: 3,
      builtIn: false,
    })
    expect(store.get(asHarnessProfileId('codex-default'))).toBeUndefined()
  })

  it('keeps cosmetic metadata separate from launch revision', async () => {
    const created = await store.save({ input: input() })
    const renamed = await store.save({
      id: created.id,
      expectedLaunchRevision: created.launchRevision,
      expectedMetadataRevision: created.metadataRevision,
      input: { ...created, displayName: 'Renamed', order: 5 },
    })
    expect(renamed.launchRevision).toBe(created.launchRevision)
    expect(renamed.metadataRevision).toBe(created.metadataRevision + 1)

    const launchChanged = await store.save({
      id: renamed.id,
      expectedLaunchRevision: renamed.launchRevision,
      expectedMetadataRevision: renamed.metadataRevision,
      input: {
        ...renamed,
        args: [{ parts: [{ kind: 'literal', value: '--add-dir' }] }],
      },
    })
    expect(launchChanged.launchRevision).toBe(created.launchRevision + 1)
    expect(launchChanged.metadataRevision).toBe(renamed.metadataRevision)
  })

  it('rejects stale launch edits even when metadata did not change', async () => {
    const created = await store.save({ input: input() })
    const firstEditor = await store.save({
      id: created.id,
      expectedLaunchRevision: created.launchRevision,
      expectedMetadataRevision: created.metadataRevision,
      input: { ...created, args: [literal('--add-dir'), literal('/first')] },
    })
    expect(firstEditor.metadataRevision).toBe(created.metadataRevision)

    expect(() =>
      store.save({
        id: created.id,
        expectedLaunchRevision: created.launchRevision,
        expectedMetadataRevision: created.metadataRevision,
        input: { ...created, args: [literal('--add-dir'), literal('/second')] },
      }),
    ).toThrow(/launch settings changed/)
    expect(store.get(created.id)).toEqual(firstEditor)
  })

  it('ignores obsolete risk fields without launch drift and omits them from new writes', async () => {
    const profileFile = localPath(join(directory, 'profiles.json'))
    const legacyId = asHarnessProfileId('codex-legacy-risk')
    const legacyInput = input({
      displayName: 'Legacy Codex',
      args: [literal('--model'), literal('o3')],
    })
    await host.writeFile(
      profileFile,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            ...legacyInput,
            id: legacyId,
            launchRevision: 4,
            metadataRevision: 2,
            providerContractVersion: 2,
            builtIn: false,
            risk: 'elevated',
            riskAcknowledgedRevision: 4,
          },
        ],
        pathGrants: [],
      }),
    )

    const restoredStore = await HarnessProfileStore.load(host, profileFile)
    const restored = restoredStore.get(legacyId)!
    expect(restored).toMatchObject({
      ...legacyInput,
      id: legacyId,
      launchRevision: 4,
      metadataRevision: 2,
      providerContractVersion: 2,
    })
    expect(restored).not.toHaveProperty('risk')
    expect(restored).not.toHaveProperty('riskAcknowledgedRevision')

    const renamed = await restoredStore.save({
      id: restored.id,
      expectedLaunchRevision: restored.launchRevision,
      expectedMetadataRevision: restored.metadataRevision,
      input: { ...restored, displayName: 'Renamed legacy Codex' },
    })
    expect(renamed.launchRevision).toBe(4)
    const written = JSON.parse(await host.readTextFile(profileFile)) as {
      profiles: readonly Record<string, unknown>[]
    }
    expect(written.profiles[0]).not.toHaveProperty('risk')
    expect(written.profiles[0]).not.toHaveProperty('riskAcknowledgedRevision')
  })

  it('migrates a changed provider contract while ignoring obsolete risk metadata', async () => {
    const profileFile = localPath(join(directory, 'profiles.json'))
    const claudeId = asHarnessProfileId('claude-multi-account')
    const codexId = asHarnessProfileId('codex-stable')
    const claudeInput = input({
      displayName: 'Claude multi-account',
      providerId: asHarnessProviderId('claude-code'),
      args: [literal('--dangerously-skip-permissions')],
      environment: [
        { kind: 'literal', name: 'CLAUDE_CONFIG_DIR', value: '/tmp/claude-work' },
      ],
    })
    const codexInput = input({
      displayName: 'Codex stable',
      args: [literal('--model'), literal('o3')],
    })
    await host.writeFile(
      profileFile,
      JSON.stringify({
        version: 1,
        profiles: [
          {
            ...claudeInput,
            id: claudeId,
            launchRevision: 4,
            metadataRevision: 2,
            providerContractVersion: 1,
            builtIn: false,
            risk: 'unclassified',
            riskAcknowledgedRevision: 4,
          },
          {
            ...codexInput,
            id: codexId,
            launchRevision: 7,
            metadataRevision: 3,
            providerContractVersion: 1,
            builtIn: false,
            risk: 'unclassified',
            riskAcknowledgedRevision: 7,
          },
        ],
        pathGrants: [],
      }),
    )

    const migrated = await HarnessProfileStore.load(host, profileFile)
    expect(migrated.get(claudeId)).toMatchObject({
      providerContractVersion: 3,
      launchRevision: 5,
      metadataRevision: 2,
    })
    expect(migrated.get(codexId)).toMatchObject({
      providerContractVersion: 2,
      launchRevision: 8,
      metadataRevision: 3,
    })
    expect(migrated.get(claudeId)).not.toHaveProperty('risk')
    expect(migrated.get(codexId)).not.toHaveProperty('riskAcknowledgedRevision')
    const written = JSON.parse(await host.readTextFile(profileFile)) as {
      profiles: readonly Record<string, unknown>[]
    }
    expect(
      written.profiles.every(
        (profile) => !('risk' in profile) && !('riskAcknowledgedRevision' in profile),
      ),
    ).toBe(true)
  })

  it('does not recreate a concurrently deleted profile', async () => {
    const created = await store.save({ input: input() })
    await store.delete(created.id)
    expect(() =>
      store.save({
        id: created.id,
        expectedLaunchRevision: created.launchRevision,
        expectedMetadataRevision: created.metadataRevision,
        input: { ...created, displayName: 'Stale editor' },
      }),
    ).toThrow(/was deleted/)
  })

  it('rolls memory back when a profile save or delete write fails', async () => {
    const write = vi
      .spyOn(host, 'writeFile')
      .mockRejectedValueOnce(new Error('disk full'))
    const saving = store.save({ input: input({ displayName: 'Must not survive' }) })
    await expect(saving).rejects.toThrow(/disk full/)
    expect(
      store.list().some(({ displayName }) => displayName === 'Must not survive'),
    ).toBe(false)
    write.mockRestore()

    const existing = await store.save({ input: input({ displayName: 'Keep me' }) })
    const deleteWrite = vi
      .spyOn(host, 'writeFile')
      .mockRejectedValueOnce(new Error('read only'))
    await expect(store.delete(existing.id)).rejects.toThrow(/read only/)
    expect(store.get(existing.id)).toEqual(existing)
    deleteWrite.mockRestore()
  })

  it('persists, duplicates, and deletes user profiles atomically', async () => {
    const created = await store.save({ input: input() })
    const duplicate = await store.duplicate(created.id)
    expect(duplicate.id).not.toBe(created.id)
    expect(duplicate.displayName).toBe('Codex workspace copy')
    await store.delete(created.id)
    await store.flush()

    const restored = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
    expect(restored.get(created.id)).toBeUndefined()
    expect(restored.get(duplicate.id)).toEqual(duplicate)
  })

  it('validates structured arguments, bindings, environment, and Custom profiles', async () => {
    expect(() =>
      store.save({
        input: input({
          args: [{ parts: [{ kind: 'literal', value: '$(touch nope)' }] }],
        }),
      }),
    ).toThrow(/interpolation/)

    const custom = await store.save({
      input: input({
        displayName: 'Future CLI',
        providerId: asHarnessProviderId('custom'),
        executable: { kind: 'command', command: 'future-agent' },
      }),
    })
    expect(custom.providerId).toBe('custom')

    expect(() =>
      store.save({
        input: input({
          environment: [
            { kind: 'literal', name: 'DUPLICATE', value: 'one' },
            { kind: 'unset', name: 'DUPLICATE' },
          ],
        }),
      }),
    ).toThrow(/Duplicate environment/)
  })

  it('treats permission flags as launch data while reserving session selectors', async () => {
    const claude = await store.save({
      input: input({
        providerId: asHarnessProviderId('claude-code'),
        args: [literal('--dangerously-skip-permissions=true')],
        environment: [
          { kind: 'literal', name: 'CLAUDE_CONFIG_DIR', value: '/tmp/claude-risk' },
        ],
      }),
    })
    expect(claude.args).toEqual([literal('--dangerously-skip-permissions=true')])

    const codex = await store.save({
      input: input({
        args: [literal('-c'), literal('sandbox_mode="danger-full-access"')],
      }),
    })
    expect(codex.args).toEqual([
      literal('-c'),
      literal('sandbox_mode="danger-full-access"'),
    ])

    const geminiAutoEdit = await store.save({
      input: input({
        providerId: asHarnessProviderId('gemini-cli'),
        args: [literal('--approval-mode'), literal('auto_edit')],
      }),
    })
    expect(geminiAutoEdit.args).toEqual([
      literal('--approval-mode'),
      literal('auto_edit'),
    ])

    const geminiUnknownApproval = await store.save({
      input: input({
        providerId: asHarnessProviderId('gemini-cli'),
        args: [literal('--approval-mode=preview')],
      }),
    })
    expect(geminiUnknownApproval.args).toEqual([literal('--approval-mode=preview')])

    expect(() =>
      store.save({
        input: input({
          providerId: asHarnessProviderId('claude-code'),
          args: [literal('--session-id=not-owned-by-the-profile')],
        }),
      }),
    ).toThrow(/owned by the harness provider/)
  })

  it('persists explicit grants for host-qualified paths outside the project', async () => {
    const outside = join(directory, 'outside')
    await mkdir(outside)
    const grant = await store.authorizePath(localPath(outside))
    expect(store.hasPathGrant(grant.id, localPath(outside))).toBe(true)
    await store.flush()
    const restored = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
    expect(restored.hasPathGrant(grant.id, localPath(outside))).toBe(true)
  })

  it('recovers from corrupt metadata and filters project-scoped profiles', async () => {
    const profileFile = localPath(join(directory, 'profiles.json'))
    await host.writeFile(profileFile, '{not-json')
    const recovered = await HarnessProfileStore.load(host, profileFile)
    expect(recovered.list().map(({ id }) => id)).toContain('plain-shell-default')

    const firstRoot = localPath(join(directory, 'first'))
    const secondRoot = localPath(join(directory, 'second'))
    const scoped = await recovered.save({
      input: input({ scope: { kind: 'project', projectRoot: firstRoot } }),
    })
    expect(recovered.list(firstRoot)).toContainEqual(scoped)
    expect(recovered.list(secondRoot)).not.toContainEqual(scoped)
  })

  it('keeps no-op saves stable and rejects bounded-record overflow', async () => {
    const created = await store.save({ input: input() })
    const unchanged = await store.save({
      id: created.id,
      expectedLaunchRevision: created.launchRevision,
      expectedMetadataRevision: created.metadataRevision,
      input: created,
    })
    expect(unchanged.launchRevision).toBe(created.launchRevision)
    expect(unchanged.metadataRevision).toBe(created.metadataRevision)

    expect(() =>
      store.save({
        input: input({
          args: Array.from({ length: 129 }, () => ({
            parts: [{ kind: 'literal' as const, value: 'bounded' }],
          })),
        }),
      }),
    ).toThrow(/Invalid profile arguments/)
  })
})
