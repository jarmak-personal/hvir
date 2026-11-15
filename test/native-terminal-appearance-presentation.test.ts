import { describe, expect, it, vi } from 'vitest'
import type { NativeTerminalAppearance } from '../src/shared/native-terminal-appearance'
import {
  nativeTerminalPresenterFixture,
  deferred,
} from './fixtures/native-terminal-presenter'
import { nativeTerminalApplicationFixture } from './fixtures/native-terminal-application'
vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

const appearance: NativeTerminalAppearance = {
  fontFamily: 'monospace',
  fontSize: 13,
  ligatures: true,
  cursorShape: 'block',
  cursorBlink: 'terminal',
  appearance: 'dark',
  colors: Array(22).fill(0x123456),
}
const layout = { width: 640, height: 400, backingScale: 1.25, visible: true }

describe('native appearance and presentation completion', () => {
  it('retains the exact geometry/input grant for palette and cursor changes', async () => {
    const f = nativeTerminalPresenterFixture()
    const id = await f.owner.attach('state', f.session, f.target)
    await f.owner.appearance(id, appearance)
    await f.owner.update(id, layout)
    f.target.publishGrant.mockClear()
    f.host.resize.mockClear()
    expect(
      await f.owner.appearance(id, {
        ...appearance,
        colors: Array(22).fill(0xeeeeee),
        cursorShape: 'bar',
      }),
    ).toBe(false)
    expect(f.target.publishGrant).not.toHaveBeenCalled()
    expect(f.host.resize).not.toHaveBeenCalled()
    expect(f.owner.isInputCurrent(id)).toBe(true)
  })
  it('revokes old input and holds simultaneous layout until the font fence settles', async () => {
    const f = nativeTerminalPresenterFixture()
    const id = await f.owner.attach('state', f.session, f.target)
    await f.owner.appearance(id, appearance)
    await f.owner.update(id, layout)
    const fence = deferred<Awaited<ReturnType<typeof f.host.appearance>>>()
    f.host.appearance.mockReturnValueOnce(fence.promise)
    f.host.resize.mockClear()
    const configuring = f.owner.appearance(id, { ...appearance, fontSize: 18 })
    const resizing = f.owner.update(id, { ...layout, backingScale: 1.5 })
    await Promise.resolve()
    expect(f.owner.isInputCurrent(id)).toBe(false)
    expect(await f.owner.demand(id)).toBe(false)
    expect(f.host.resize).not.toHaveBeenCalled()
    fence.resolve(await f.host.inspect())
    expect(await configuring).toBe(true)
    const grant = await resizing
    expect(grant).toMatchObject({ width: 960, height: 600, backingScale: 1.5 })
    expect(f.owner.isInputCurrent(id)).toBe(true)
  })
  it('retains a typography refit obligation when a newer palette supersedes its completion', async () => {
    const f = nativeTerminalPresenterFixture()
    const id = await f.owner.attach('state', f.session, f.target)
    await f.owner.appearance(id, appearance)
    await f.owner.update(id, layout)
    const fence = deferred<Awaited<ReturnType<typeof f.host.appearance>>>()
    f.host.appearance.mockReturnValueOnce(fence.promise)
    const font = { ...appearance, fontSize: 18 }
    const configuring = f.owner.appearance(id, font)
    const rejected = expect(configuring).rejects.toThrow('superseded')
    const palette = f.owner.appearance(id, { ...font, colors: Array(22).fill(0xffffff) })
    fence.resolve(await f.host.inspect())
    await rejected
    expect(await palette).toBe(true)
    expect(f.owner.isInputCurrent(id)).toBe(false)
    await f.owner.update(id, layout)
    expect(f.owner.isInputCurrent(id)).toBe(true)
  })
  it('flushes settings arriving between the native continuation and work settlement', async () => {
    const f = nativeTerminalPresenterFixture()
    const id = await f.owner.attach('state', f.session, f.target)
    await f.owner.appearance(id, appearance)
    await f.owner.update(id, layout)
    const fence = deferred<Awaited<ReturnType<typeof f.host.appearance>>>()
    f.host.appearance.mockReturnValueOnce(fence.promise)
    const font = { ...appearance, fontSize: 18 }
    const first = f.owner.appearance(id, font)
    const rejected = expect(first).rejects.toThrow('superseded')
    const latest = { ...font, colors: Array(22).fill(0xeeeeee) }
    const next = fence.promise.then(() => f.owner.appearance(id, latest))
    fence.resolve(await f.host.inspect())
    expect(await next).toBe(true)
    await rejected
    expect(f.host.appearance).toHaveBeenCalledTimes(3)
    expect(f.host.appearance).toHaveBeenLastCalledWith('state', 1, 1, 1, latest)
  })
  it('rejects completion from a detached attachment and never republishes its grant', async () => {
    const f = nativeTerminalPresenterFixture()
    const id = await f.owner.attach('state', f.session, f.target)
    const fence = deferred<Awaited<ReturnType<typeof f.host.appearance>>>()
    f.host.appearance.mockReturnValueOnce(fence.promise)
    const configuring = f.owner.appearance(id, appearance)
    const rejected = expect(configuring).rejects.toThrow()
    await Promise.resolve()
    await f.owner.detach(id)
    f.target.publishGrant.mockClear()
    fence.resolve(await f.host.inspect())
    await rejected
    expect(f.target.publishGrant).not.toHaveBeenCalled()
  })
  it('notifies the PTY only after configuration and its following applied resize', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.ptys.resize.mockClear()
    const fence = deferred<boolean>()
    f.presenter.appearance.mockReturnValueOnce(fence.promise)
    const configuring = f.app.appearance('view', f.owner, appearance)
    expect(f.ptys.resize).not.toHaveBeenCalled()
    f.presenter.appearance.mockResolvedValue(true)
    const resized = deferred<typeof f.grant>()
    f.presenter.update.mockReturnValueOnce(resized.promise)
    fence.resolve(true)
    await vi.waitFor(() => expect(f.presenter.update).toHaveBeenCalledTimes(2))
    expect(f.ptys.resize).not.toHaveBeenCalled()
    resized.resolve(f.grant)
    await configuring
    expect(f.ptys.resize).toHaveBeenCalledOnce()
    f.app.dispose()
  })
  it('returns readiness only for a current visible presentation grant', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    expect(await f.app.appearance('view', f.owner, appearance)).toBe(false)
    await f.app.update('view', f.owner, f.layout)
    expect(await f.app.appearance('view', f.owner, appearance)).toBe(true)
    f.presenter.isInputCurrent.mockReturnValue(false)
    expect(await f.app.appearance('view', f.owner, appearance)).toBe(false)
    f.app.dispose()
  })
  it('rejects settings superseded while their internal geometry acknowledgement is pending', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.presenter.appearance.mockResolvedValueOnce(true)
    const geometry = deferred<typeof f.grant>()
    f.presenter.update.mockReturnValueOnce(geometry.promise)
    const first = f.app.appearance('view', f.owner, appearance)
    const rejected = expect(first).rejects.toThrow('superseded')
    await vi.waitFor(() => expect(f.presenter.update).toHaveBeenCalledTimes(2))
    await f.app.appearance('view', f.owner, { ...appearance, cursorShape: 'bar' })
    geometry.resolve(f.grant)
    await rejected
    expect(f.presenter.suspend).not.toHaveBeenCalled()
    f.app.dispose()
  })
  it('routes an idle palette application failure through existing unavailable presentation while retaining the PTY', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.presenter.appearance.mockRejectedValueOnce(new Error('native-appearance-failed'))
    await expect(f.app.appearance('view', f.owner, appearance)).rejects.toThrow(
      'native-appearance-failed',
    )
    expect(f.presenter.suspend).toHaveBeenCalledExactlyOnceWith('view')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.remove).not.toHaveBeenCalled()
    f.app.dispose()
  })
  it('rejects an older settings completion without refitting a newer request', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.presenter.update.mockClear()
    const older = deferred<boolean>()
    f.presenter.appearance.mockReturnValueOnce(older.promise)
    const old = f.app.appearance('view', f.owner, appearance)
    const rejected = expect(old).rejects.toThrow('superseded')
    await f.app.appearance('view', f.owner, { ...appearance, cursorShape: 'bar' })
    older.resolve(true)
    await rejected
    expect(f.presenter.update).not.toHaveBeenCalled()
    f.app.dispose()
  })
})
