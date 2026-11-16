import { describe, expect, it, vi } from 'vitest'
import type { NativeTerminalPresenter } from '../src/main/terminal/native-terminal-presenter'
import type { NativeTerminalInputResult } from '../src/shared/native-terminal-input'
import { nativeTerminalApplicationFixture as fixture } from './fixtures/native-terminal-application'

vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const emptyResult: NativeTerminalInputResult = {
  bytes: new Uint8Array(),
  capacity: 0,
  source: 'user',
  requestedMutation: 0,
}

describe('native application layout authority before presentation effects', () => {
  it('cannot reapply an older hidden layout after a newer show settles during native blur', async () => {
    const f = fixture(),
      physicalBlur = deferred<NativeTerminalInputResult>()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    let presenterVisible = true
    const update = vi.mocked(f.presenter.update as NativeTerminalPresenter['update'])
    update.mockClear().mockImplementation((_viewId, layout) => {
      presenterVisible = layout.visible
      return Promise.resolve(f.grant)
    })
    f.presenter.isInputCurrent.mockImplementation(() => presenterVisible)
    f.host.input.mockClear().mockReturnValueOnce(physicalBlur.promise)
    const hiding = f.app.update('view', f.owner, { ...f.layout, visible: false })
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    await f.app.update('view', f.owner, f.layout)
    expect(presenterVisible).toBe(true)
    physicalBlur.resolve(emptyResult)
    await hiding
    expect(update.mock.calls.map(([, layout]) => layout.visible)).toEqual([true])
    expect(presenterVisible).toBe(true)
    await expect(
      f.app.input('view', f.owner, { kind: 'focus', focused: true }),
    ).resolves.toMatchObject({ requestedMutation: 0 })
    expect(f.sessions.remove).not.toHaveBeenCalled()
  })

  it('cannot apply an old hide after destructive removal retires its view', async () => {
    const f = fixture(),
      physicalBlur = deferred<NativeTerminalInputResult>()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.host.input.mockClear().mockReturnValueOnce(physicalBlur.promise)
    f.presenter.update.mockClear()
    const hiding = f.app.update('view', f.owner, { ...f.layout, visible: false })
    const rejected = expect(hiding).rejects.toThrow('native-view-foreign')
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    const removing = f.app.remove('session', 'instance')
    physicalBlur.resolve(emptyResult)
    await rejected
    await removing
    expect(f.presenter.update).not.toHaveBeenCalled()
    expect(f.presenter.detach).toHaveBeenCalledExactlyOnceWith('view')
    expect(f.sessions.remove).toHaveBeenCalledOnce()
  })

  it('cannot apply an old-owner hide while the same native state is being attached by a new owner', async () => {
    const f = fixture(),
      physicalBlur = deferred<NativeTerminalInputResult>()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.host.input.mockClear().mockReturnValueOnce(physicalBlur.promise)
    f.presenter.update.mockClear()
    const hiding = f.app.update('view', f.owner, { ...f.layout, visible: false })
    const rejected = expect(hiding).rejects.toThrow(/native-(session|view)-foreign/)
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    const nextOwner = { id: 2, generation: 1 }
    f.state.session = { ...f.state.session, ownerId: nextOwner.id }
    f.presenter.attach.mockResolvedValue('replacement')
    const attaching = f.app.attach('session', nextOwner, f.frame)
    physicalBlur.resolve(emptyResult)
    await rejected
    await expect(attaching).resolves.toBe('replacement')
    expect(f.presenter.update).not.toHaveBeenCalled()
    expect(f.sessions.remove).not.toHaveBeenCalled()
  })
})
