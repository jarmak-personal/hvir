import { EventEmitter } from 'node:events'

import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'

import { SshFileAccess } from '../src/main/project-host/ssh-file-access'
import { asHostId } from '../src/shared'

describe('SshFileAccess', () => {
  it('invalidates cached descendants and parent listings', () => {
    const files = fileAccess()
    const cache = new Map<string, unknown>([
      ['d:/project', []],
      ['d:/project/new-dir', []],
      ['f:/project/new-dir/file.txt', Buffer.from('old')],
      ['d:/unrelated', []],
    ])
    ;(files as unknown as { cache: Map<string, unknown> }).cache = cache

    files.invalidate('/project/new-dir/file.txt')

    expect([...cache.keys()]).toEqual(['d:/unrelated'])
  })

  it('invalidates every cached descendant when the watched root is slash', () => {
    const files = fileAccess()
    const cache = new Map<string, unknown>([
      ['d:/', []],
      ['d:/home', []],
      ['f:/home/picard/file.txt', Buffer.from('old')],
    ])
    ;(files as unknown as { cache: Map<string, unknown> }).cache = cache

    files.invalidate('/')

    expect(cache.size).toBe(0)
  })

  it('rejects and closes an SFTP session from a stale connection generation', async () => {
    let resolveSession!: (session: SFTPWrapper) => void
    const opening = new Promise<SFTPWrapper>((resolve) => {
      resolveSession = resolve
    })
    const files = fileAccess(() => opening)
    const session = Object.assign(new EventEmitter(), { end: vi.fn() })

    const pending = files.getSftp()
    files.advanceGeneration()
    resolveSession(session as unknown as SFTPWrapper)

    await expect(pending).rejects.toThrow('stale connection generation')
    expect(session.end).toHaveBeenCalledOnce()
    files.dispose()
    expect(session.end).toHaveBeenCalledOnce()
  })
})

function fileAccess(
  openSftp: () => Promise<SFTPWrapper> = () =>
    Promise.reject(new Error('SFTP is not configured for this test')),
): SshFileAccess {
  return new SshFileAccess({ hostId: asHostId('example'), openSftp }, {})
}
