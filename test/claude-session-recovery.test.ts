import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { claudeProjectDirectoryName } from '../src/main/harness/claude-session-artifact'
import { claudeResumeAvailability } from '../src/main/harness/claude-session-recovery'
import {
  claudeCodeProvider,
  selectHarnessLaunch,
  type HarnessResumeValidationContext,
} from '../src/main/harness/harness-provider'
import type { ProjectHost } from '../src/main/project-host'
import { LocalHost } from '../src/main/project-host/local-host'
import { LOCAL_HOST_ID, hostPath, localPath } from '../src/shared'

const SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('Claude Code session recovery', () => {
  let directory: string
  let configDirectory: string
  let cwd: string
  let canonicalCwd: string
  let host: LocalHost
  let context: HarnessResumeValidationContext

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-claude-resume-'))
    configDirectory = join(directory, 'config')
    cwd = join(directory, 'workspace')
    await mkdir(configDirectory)
    await mkdir(cwd)
    canonicalCwd = await realpath(cwd)
    host = new LocalHost()
    await host.connect()
    context = {
      sessionId: SESSION_ID,
      cwd: localPath(cwd),
      artifact: {
        identity: 'claude-resume-test',
        environment: { CLAUDE_CONFIG_DIR: configDirectory },
        unsetEnvironment: [],
      },
    }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('distinguishes a zero-turn ID from the exact persisted transcript', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, 'inherited-config'))
    const transcript = transcriptPath(configDirectory, canonicalCwd)
    await mkdir(join(configDirectory, 'projects'), { recursive: true })
    expect(await claudeResumeAvailability(host, context)).toBe('missing')

    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, '')
    expect(await claudeResumeAvailability(host, context)).toBe('missing')
    expect(
      await selectHarnessLaunch(host, claudeCodeProvider, 'resume', context),
    ).toEqual({ outcome: 'resume-unavailable', reason: 'artifact-missing' })

    await writeFile(transcript, '{}\n')

    expect(await claudeResumeAvailability(host, context)).toBe('available')
    expect(
      await selectHarnessLaunch(host, claudeCodeProvider, 'resume', context),
    ).toEqual({ outcome: 'launch', mode: 'resume' })
  })

  it('does not validate or relabel an intentional fresh launch', async () => {
    await expect(
      selectHarnessLaunch(host, claudeCodeProvider, 'fresh', context),
    ).resolves.toEqual({ outcome: 'launch', mode: 'fresh' })
  })

  it('fails closed while the profile-qualified artifact root is absent', async () => {
    expect(await claudeResumeAvailability(host, context)).toBe('unknown')
    await expect(
      selectHarnessLaunch(host, claudeCodeProvider, 'resume', context),
    ).rejects.toThrow(/could not be verified/)
  })

  it('ignores the same UUID under an unrelated project directory', async () => {
    const unrelated = join(configDirectory, 'projects', '-unrelated-project')
    await mkdir(unrelated, { recursive: true })
    await writeFile(join(unrelated, `${SESSION_ID}.jsonl`), '{}\n')

    expect(await claudeResumeAvailability(host, context)).toBe('missing')

    const matching = transcriptPath(configDirectory, canonicalCwd)
    await mkdir(dirname(matching), { recursive: true })
    await writeFile(matching, '{}\n')
    expect(await claudeResumeAvailability(host, context)).toBe('available')
  })

  it('derives the project directory from the physical cwd', async () => {
    const linkedCwd = join(directory, 'workspace-link')
    await symlink(cwd, linkedCwd)
    context = { ...context, cwd: localPath(linkedCwd) }
    const transcript = transcriptPath(configDirectory, canonicalCwd)
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, '{}\n')

    expect(await claudeResumeAvailability(host, context)).toBe('available')
  })

  it('uses the default config root when the profile unsets an inherited override', async () => {
    const home = join(directory, 'home')
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(directory, 'inherited-config'))
    context = {
      ...context,
      artifact: {
        identity: 'claude-default-config-test',
        environment: {},
        unsetEnvironment: ['CLAUDE_CONFIG_DIR'],
      },
    }
    const defaultConfig = join(home, '.claude')
    const transcript = transcriptPath(defaultConfig, canonicalCwd)
    await mkdir(dirname(transcript), { recursive: true })
    await writeFile(transcript, '{}\n')

    expect(await claudeResumeAvailability(host, context)).toBe('available')
  })

  it('fails closed when the projects root is inaccessible', async () => {
    const projects = join(configDirectory, 'projects')
    await mkdir(projects)
    await chmod(projects, 0)
    try {
      expect(await claudeResumeAvailability(host, context)).toBe('unknown')
    } finally {
      await chmod(projects, 0o700)
    }
  })

  it('uses one deadline across resolution and the exact check and fails closed on abort', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    const exec = vi
      .fn<ProjectHost['exec']>()
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: '/repo\n\0/config/claude',
        stderr: '',
      })
      .mockImplementationOnce(() => {
        controller.abort()
        return Promise.reject(new Error('aborted'))
      })
    const fakeHost = {
      hostId: LOCAL_HOST_ID,
      exec,
    } as unknown as ProjectHost
    const fakeContext: HarnessResumeValidationContext = {
      ...context,
      cwd: hostPath(LOCAL_HOST_ID, '/repo'),
    }

    await expect(claudeResumeAvailability(fakeHost, fakeContext)).resolves.toBe('unknown')
    expect(timeout).toHaveBeenCalledOnce()
    expect(timeout).toHaveBeenCalledWith(3_000)
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[0]?.[2]?.signal).toBe(controller.signal)
    expect(exec.mock.calls[1]?.[2]?.signal).toBe(controller.signal)
  })
})

function transcriptPath(configDirectory: string, canonicalCwd: string): string {
  return join(
    configDirectory,
    'projects',
    claudeProjectDirectoryName(canonicalCwd),
    `${SESSION_ID}.jsonl`,
  )
}
