import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeResumeAvailability } from '../src/main/harness/claude-session-recovery'
import {
  claudeCodeProvider,
  selectHarnessLaunch,
  type HarnessResumeValidationContext,
} from '../src/main/harness/harness-provider'
import { LocalHost } from '../src/main/project-host/local-host'

const SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('Claude Code session recovery', () => {
  let directory: string
  let host: LocalHost
  let context: HarnessResumeValidationContext

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-claude-resume-'))
    host = new LocalHost()
    await host.connect()
    context = {
      sessionId: SESSION_ID,
      artifact: {
        identity: 'claude-resume-test',
        environment: { CLAUDE_CONFIG_DIR: directory },
        unsetEnvironment: [],
      },
    }
  })

  afterEach(async () => {
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('distinguishes a zero-turn ID from one exact persisted transcript', async () => {
    await mkdir(join(directory, 'projects'), { recursive: true })
    expect(await claudeResumeAvailability(host, context)).toBe('missing')

    const project = join(directory, 'projects', '-test-project')
    const transcript = join(project, `${SESSION_ID}.jsonl`)
    await mkdir(project, { recursive: true })
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

  it('fails closed when the exact UUID is ambiguous across artifact directories', async () => {
    for (const project of ['-first-project', '-second-project']) {
      const path = join(directory, 'projects', project)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, `${SESSION_ID}.jsonl`), '{}\n')
    }

    expect(await claudeResumeAvailability(host, context)).toBe('unknown')
    await expect(
      selectHarnessLaunch(host, claudeCodeProvider, 'resume', context),
    ).rejects.toThrow(/could not be verified/)
  })
})
