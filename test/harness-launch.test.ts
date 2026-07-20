import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { commandPreview, resolveHarnessLaunch } from '../src/main/harness/harness-launch'
import { HarnessProfileStore } from '../src/main/harness/harness-profile-store'
import { LocalHost } from '../src/main/project-host/local-host'
import { asHarnessProviderId, localPath, type HarnessProfileInput } from '../src/shared'

describe('harness launch composition', () => {
  let directory: string
  let project: string
  let workspace: string
  let outside: string
  let host: LocalHost
  let store: HarnessProfileStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-launch-'))
    project = join(directory, 'project')
    workspace = join(directory, 'project-worktree')
    outside = join(directory, 'outside path')
    await mkdir(project)
    await mkdir(workspace)
    await mkdir(outside)
    host = new LocalHost()
    await host.connect()
    store = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
  })

  afterEach(async () => {
    delete process.env['HVIR_PROFILE_TEST_SECRET']
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('composes Claude bypass flags after provider-owned exact session identity', async () => {
    const profile = await store.save({
      input: input({
        providerId: asHarnessProviderId('claude-code'),
        args: [literal('--dangerously-skip-permissions')],
      }),
    })
    expect(profile.risk).toBe('elevated')
    const resolved = await resolve(profile, 'fresh')
    expect(resolved.spec).toEqual({
      file: 'claude',
      args: ['--session-id', 'test-session-id', '--dangerously-skip-permissions'],
      env: {},
      shellEnvironment: true,
    })
  })

  it('places Codex profile flags before the resume subcommand and resolves grants', async () => {
    const canonical = await host.realpath(localPath(outside))
    const grant = await store.authorizePath(canonical)
    const profile = await store.save({
      input: input({
        args: [
          literal('--add-dir'),
          { parts: [{ kind: 'path', source: 'binding', binding: 'monorepo' }] },
        ],
        pathBindings: [{ name: 'monorepo', path: canonical, grantId: grant.id }],
      }),
    })
    const resolved = await resolve(profile, 'resume')
    expect(resolved.spec.args).toEqual([
      '--config',
      'tui.terminal_title=["thread-title"]',
      '--add-dir',
      canonical.path,
      'resume',
      'test-session-id',
    ])
  })

  it('applies intentional submit through the Codex provider on fresh and resume', async () => {
    const profile = await store.save({ input: input() })
    const fresh = await resolve(profile, 'fresh', localPath(project), 'ctrl-enter')
    const resumed = await resolve(profile, 'resume', localPath(project), 'ctrl-enter')
    expect(fresh.spec.args).toEqual([
      '--config',
      'tui.terminal_title=["thread-title"]',
      '--config',
      'tui.keymap.composer.submit=["ctrl-enter"]',
    ])
    expect(resumed.spec.args).toEqual([...fresh.spec.args, 'resume', 'test-session-id'])
  })

  it('shares preview/spawn composition and redacts only reference values', async () => {
    process.env['HVIR_PROFILE_TEST_SECRET'] = 'forwarded-secret'
    const profile = await store.save({
      input: input({
        environment: [
          { kind: 'literal', name: 'VISIBLE_VALUE', value: 'plain text' },
          {
            kind: 'reference',
            name: 'SECRET_VALUE',
            source: 'local-forward',
            sourceName: 'HVIR_PROFILE_TEST_SECRET',
          },
          { kind: 'unset', name: 'NODE_OPTIONS' },
        ],
      }),
    })
    const resolved = await resolve(profile, 'fresh')
    const preview = commandPreview(resolved, 'fresh')
    expect(resolved.spec.env).toEqual({
      VISIBLE_VALUE: 'plain text',
      SECRET_VALUE: 'forwarded-secret',
    })
    expect(resolved.unsetEnvironment).toEqual(['NODE_OPTIONS'])
    expect(preview.environment).toEqual([
      {
        name: 'VISIBLE_VALUE',
        operation: 'set',
        displayValue: 'plain text',
        redacted: false,
      },
      {
        name: 'SECRET_VALUE',
        operation: 'reference',
        displayValue: '<local environment>',
        redacted: true,
      },
      { name: 'NODE_OPTIONS', operation: 'unset', redacted: false },
    ])
    expect(preview.command).toContain("VISIBLE_VALUE='plain text'")
    expect(preview.command).not.toContain('forwarded-secret')
  })

  it('rejects protected terminal variables and ungranted outside paths', async () => {
    const protectedProfile = await store.save({
      input: input({
        environment: [{ kind: 'unset', name: 'TERM' }],
      }),
    })
    await expect(resolve(protectedProfile, 'fresh')).rejects.toThrow(/owned by hvir/)

    const outsideProfile = await store.save({
      input: input({
        args: [
          literal('--add-dir'),
          { parts: [{ kind: 'path', source: 'binding', binding: 'outside' }] },
        ],
        pathBindings: [{ name: 'outside', path: localPath(outside) }],
      }),
    })
    await expect(resolve(outsideProfile, 'fresh')).rejects.toThrow(/launch grant/)
  })

  it('treats the active host-qualified worktree as part of the project authority', async () => {
    const profile = await store.save({
      input: input({
        args: [
          literal('--add-dir'),
          { parts: [{ kind: 'path', source: 'binding', binding: 'worktree' }] },
        ],
        pathBindings: [{ name: 'worktree', path: localPath(workspace) }],
      }),
    })
    const resolved = await resolve(profile, 'fresh', localPath(workspace))
    expect(resolved.spec.args).toContain((await host.realpath(localPath(workspace))).path)
  })

  it('keys artifact routing only to provider-declared launch inputs', async () => {
    const created = await store.save({ input: input() })
    const baseline = await resolve(created, 'fresh')
    const irrelevant = await store.save({
      id: created.id,
      expectedLaunchRevision: created.launchRevision,
      expectedMetadataRevision: created.metadataRevision,
      input: {
        ...created,
        environment: [{ kind: 'literal', name: 'UNRELATED', value: 'one' }],
      },
    })
    const irrelevantResolved = await resolve(irrelevant, 'fresh')
    expect(irrelevantResolved.artifactIdentity).toBe(baseline.artifactIdentity)

    const relevant = await store.save({
      id: irrelevant.id,
      expectedLaunchRevision: irrelevant.launchRevision,
      expectedMetadataRevision: irrelevant.metadataRevision,
      input: {
        ...irrelevant,
        environment: [
          ...irrelevant.environment,
          { kind: 'literal', name: 'CODEX_HOME', value: '/tmp/codex-profile' },
        ],
      },
    })
    const relevantResolved = await resolve(relevant, 'fresh')
    expect(relevantResolved.artifactIdentity).not.toBe(baseline.artifactIdentity)
    expect(relevantResolved.artifact.environment).toEqual({
      CODEX_HOME: '/tmp/codex-profile',
    })
  })

  it.each([
    '',
    'space separated',
    "single'quote",
    '--leading-dash',
    '日本語',
    '; | & < > * ? [ ] !',
  ])('preserves one structured argv value without shell expansion: %j', async (value) => {
    const profile = await store.save({
      input: input({ args: [literal(value)] }),
    })
    const resolved = await resolve(profile, 'fresh')
    const preview = commandPreview(resolved, 'fresh')
    expect(resolved.spec.args.at(-1)).toBe(value)
    expect(preview.args).toEqual(resolved.spec.args)
  })

  it('rejects an outside-path grant after its canonical target changes', async () => {
    const secondTarget = join(directory, 'second-outside')
    const link = join(directory, 'outside-link')
    await mkdir(secondTarget)
    await symlink(outside, link)
    const grant = await store.authorizePath(await host.realpath(localPath(outside)))
    const profile = await store.save({
      input: input({
        args: [
          literal('--add-dir'),
          { parts: [{ kind: 'path', source: 'binding', binding: 'outside' }] },
        ],
        pathBindings: [{ name: 'outside', path: localPath(link), grantId: grant.id }],
      }),
    })
    await expect(resolve(profile, 'fresh')).resolves.toBeDefined()

    await rm(link)
    await symlink(secondTarget, link)
    await expect(resolve(profile, 'fresh')).rejects.toThrow(/launch grant/)
  })

  async function resolve(
    profile: Awaited<ReturnType<HarnessProfileStore['save']>>,
    mode: 'fresh' | 'resume',
    launchWorkspace = localPath(project),
    composerSubmitMode?: 'enter' | 'ctrl-enter',
  ) {
    return resolveHarnessLaunch({
      profile,
      expectedLaunchRevision: profile.launchRevision,
      projectRoot: localPath(project),
      workspaceRoot: launchWorkspace,
      host,
      store,
      mode,
      context: {
        sessionId: 'test-session-id',
        cwd: launchWorkspace,
        defaultShell: '/bin/zsh',
        composerSubmitMode,
      },
    })
  }
})

function literal(value: string) {
  return { parts: [{ kind: 'literal' as const, value }] }
}

function input(overrides: Partial<HarnessProfileInput> = {}): HarnessProfileInput {
  return {
    displayName: 'Harness test',
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
