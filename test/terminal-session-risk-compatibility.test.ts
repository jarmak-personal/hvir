import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import { localPath } from '../src/shared'

describe('terminal session risk compatibility', () => {
  let directory: string
  let host: LocalHost
  let file: ReturnType<typeof localPath>
  let registry: TerminalSessionRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-terminal-risk-compatibility-'))
    host = new LocalHost()
    await host.connect()
    file = localPath(join(directory, 'terminal-sessions.json'))
  })

  afterEach(async () => {
    await registry?.flush().catch(() => undefined)
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('ignores obsolete v6 acknowledgment while retaining exact recovery state', async () => {
    const root = localPath('/tmp/project')
    await host.writeFile(
      file,
      JSON.stringify({
        version: 6,
        sessions: [
          {
            id: 'terminal-1',
            providerId: 'claude-code',
            profileId: 'claude-code-default',
            launchRevision: 2,
            recoverySkipCount: 0,
            riskAcknowledgedRevision: 2,
            artifactIdentity: '1234567890abcdef12345678',
            harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
            hostId: root.hostId,
            workspaceRoot: root,
            cwd: root,
            title: 'Retained Claude',
            position: 0,
            active: true,
            attention: 'bell',
            updatedAt: 42,
          },
        ],
      }),
    )

    registry = await TerminalSessionRegistry.load(host, file)
    const record = registry.list(root)[0]!
    expect(record).toMatchObject({
      id: 'terminal-1',
      providerId: 'claude-code',
      profileId: 'claude-code-default',
      launchRevision: 2,
      recoverySkipCount: 0,
      artifactIdentity: '1234567890abcdef12345678',
      harnessSessionId: '019ab123-4567-7890-abcd-ef0123456789',
      hostId: root.hostId,
      cwd: root,
      title: 'Retained Claude',
      position: 0,
      active: true,
      attention: 'bell',
      updatedAt: 42,
    })
    expect(record).not.toHaveProperty('riskAcknowledgedRevision')

    await registry.updateLayout(root, [
      {
        id: record.id,
        title: record.title,
        position: record.position,
        active: record.active,
        attention: record.attention,
      },
    ])
    const written = JSON.parse(await host.readTextFile(file)) as {
      sessions: readonly Record<string, unknown>[]
    }
    expect(written.sessions[0]).not.toHaveProperty('riskAcknowledgedRevision')
  })
})
