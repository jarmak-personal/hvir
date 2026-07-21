import { describe, expect, it, vi } from 'vitest'

import {
  claudeProjectDirectoryName,
  resolveClaudeSessionArtifact,
  type ClaudeSessionArtifactContext,
} from '../src/main/harness/claude-session-artifact'
import type { ProjectHost } from '../src/main/project-host'
import { LOCAL_HOST_ID, asHostId, hostPath } from '../src/shared'

const SESSION_ID = '05ea41ff-026f-4ab6-b930-64eb3b497806'

describe('Claude Code session artifact location', () => {
  it('matches Claude 2.1.216 punctuation, underscore, and non-ASCII replacement', () => {
    expect(claudeProjectDirectoryName('/tmp/ümlaut_project/a b')).toBe(
      '-tmp--mlaut-project-a-b',
    )
  })

  it('keeps 200 characters and hashes known negative, positive, and UTF-16 inputs', () => {
    const prefix = `-${'a'.repeat(199)}`
    expect(claudeProjectDirectoryName(`/${'a'.repeat(199)}`)).toBe(prefix)
    // The next original path hashes to -676821585 before Claude applies Math.abs.
    expect(claudeProjectDirectoryName(`/${'a'.repeat(200)}`)).toBe(`${prefix}-b6ymvl`)
    expect(claudeProjectDirectoryName(`/${'a'.repeat(201)}`)).toBe(`${prefix}-85qkr6`)
    expect(claudeProjectDirectoryName(`/${'a'.repeat(199)}😀`)).toBe(`${prefix}-86sic5`)
  })

  it.each([
    ['local', LOCAL_HOST_ID],
    ['SSH', asHostId('ssh-claude-artifact')],
  ])(
    'qualifies the exact path and command composition for a %s host',
    async (_kind, hostId) => {
      const signal = new AbortController().signal
      const exec = vi.fn<ProjectHost['exec']>().mockResolvedValue({
        code: 0,
        signal: null,
        stdout: '/physical/work_space\n\0/config/claude-profile',
        stderr: '',
      })
      const host = { hostId, exec } as unknown as ProjectHost
      const context = artifactContext(hostId)

      await expect(resolveClaudeSessionArtifact(host, context, signal)).resolves.toEqual({
        projectsRoot: hostPath(hostId, '/config/claude-profile/projects'),
        projectDirectory: hostPath(
          hostId,
          '/config/claude-profile/projects/-physical-work-space',
        ),
        transcript: hostPath(
          hostId,
          `/config/claude-profile/projects/-physical-work-space/${SESSION_ID}.jsonl`,
        ),
      })
      expect(exec).toHaveBeenCalledWith('sh', expect.any(Array), {
        cwd: context.cwd,
        env: { CLAUDE_CONFIG_DIR: '/config/claude-profile' },
        unsetEnv: ['CLAUDE_CONFIG_DIR_OLD'],
        signal,
        maxBuffer: 32 * 1024,
      })
    },
  )

  it('rejects invalid identity, foreign hosts, relative roots, and command failures', async () => {
    const signal = new AbortController().signal
    const exec = vi.fn<ProjectHost['exec']>()
    const host = { hostId: LOCAL_HOST_ID, exec } as unknown as ProjectHost

    await expect(
      resolveClaudeSessionArtifact(
        host,
        { ...artifactContext(LOCAL_HOST_ID), sessionId: 'not-a-uuid' },
        signal,
      ),
    ).resolves.toBeUndefined()
    await expect(
      resolveClaudeSessionArtifact(
        host,
        artifactContext(asHostId('foreign-host')),
        signal,
      ),
    ).resolves.toBeUndefined()
    await expect(
      resolveClaudeSessionArtifact(
        host,
        { ...artifactContext(LOCAL_HOST_ID), cwd: hostPath(LOCAL_HOST_ID, 'relative') },
        signal,
      ),
    ).resolves.toBeUndefined()
    expect(exec).not.toHaveBeenCalled()

    exec.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: '/physical/repo\n\0relative/config',
      stderr: '',
    })
    await expect(
      resolveClaudeSessionArtifact(host, artifactContext(LOCAL_HOST_ID), signal),
    ).resolves.toBeUndefined()

    exec.mockRejectedValueOnce(new Error('transport failed'))
    await expect(
      resolveClaudeSessionArtifact(host, artifactContext(LOCAL_HOST_ID), signal),
    ).resolves.toBeUndefined()
  })
})

function artifactContext(
  hostId: ReturnType<typeof asHostId>,
): ClaudeSessionArtifactContext {
  return {
    cwd: hostPath(hostId, '/workspace/link'),
    sessionId: SESSION_ID,
    artifact: {
      identity: 'claude-artifact-test',
      environment: { CLAUDE_CONFIG_DIR: '/config/claude-profile' },
      unsetEnvironment: ['CLAUDE_CONFIG_DIR_OLD'],
    },
  }
}
