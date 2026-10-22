import { EventEmitter } from 'node:events'
import type { Client, SFTPWrapper } from 'ssh2'
import { expect, it, vi } from 'vitest'
import { setupFixture } from './fixtures/extension-setup'
import { createTestSshHost } from './ssh-host-test-fixture'

/** Real SshHost metadata and lifetime implementation over an explicitly fake SSH2 boundary. */
it('prepares configured SSH programs and workspace roots through SFTP without exec and retires on the actual transport lifetime', async () => {
  const f = await setupFixture(true)
  const sftp = Object.assign(new EventEmitter(), {
    realpath: vi.fn((path: string, done: (error: undefined, value: string) => void) =>
      done(undefined, path === '/installed/tool' ? '/versions/tool' : path),
    ),
    lstat: vi.fn((path: string, done: (error: undefined, value: object) => void) =>
      done(undefined, {
        mode: path === '/library' ? 0o040755 : 0o100755,
        size: 0,
        mtime: 0,
      }),
    ),
    end: vi.fn(() => sftp.emit('close')),
  })
  const client = Object.assign(new EventEmitter(), {
    end: vi.fn(() => client.emit('close')),
    destroy: vi.fn(() => client.emit('close')),
    sftp: vi.fn((done: (error: undefined, value: SFTPWrapper) => void) =>
      done(undefined, sftp as unknown as SFTPWrapper),
    ),
    exec: vi.fn(),
  })
  const host = createTestSshHost({
    config: {
      alias: 'remote',
      hostname: 'example.test',
      user: 'test',
      port: 22,
      identityFiles: [],
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  const internals = host as unknown as { state: 'connected'; client: Client }
  internals.state = 'connected'
  internals.client = client as unknown as Client
  for (const port of [f.program.host, f.source.host]) {
    port.realpath.mockImplementation((path) => host.realpath(path))
    port.stat.mockImplementation((path) => host.stat(path))
  }
  Object.defineProperty(f.program.hosts.hostById('remote')!, 'streamLocal', {
    get: () => host.streamLocal,
  })
  try {
    const review = await f.import()
    expect(
      review?.rows.map((row) => [row.state, row.location?.hostId, row.location?.path]),
    ).toEqual([
      ['ready', 'remote', '/versions/tool'],
      ['ready', 'remote', '/versions/tool'],
      ['ready', 'remote', '/library'],
    ])
    expect(sftp.realpath).toHaveBeenCalled()
    expect(client.exec).not.toHaveBeenCalled()
    await host.dispose()
    f.owner.revalidate()
    await expect(f.apply()).rejects.toThrow(/ended/)
    expect(f.program.write).not.toHaveBeenCalled()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  } finally {
    await host.dispose()
    await f.dispose()
  }
})
