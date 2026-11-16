import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import { nativeTerminalApplicationFixture as fixture } from './fixtures/native-terminal-application'

vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
async function preparation(f: ReturnType<typeof fixture>) {
  const raw = {
    columns: 80,
    rows: 24,
    connect: vi.fn(),
    output: vi.fn(),
    exited: vi.fn(),
    failed: vi.fn(),
    dispose: vi.fn(),
  }
  f.sessions.prepare.mockResolvedValue(raw)
  const prepared = await f.app.preparation({ width: 32, height: 32, backingScale: 1 })(
    f.state.session,
    new AbortController().signal,
  )
  return { raw, prepared }
}

describe('native terminal destructive removal', () => {
  it('joins an ordinary detach already holding presentation cleanup before raw destruction', async () => {
    const f = fixture(),
      presentation = deferred<void>()
    await f.app.attach('session', f.owner, f.frame)
    f.presenter.detach.mockReturnValue(presentation.promise)
    const detaching = f.app.detach('view', f.owner)
    await vi.waitFor(() => expect(f.presenter.detach).toHaveBeenCalledOnce())
    const removing = f.app.remove('session', 'instance')
    try {
      // Other injected ports finish in microtasks; the named presentation gate
      // must remain the only thing preventing physical state destruction.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(f.sessions.remove).not.toHaveBeenCalled()
    } finally {
      presentation.resolve()
      await Promise.allSettled([detaching, removing])
    }
    expect(f.sessions.remove).toHaveBeenCalledOnce()
    expect(f.presenter.detach).toHaveBeenCalledOnce()
  })
  it('joins ordinary blur pending in native code, then presentation, without appending retired control bytes', async () => {
    const f = fixture(),
      presentation = deferred<void>()
    const native = deferred<Awaited<ReturnType<typeof f.host.input>>>()
    await f.app.attach('session', f.owner, f.frame)
    f.host.input
      .mockResolvedValueOnce({
        bytes: new Uint8Array(),
        capacity: 0,
        source: 'user',
        requestedMutation: 0,
      })
      .mockReturnValueOnce(native.promise)
    f.presenter.detach.mockReturnValue(presentation.promise)
    const detaching = f.app.detach('view', f.owner)
    void detaching.catch(() => undefined)
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledTimes(2))
    const removing = f.app.remove('session', 'instance')
    try {
      expect(f.sessions.remove).not.toHaveBeenCalled()
      native.resolve({
        bytes: Uint8Array.of(1),
        capacity: 1,
        source: 'terminal-response',
        requestedMutation: 0,
      })
      await vi.waitFor(() => expect(f.presenter.detach).toHaveBeenCalledOnce())
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(f.sessions.remove).not.toHaveBeenCalled()
    } finally {
      presentation.resolve()
      await Promise.all([detaching, removing])
    }
    expect(f.host.input).toHaveBeenCalledTimes(2)
    expect(f.sessions.writeControl).not.toHaveBeenCalled()
    expect(f.sessions.remove).toHaveBeenCalledOnce()
  })
  it.each([false, true])(
    'joins supervisor and renderer removal after presentation/input settle (readonly=%s)',
    async (readonly) => {
      const f = fixture(),
        viewId = randomUUID()
      const { raw, prepared } = await preparation(f)
      f.presenter.attach.mockResolvedValue(viewId)
      await f.app.attach('session', f.owner, f.frame)
      await f.app.update(viewId, f.owner, f.layout)
      if (!readonly) await f.app.input(viewId, f.owner, { kind: 'focus', focused: true })
      f.state.readonly = readonly
      if (readonly) f.ptys.get.mockReturnValue(undefined)
      const input = deferred<void>(),
        presentation = deferred<void>()
      f.state.inputSettlement = input.promise
      let reentered: Promise<void> | undefined
      f.presenter.detach.mockImplementation(() => {
        reentered = f.app.remove('session', 'instance')
        return presentation.promise
      })
      const isFrameCurrent = vi.mocked(
        f.targets.create as NativeTerminalPresentationTargets['create'],
      ).mock.calls[0]![1]
      expect(isFrameCurrent()).toBe(true)
      f.host.input.mockClear()
      const removing = prepared.dispose()
      expect(f.app.remove('session', 'instance')).toBe(removing)
      expect(isFrameCurrent()).toBe(false)
      await expect(f.app.attach('session', f.owner, f.frame)).rejects.toThrow(
        'native-session-foreign',
      )
      await expect(f.app.demand(viewId, f.owner)).rejects.toThrow('native-view-foreign')
      expect(() =>
        f.app.input(viewId, f.owner, { kind: 'focus', focused: false }),
      ).toThrow('native-view-stale')
      await expect(
        f.app.query({ kind: 'active-screen', viewId, requestId: randomUUID() }, f.owner),
      ).rejects.toThrow('native-view-foreign')
      await expect(f.app.remove('session', 'different-instance')).rejects.toThrow(
        'native-session-instance-stale',
      )
      await vi.waitFor(() => expect(f.presenter.detach).toHaveBeenCalledOnce())
      expect(reentered).toBe(removing)
      expect(f.sessions.remove).not.toHaveBeenCalled()
      presentation.resolve()
      await Promise.resolve()
      expect(f.sessions.remove).not.toHaveBeenCalled()
      input.resolve()
      await removing
      expect(f.sessions.remove).toHaveBeenCalledExactlyOnceWith('session', 'instance')
      expect(f.host.input).not.toHaveBeenCalled()
      expect(raw.dispose).not.toHaveBeenCalled()
    },
  )

  it('never calls a lost producer to blur during explicit destruction', async () => {
    const f = fixture()
    const { prepared } = await preparation(f)
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    f.state.unavailable = true
    f.current.mockReturnValue(false)
    f.host.input.mockClear().mockRejectedValue(new Error('native-host-lost'))
    await prepared.dispose()
    expect(f.host.input).not.toHaveBeenCalled()
    expect(f.presenter.detach).toHaveBeenCalledExactlyOnceWith('view')
    expect(f.sessions.remove).toHaveBeenCalledExactlyOnceWith('session', 'instance')
  })

  it('retires pending encoded user input without appending it after close', async () => {
    const f = fixture(),
      encoded = deferred<Uint8Array<ArrayBuffer>>()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    f.host.encodeKey.mockReturnValueOnce(encoded.promise)
    const key = f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
    const rejected = expect(key).rejects.toThrow('native-view-stale')
    await vi.waitFor(() => expect(f.host.encodeKey).toHaveBeenCalledOnce())
    const removing = f.app.remove('session', 'instance')
    expect(f.sessions.remove).not.toHaveBeenCalled()
    encoded.resolve(Uint8Array.of(120))
    await rejected
    await removing
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.remove).toHaveBeenCalledOnce()
  })

  it('preserves ordinary detach blur failures while still releasing presentation', async () => {
    const f = fixture(),
      failure = new Error('native-blur-failed')
    await f.app.attach('session', f.owner, f.frame)
    f.host.input.mockRejectedValue(failure)
    await expect(f.app.detach('view', f.owner)).rejects.toBe(failure)
    expect(f.host.input).toHaveBeenCalledOnce()
    expect(f.presenter.detach).toHaveBeenCalledExactlyOnceWith('view')
    expect(f.sessions.remove).not.toHaveBeenCalled()
  })

  it('propagates exact raw destruction failures to every joined close', async () => {
    const f = fixture(),
      failure = new Error('native-destroy-failed')
    const { prepared } = await preparation(f)
    await f.app.attach('session', f.owner, f.frame)
    f.sessions.remove.mockRejectedValue(failure)
    const first = prepared.dispose(),
      second = f.app.remove('session', 'instance')
    expect(second).toBe(first)
    await expect(first).rejects.toBe(failure)
    await expect(second).rejects.toBe(failure)
    expect(f.sessions.remove).toHaveBeenCalledOnce()
    expect(f.presenter.detach).toHaveBeenCalledOnce()
  })

  it('leaves failed preparation rollback with the session owner', async () => {
    const f = fixture(),
      failure = new Error('native-prepare-cancelled')
    f.sessions.prepare.mockRejectedValue(failure)
    await expect(
      f.app.preparation({ width: 32, height: 32, backingScale: 1 })(
        f.state.session,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure)
    expect(f.sessions.remove).not.toHaveBeenCalled()
  })
})
