import { expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { SshProjectFileTransfer } from '../src/main/project-host/ssh-project-file-transfer'
import { asHostId, hostPath } from '../src/shared/host-path'
function fixture(closeFailure = false) {
  const open = vi.fn(
      (
        _path: string,
        _flags: string,
        _attributes: { mode: number },
        done: (error: Error | undefined, handle?: Buffer) => void,
      ) => done(undefined, Buffer.from('handle')),
    ),
    write = vi.fn(
      (_handle, _buffer, _offset, _length, _position, done: (error?: Error) => void) =>
        done(),
    ),
    close = vi.fn((_handle, done: (error?: Error) => void) =>
      done(closeFailure ? new Error('close uncertain') : undefined),
    ),
    unlink = vi.fn((_path, done: (error?: Error) => void) => done()),
    fsetstat = vi.fn((_handle, _attributes, done: (error?: Error) => void) => done())
  const session = { open, write, close, unlink, fsetstat } as unknown as SFTPWrapper
  const transfer = new SshProjectFileTransfer({
    hostId: asHostId('ssh'),
    getSftp: () => Promise.resolve(session),
    stat: () => Promise.reject(new Error('missing')),
    invalidate: () => undefined,
  })
  return { transfer, open, write, close, unlink, fsetstat }
}
it('sends an explicit private SFTP marker mode, independent of shell umask', async () => {
  const f = fixture()
  await f.transfer.writeFileChunksExclusive(
    hostPath(asHostId('ssh'), '/private/owned.json'),
    (async function* () {
      yield await Promise.resolve(Buffer.from('{}'))
    })(),
    { mode: 0o600, preserveOnFailure: true },
  )
  expect(f.open).toHaveBeenCalledWith(
    '/private/owned.json',
    'wx',
    { mode: 0o600 },
    expect.any(Function),
  )
  expect(f.fsetstat).toHaveBeenCalledWith(
    Buffer.from('handle'),
    { mode: 0o600 },
    expect.any(Function),
  )
})
it('preserves uncertain created paths on pre-first-yield cancellation and failed physical handle close', async () => {
  for (const failedClose of [false, true]) {
    const f = fixture(failedClose),
      controller = new AbortController()
    if (failedClose)
      await expect(
        f.transfer.writeFileChunksExclusive(
          hostPath(asHostId('ssh'), '/private/upload'),
          (async function* () {
            yield await Promise.resolve(Buffer.from('partial'))
          })(),
          { mode: 0o644, preserveOnFailure: true },
        ),
      ).rejects.toThrow('close uncertain')
    else
      await expect(
        f.transfer.writeFileChunksExclusive(
          hostPath(asHostId('ssh'), '/private/upload'),
          (async function* () {
            yield await Promise.resolve(Buffer.from('partial'))
          })(),
          {
            mode: 0o644,
            signal: controller.signal,
            preserveOnFailure: true,
            onCreated: () => controller.abort(),
          },
        ),
      ).rejects.toThrow()
    expect(f.unlink).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalled()
    if (!failedClose) expect(f.write).not.toHaveBeenCalled()
  }
})
