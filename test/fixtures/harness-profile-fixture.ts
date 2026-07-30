import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { onTestFinished } from 'vitest'

import {
  resolveHarnessLaunch,
  type ResolvedHarnessLaunch,
} from '../../src/main/harness/harness-launch'
import { HarnessProfileStore } from '../../src/main/harness/harness-profile-store'
import { LocalHost } from '../../src/main/project-host/local-host'
import {
  asHarnessProviderId,
  localPath,
  type HarnessProfile,
  type HarnessProfileArgument,
  type HarnessProfileInput,
  type HostPath,
} from '../../src/shared'

export interface HarnessProfileFixture {
  readonly directory: string
  readonly projectDirectory: string
  readonly workspaceDirectory: string
  readonly outsideDirectory: string
  readonly projectRoot: HostPath
  readonly workspaceRoot: HostPath
  readonly outsideRoot: HostPath
  readonly host: LocalHost
  readonly store: HarnessProfileStore
  readonly input: (overrides?: Partial<HarnessProfileInput>) => HarnessProfileInput
  readonly literal: (value: string) => HarnessProfileArgument
  readonly resolve: (
    profile: HarnessProfile,
    mode: 'fresh' | 'resume',
    workspaceRoot?: HostPath,
    composerSubmitMode?: 'enter' | 'ctrl-enter',
  ) => Promise<ResolvedHarnessLaunch>
  readonly dispose: () => Promise<void>
}

/**
 * Isolated profile persistence and launch composition owned by the harness domain.
 * The fixture never reads or writes the developer's configured profile store.
 */
export async function createHarnessProfileFixture(): Promise<HarnessProfileFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-harness-profile-'))
  const projectDirectory = join(directory, 'project')
  const workspaceDirectory = join(directory, 'project-worktree')
  const outsideDirectory = join(directory, 'outside path')
  const host = new LocalHost()
  let disposed = false

  try {
    await Promise.all([
      mkdir(projectDirectory),
      mkdir(workspaceDirectory),
      mkdir(outsideDirectory),
    ])
    await host.connect()
    const store = await HarnessProfileStore.load(
      host,
      localPath(join(directory, 'profiles.json')),
    )
    const projectRoot = localPath(projectDirectory)
    const workspaceRoot = localPath(workspaceDirectory)
    const outsideRoot = localPath(outsideDirectory)
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await store.flush().catch(() => undefined)
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    }
    const fixture: HarnessProfileFixture = {
      directory,
      projectDirectory,
      workspaceDirectory,
      outsideDirectory,
      projectRoot,
      workspaceRoot,
      outsideRoot,
      host,
      store,
      input: harnessProfileInput,
      literal: harnessLiteralArgument,
      resolve: (profile, mode, launchWorkspace = projectRoot, composerSubmitMode) =>
        resolveHarnessLaunch({
          profile,
          expectedLaunchRevision: profile.launchRevision,
          projectRoot,
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
        }),
      dispose,
    }
    onTestFinished(dispose)
    return fixture
  } catch (error) {
    await host.dispose().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export function harnessLiteralArgument(value: string): HarnessProfileArgument {
  return { parts: [{ kind: 'literal', value }] }
}

export function harnessProfileInput(
  overrides: Partial<HarnessProfileInput> = {},
): HarnessProfileInput {
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
