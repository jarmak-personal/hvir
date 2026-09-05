import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { IpcAuthority } from '../src/main/ipc/authority-router'
import { authorizeDocumentRead } from '../src/main/viewer/document-read-authority'
import { resolveTerminalFileTarget } from '../src/renderer/src/terminal/terminal-file-link'
import { TerminalPathActivationCoordinator } from '../src/renderer/src/workbench/use-terminal-path-activation'
import { renderMarkdownDocument } from '../src/renderer/src/viewer/markdown-renderer'
import { hostPath, localPath, type ProjectState } from '../src/shared'
import { createTestSshHost } from './ssh-host-test-fixture'

it('renders the SSH terminal document through SshHost and its SFTP boundary, never application-host /tmp', async () => {
  const remoteRead = vi.fn(
    (path: string, done: (error: Error | undefined, value: Buffer) => void) => {
      if (path !== '/tmp/plan.md') throw new Error('Unexpected remote read')
      done(undefined, Buffer.from('# Remote plan'))
    },
  )
  const session = Object.assign(new EventEmitter(), {
    realpath: (path: string, done: (error: undefined, path: string) => void) =>
      done(undefined, path),
    readFile: remoteRead,
    end: vi.fn(),
  })
  const client = Object.assign(new EventEmitter(), {
    connect: () => queueMicrotask(() => client.emit('ready')),
    end: () => client.emit('close'),
    destroy: () => client.emit('close'),
    exec: (_command: string, done: (error: undefined, channel: unknown) => void) => {
      const channel = Object.assign(new EventEmitter(), {
        stderr: new EventEmitter(),
        close: vi.fn(),
        end: () =>
          queueMicrotask(() => {
            channel.emit('exit', 0)
            channel.emit('close')
          }),
      })
      done(undefined, channel)
    },
    sftp: (done: (error: undefined, session: unknown) => void) =>
      done(undefined, session),
  })
  const host = createTestSshHost({
    config: {
      alias: 'document-fixture',
      hostname: 'fixture.invalid',
      user: 'fixture',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
    clientFactory: () => client as unknown as Client,
  })
  try {
    await host.connect()
    const root = hostPath(host.hostId, '/repo')
    const authority = new IpcAuthority({
      getProject: () => ({ host, root }),
      getRegisteredWorkspaceRoot: () => root,
      getProjectState: () => ({ projects: [] }) as unknown as ProjectState,
    })
    let rendered: Promise<string> | undefined
    const ports = {
      resolveEntry: vi.fn(),
      revealDirectory: vi.fn(),
      openFile(path: ReturnType<typeof hostPath>) {
        rendered = (async () => {
          const access = await authorizeDocumentRead(authority, {
            path,
            workspaceRoot: root,
          })
          const content = await access.host.readFile(access.path, {
            pollingInterest: false,
          })
          access.assertCurrent()
          return renderMarkdownDocument(content.toString(), 'dark', {
            load: () => Promise.resolve(undefined),
          })
        })()
      },
    }
    const activation = new TerminalPathActivationCoordinator(ports)
    activation.update(root, ports)
    await activation.activate(resolveTerminalFileTarget('/tmp/plan.md', root)!)
    expect(await rendered).toContain('Remote plan</h1>')
    expect(remoteRead).toHaveBeenCalledWith('/tmp/plan.md', expect.any(Function))
    await expect(host.readFile(localPath('/tmp/plan.md'))).rejects.toThrow(/expected/)
    expect(remoteRead).toHaveBeenCalledTimes(1)
  } finally {
    await host.dispose()
  }
})
