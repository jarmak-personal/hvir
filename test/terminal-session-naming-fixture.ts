import { vi } from 'vitest'
import { TerminalSessionRegistry } from '../src/main/terminal/session-registry'
import type { ProjectHost } from '../src/main/project-host'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  hostPath,
  localPath,
} from '../src/shared'

export async function terminalNamingFixture(remote = false) {
  let content: string | undefined
  const writeFile = vi.fn((_file: unknown, data: string) => {
    content = data
    return Promise.resolve()
  })
  const host = {
    readTextFile: () =>
      content === undefined
        ? Promise.reject(Object.assign(new Error('Missing registry'), { code: 'ENOENT' }))
        : Promise.resolve(content),
    writeFile,
  } as unknown as ProjectHost
  const file = localPath('/app/session-registry.json')
  const registry = await TerminalSessionRegistry.load(host, file)
  const root = hostPath(asHostId(remote ? 'ssh-offline' : 'local'), '/project')
  const spawn = {
    id: 'terminal-one',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    harnessSessionId: 'conversation-one',
    workspaceRoot: root,
    cwd: root,
    title: 'Automatic one',
    position: 0,
    active: false,
  }
  await registry.recordSpawn(spawn)
  return {
    registry,
    host,
    file,
    root,
    spawn,
    writeFile,
    reload: () => TerminalSessionRegistry.load(host, file),
  }
}
