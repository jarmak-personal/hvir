import { describe, expect, it, vi } from 'vitest'
import { authorizeAgentDocument } from '../src/main/viewer/document-read-authority'
import { hostPath, asHostId, type HostPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
describe('agent document presentation confinement', () => {
  it.each(['local', 'ssh'])(
    'uses exact %s host roots and rejects canonical escapes without retrieving file contents',
    async (id) => {
      const qualify = (path: string) => hostPath(asHostId(id), path),
        root = qualify('/repo')
      const readFile = vi.fn(),
        stat = vi.fn(() => Promise.resolve({ type: 'file', size: 8 }))
      const host = {
        realpath: vi.fn((path: HostPath) =>
          Promise.resolve(
            path.path.endsWith('/escape') ? qualify('/private/secret') : path,
          ),
        ),
        stat,
        readFile,
      } as unknown as ProjectHost
      await expect(
        authorizeAgentDocument(host, root, qualify('/repo/README.md'), () => undefined),
      ).resolves.toEqual(qualify('/repo/README.md'))
      await expect(
        authorizeAgentDocument(host, root, qualify('/repo/escape'), () => undefined),
      ).rejects.toThrow('symlink')
      await expect(
        authorizeAgentDocument(host, root, qualify('/outside'), () => undefined),
      ).rejects.toThrow('escapes')
      expect(readFile).not.toHaveBeenCalled()
    },
  )
  it('checks revocation immediately after every host await', async () => {
    const root = hostPath(asHostId('ssh'), '/repo'),
      stat = vi.fn()
    let live = true
    const host = {
      realpath: (path: HostPath) => {
        live = false
        return Promise.resolve(path)
      },
      stat,
    } as unknown as ProjectHost
    await expect(
      authorizeAgentDocument(host, root, hostPath(root.hostId, '/repo/file'), () => {
        if (!live) throw new Error('Disconnected exact host')
      }),
    ).rejects.toThrow('Disconnected')
    expect(stat).not.toHaveBeenCalled()
  })
})
