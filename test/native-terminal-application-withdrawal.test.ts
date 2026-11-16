import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import { validNativeTerminalViewGrant } from '../src/shared/native-terminal-presentation'
import type { NativeTerminalInputResult } from '../src/shared/native-terminal-input'
import { nativeTerminalApplicationFixture } from './fixtures/native-terminal-application'
import {
  nativeTerminalPresenterFixture,
  deferred,
} from './fixtures/native-terminal-presenter'

vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

const emptyResult: NativeTerminalInputResult = {
  bytes: new Uint8Array(),
  capacity: 0,
  source: 'terminal-response',
  requestedMutation: 0,
}

async function fixture() {
  const f = nativeTerminalApplicationFixture()
  const p = nativeTerminalPresenterFixture()
  const targets = new NativeTerminalPresentationTargets()
  f.host.inspectProducer.mockImplementation(() => Promise.resolve(p.status()))
  const app = new NativeTerminalApplication(
    f.sessions,
    f.host,
    p.owner,
    targets,
    f.ptys,
    f.current,
  )
  const id = await app.attach('session', f.owner, f.frame)
  await app.update(id, f.owner, f.layout)
  function grant() {
    for (const [, value] of f.frameSend.mock.calls.toReversed()) {
      const message: unknown = value
      if (
        message &&
        typeof message === 'object' &&
        'grant' in message &&
        validNativeTerminalViewGrant(message.grant)
      )
        return message.grant
    }
    throw new Error('test-grant-missing')
  }
  const first = grant()
  targets.acknowledge(f.frame, { kind: 'drawn', grant: first, screen: 0 })
  expect(targets.drawn(id, f.frame)).toBeDefined()
  const blur = deferred<NativeTerminalInputResult>()
  f.host.input.mockReturnValueOnce(blur.promise)
  return { ...f, app, p, targets, id, grant, first, blur }
}

describe('application hide withdraws main presentation before physical blur', () => {
  it('revokes the real target synchronously while retaining captured input cleanup', async () => {
    const f = await fixture()
    const hiding = f.app.update(f.id, f.owner, { ...f.layout, visible: false })
    expect(f.targets.drawn(f.id, f.frame)).toBeUndefined()
    expect(f.p.owner.isInputCurrent(f.id)).toBe(false)
    expect(await f.p.owner.demand(f.id)).toBe(false)
    expect(f.p.host.takeFrame).not.toHaveBeenCalled()
    let settled = false
    void hiding.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    f.targets.acknowledge(f.frame, { kind: 'drawn', grant: f.first, screen: 0 })
    expect(f.targets.drawn(f.id, f.frame)).toBeUndefined()
    f.blur.resolve(emptyResult)
    await hiding
    await f.app.remove('session', 'instance')
  })

  it('withdraws ordinary detach before its captured physical blur settles', async () => {
    const f = await fixture()
    const detaching = f.app.detach(f.id, f.owner)
    expect(f.targets.drawn(f.id, f.frame)).toBeUndefined()
    expect(f.p.owner.isInputCurrent(f.id)).toBe(false)
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    expect(f.p.host.detach).not.toHaveBeenCalled()
    f.blur.resolve(emptyResult)
    await detaching
    expect(f.p.host.detach).toHaveBeenCalledOnce()
    await f.app.remove('session', 'instance')
  })

  it.each(['resize', 'frame'] as const)(
    'fences a pending %s without undoing a newer show when old blur completes',
    async (kind) => {
      const f = await fixture()
      const physical = deferred<ReturnType<typeof f.p.status>>()
      const frame = deferred<ReturnType<typeof f.p.source> | undefined>()
      const source = f.p.source()
      if (kind === 'resize') f.p.host.resize.mockReturnValueOnce(physical.promise)
      else f.p.host.takeFrame.mockReturnValueOnce(frame.promise)
      const pending =
        kind === 'resize' ? f.app.update(f.id, f.owner, f.layout) : f.p.owner.demand(f.id)
      await vi.waitFor(() =>
        expect(
          kind === 'resize' ? f.p.host.resize : f.p.host.takeFrame,
        ).toHaveBeenCalledTimes(kind === 'resize' ? 2 : 1),
      )
      const hiding = f.app.update(f.id, f.owner, { ...f.layout, visible: false })
      expect(f.targets.drawn(f.id, f.frame)).toBeUndefined()
      expect(f.p.owner.isInputCurrent(f.id)).toBe(false)
      const grantsBefore = f.frameSend.mock.calls.length
      physical.resolve(f.p.status())
      frame.resolve(source)
      await pending
      expect(f.frameSend.mock.calls.length).toBe(grantsBefore)
      expect(f.p.imports.acquire).not.toHaveBeenCalled()
      if (kind === 'frame') expect(source.release).toHaveBeenCalledOnce()
      await f.app.update(f.id, f.owner, f.layout)
      const current = f.grant()
      expect(current.geometrySerial).toBeGreaterThan(f.first.geometrySerial)
      f.targets.acknowledge(f.frame, { kind: 'drawn', grant: current, screen: 0 })
      expect(f.targets.drawn(f.id, f.frame)?.geometrySerial).toBe(current.geometrySerial)
      f.blur.resolve(emptyResult)
      await hiding
      expect(f.targets.drawn(f.id, f.frame)?.geometrySerial).toBe(current.geometrySerial)
      expect(f.p.owner.isInputCurrent(f.id)).toBe(true)
      await f.app.remove('session', 'instance')
    },
  )

  it('joins held blur even when grant publication throws and preserves both failures', async () => {
    const f = nativeTerminalApplicationFixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    const blur = deferred<NativeTerminalInputResult>()
    const withdrawalFailure = new Error('withdrawal-failed')
    const blurFailure = new Error('physical-blur-failed')
    f.host.input.mockReturnValueOnce(blur.promise)
    f.presenter.withdraw.mockImplementationOnce(() => {
      throw withdrawalFailure
    })
    let settled = false
    const hiding = f.app.update('view', f.owner, { ...f.layout, visible: false })
    const outcome = hiding.then(
      () => {
        settled = true
        return undefined
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    blur.reject(blurFailure)
    const failure = await outcome
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([withdrawalFailure, blurFailure])
    expect(f.presenter.update).toHaveBeenCalledTimes(1)
    await f.app.remove('session', 'instance')
  })
})
