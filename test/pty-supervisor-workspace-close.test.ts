import { describe, expect, it, vi } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import type { ProjectHost, PtyExit, PtyProcess } from '../src/main/project-host'
import { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { LOCAL_HOST_ID, localPath } from '../src/shared'

class WorkspacePty implements PtyProcess {
  readonly pid = 4242
  readonly write = vi.fn<(data: string) => void>()
  readonly resize = vi.fn<(cols: number, rows: number) => void>()
  readonly kill = vi.fn<(signal?: string) => void>()

  onData(_callback: (data: string) => void): () => void {
    return () => undefined
  }

  onExit(_callback: (exit: PtyExit) => void): () => void {
    return () => undefined
  }
}

describe('PTY workspace close lifecycle', () => {
  it('counts and disposes only PTYs owned by one host-qualified workspace', async () => {
    const first = new WorkspacePty()
    const second = new WorkspacePty()
    const spawnPty = vi
      .fn<() => Promise<PtyProcess>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const host = {
      hostId: LOCAL_HOST_ID,
      defaultShell: () => Promise.resolve('/bin/zsh'),
      spawnPty,
    } as unknown as ProjectHost
    const supervisor = new PtySupervisor()
    const firstRoot = localPath('/tmp/project-first')
    const secondRoot = localPath('/tmp/project-second')
    await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: firstRoot,
      workspaceRoot: firstRoot,
      ownerId: 17,
      sessionId: 'first-workspace-terminal',
    })
    await supervisor.spawn({
      host,
      provider: plainShellProvider,
      cwd: secondRoot,
      workspaceRoot: secondRoot,
      ownerId: 17,
      sessionId: 'second-workspace-terminal',
    })

    expect(supervisor.workspaceSessionIds(firstRoot)).toEqual([
      'first-workspace-terminal',
    ])
    supervisor.disposeWorkspace(firstRoot)

    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).not.toHaveBeenCalled()
    expect(supervisor.get('first-workspace-terminal')).toBeUndefined()
    expect(supervisor.get('second-workspace-terminal')).toBeDefined()
  })
})
