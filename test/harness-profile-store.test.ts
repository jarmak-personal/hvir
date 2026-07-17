import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HarnessProfileStore } from '../src/main/harness/harness-profile-store'
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

  it('ships immutable deterministic defaults and excludes Custom until configured', () => {
    expect(store.list().map(({ id }) => id)).toEqual([
      'plain-shell-default',
      'claude-code-default',
      'codex-default',
      'pi-default',
      'gemini-cli-default',
      'github-copilot-cli-default',
      'cursor-cli-default',
    ])
    expect(() =>
      store.save({
        id: asHarnessProfileId('codex-default'),
        input: input({ displayName: 'Changed' }),
      }),
    ).toThrow(/immutable/)
  })

  it('keeps cosmetic metadata separate from launch revision', async () => {
    const created = await store.save({ input: input() })
    const renamed = await store.save({
      id: created.id,
      expectedMetadataRevision: created.metadataRevision,
      input: { ...created, displayName: 'Renamed', order: 5 },
    })
    expect(renamed.launchRevision).toBe(created.launchRevision)
    expect(renamed.metadataRevision).toBe(created.metadataRevision + 1)

    const launchChanged = await store.save({
      id: renamed.id,
      expectedMetadataRevision: renamed.metadataRevision,
      input: {
        ...renamed,
        args: [{ parts: [{ kind: 'literal', value: '--add-dir' }] }],
      },
    })
    expect(launchChanged.launchRevision).toBe(created.launchRevision + 1)
    expect(launchChanged.metadataRevision).toBe(renamed.metadataRevision)
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
      }),
    })
    expect(claude.risk).toBe('elevated')

    const codex = await store.save({
      input: input({
        args: [literal('-c'), literal('sandbox_mode="danger-full-access"')],
      }),
    })
    expect(codex.risk).toBe('elevated')

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
