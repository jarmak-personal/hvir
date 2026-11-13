import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { NativeTerminalExportMode } from '../src/shared/native-terminal-linux'
import { nativeTerminalHostFixture as fixture } from './fixtures/native-terminal-host'

const renderer = {
  available: true,
  glVendor: 'Mesa',
  glRenderer: 'test renderer',
  glVersion: '4.3',
  eglVendor: 'Mesa',
  eglVersion: '1.5',
  renderNode: '/dev/dri/renderD128',
  pixelFrames: 2,
  dmaBufFrames: 3,
}

describe('main native Linux presentation control', () => {
  it('enqueues a qualified mode request without inventing applied-frame acknowledgement', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    await f.host.presentationMode(handle, 1, 1, attachment, 'pixels')
    expect(f.request).toHaveBeenLastCalledWith(
      { kind: 'presentation-mode', state: '1', mode: 'pixels' },
      expect.any(AbortSignal),
    )
    const calls = f.request.mock.calls.length
    await expect(
      f.host.presentationMode(
        handle,
        1,
        1,
        attachment,
        'gpu' as NativeTerminalExportMode,
      ),
    ).rejects.toThrow('native-mode-invalid')
    expect(f.request).toHaveBeenCalledTimes(calls)
    f.host.detach(handle, 1, 1, attachment)
    await expect(
      f.host.presentationMode(handle, 1, 1, attachment, 'auto'),
    ).rejects.toThrow(/attachment/)
  })
  it('requalifies the attachment after the native request settles', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    let resolve!: (value: unknown) => void
    f.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const pending = f.host.presentationMode(handle, 1, 1, attachment, 'pixels')
    const rejected = expect(pending).rejects.toThrow(/attachment/)
    f.host.detach(handle, 1, 1, attachment)
    f.host.attach(handle, session)
    resolve({ result: 0 })
    await rejected
    expect(f.process.dispose).not.toHaveBeenCalled()
  })
  it('reports bounded actual renderer/frame facts without descriptors or lease authority', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const frame = (await f.host.takeFrame(handle, 1, 1, attachment))!
    Object.assign(frame.metadata.resource, { fourcc: 0 })
    f.request.mockResolvedValueOnce(renderer)
    const info = await f.host.rendererInfo(handle, session.instanceId)
    expect(info).toMatchObject({
      ...renderer,
      renderNode: localPath('/dev/dri/renderD128'),
      frameCopies: 0,
      lastFrame: { kind: 1, resource: { fourcc: 0x42475241, modifier: '0', planes: [] } },
    })
    expect(info.lastFrame).not.toHaveProperty('lease')
    expect(info.lastFrame).not.toHaveProperty('surface')
    await frame.release()
  })
  it.each([
    { ...renderer, pixelFrames: Number.MAX_SAFE_INTEGER + 1 },
    { ...renderer, glRenderer: 'x'.repeat(256) },
    { ...renderer, renderNode: '/private/other' },
  ])(
    'refuses malformed diagnostic data while retaining parser ownership',
    async (value) => {
      const f = fixture(),
        session = f.session()
      const handle = await f.host.prepare(session, 32, 32)
      f.request.mockResolvedValueOnce(value)
      await expect(f.host.rendererInfo(handle, session.instanceId)).rejects.toThrow(
        'native-renderer-info-invalid',
      )
      await f.host.feed(handle, session.instanceId, Uint8Array.of(65))
      await expect(f.host.readProducer(handle, session.instanceId)).resolves.toEqual(
        Uint8Array.of(1),
      )
      expect(f.process.dispose).not.toHaveBeenCalled()
    },
  )
})
