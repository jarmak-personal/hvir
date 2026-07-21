import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HarnessProfileStore,
  providerTemplateProfiles,
} from '../src/main/harness/harness-profile-store'
import { LocalHost } from '../src/main/project-host/local-host'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfileInput,
} from '../src/shared'

describe('HarnessProfileStore', () => {
  let directory: string
  let host: LocalHost
  let store: HarnessProfileStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-profiles-'))
    host = new LocalHost()
    await host.connect()
    store = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
  })

  afterEach(async () => {
    await store.flush().catch(() => undefined)
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
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
        launchRevision: 2,
      },
      {
        providerId: asHarnessProviderId('codex'),
        profileId: asHarnessProfileId('codex-default'),
        launchRevision: 2,
      },
    ])
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({
      id: 'claude-code-default',
      providerId: 'claude-code',
      launchRevision: 2,
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

  it('persists risk acknowledgment per launch revision and clears it on launch edits', async () => {
    const created = await store.save({
      input: input({ args: [literal('--model'), literal('o3')] }),
    })
    expect(created.risk).toBe('unclassified')
    const acknowledged = await store.acknowledgeRisk(created.id, created.launchRevision)
    expect(acknowledged.riskAcknowledgedRevision).toBe(created.launchRevision)
    await store.flush()
    const restored = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
    expect(restored.get(created.id)?.riskAcknowledgedRevision).toBe(
      created.launchRevision,
    )

    const renamed = await store.save({
      id: acknowledged.id,
      expectedLaunchRevision: acknowledged.launchRevision,
      expectedMetadataRevision: acknowledged.metadataRevision,
      input: { ...acknowledged, displayName: 'Remembered acknowledgment' },
    })
    expect(renamed.riskAcknowledgedRevision).toBe(renamed.launchRevision)

    const launchChanged = await store.save({
      id: renamed.id,
      expectedLaunchRevision: renamed.launchRevision,
      expectedMetadataRevision: renamed.metadataRevision,
      input: { ...renamed, args: [literal('--model'), literal('o4')] },
    })
    expect(launchChanged.riskAcknowledgedRevision).toBeUndefined()

    expect(() => store.acknowledgeRisk(launchChanged.id, renamed.launchRevision)).toThrow(
      /configuration changed/,
    )
  })

  it('invalidates Claude v1 recovery and acknowledgment while preserving other providers', async () => {
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
      providerContractVersion: 2,
      launchRevision: 5,
      metadataRevision: 2,
      risk: 'elevated',
      riskAcknowledgedRevision: undefined,
    })
    expect(migrated.get(codexId)).toMatchObject({
      providerContractVersion: 1,
      launchRevision: 7,
      metadataRevision: 3,
      risk: 'unclassified',
      riskAcknowledgedRevision: 7,
    })
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

  it('validates structured arguments, bindings, environment, and Custom risk', async () => {
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
    expect(custom.risk).toBe('unclassified')

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

  it('classifies provider-known bypass forms and reserves session selectors', async () => {
    const claude = await store.save({
      input: input({
        providerId: asHarnessProviderId('claude-code'),
        args: [literal('--dangerously-skip-permissions=true')],
        environment: [
          { kind: 'literal', name: 'CLAUDE_CONFIG_DIR', value: '/tmp/claude-risk' },
        ],
      }),
    })
    expect(claude.risk).toBe('elevated')

    const codex = await store.save({
      input: input({
        args: [literal('-c'), literal('sandbox_mode="danger-full-access"')],
      }),
    })
    expect(codex.risk).toBe('elevated')

    const geminiAutoEdit = await store.save({
      input: input({
        providerId: asHarnessProviderId('gemini-cli'),
        args: [literal('--approval-mode'), literal('auto_edit')],
      }),
    })
    expect(geminiAutoEdit.risk).toBe('elevated')

    const geminiUnknownApproval = await store.save({
      input: input({
        providerId: asHarnessProviderId('gemini-cli'),
        args: [literal('--approval-mode=preview')],
      }),
    })
    expect(geminiUnknownApproval.risk).toBe('unclassified')

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

function input(overrides: Partial<HarnessProfileInput> = {}): HarnessProfileInput {
  return {
    displayName: 'Codex workspace',
    providerId: asHarnessProviderId('codex'),
    scope: { kind: 'global' },
    executable: { kind: 'provider-default' },
    args: [],
    environment: [],
    pathBindings: [],
    order: 4,
    ...overrides,
  }
}

function literal(value: string) {
  return { parts: [{ kind: 'literal' as const, value }] }
}
