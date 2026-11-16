import type { WebFrameMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalPresenter } from '../src/main/terminal/native-terminal-presenter'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import type { NativeTerminalSession } from '../src/shared/native-terminal'
import { deferred } from './fixtures/native-terminal-presenter'
import { nativeTerminalHostFixture } from './fixtures/native-terminal-host'

async function fixture() {
  const f = nativeTerminalHostFixture()
  const previous = f.session()
  const handle = await f.host.prepare(previous, 32, 32)
  const targets = new NativeTerminalPresentationTargets()
  const imports = {
    acquire: vi.fn(() => Promise.reject(new Error('unexpected-frame-import'))),
  }
  const presenter = new NativeTerminalPresenter(f.host, imports)
  const target = (session: NativeTerminalSession) =>
    targets.create(
      { isDestroyed: () => false, send: vi.fn() } as unknown as WebFrameMain,
      () =>
        f.live.renderer &&
        f.live.owner === session.ownerId &&
        f.live.generation === session.ownerGeneration,
      () => true,
    )
  const oldView = await presenter.attach(handle, previous, target(previous))
  return { f, previous, handle, targets, presenter, target, oldView }
}

/** Real Host/Presenter/Target owners; only the immediate native process is simulated.
 * This proves retained geometry serial ownership, not a native/GPU or CI cause. */
describe('retained native presentation renewal after refused resize admission', () => {
  it('does not reuse the old attachment resize serial when applied geometry has not advanced', async () => {
    const { f, previous, handle, targets, presenter, target, oldView } = await fixture()
    const originalRequest = f.request.getMockImplementation()!
    const refusal = new NativeTerminalAdmissionError('native-command-bound')
    let refusedSerial: number | undefined
    const admittedSerials: number[] = []
    f.request.mockImplementation((command, signal) => {
      if (command.kind === 'resize') {
        if (refusedSerial === undefined) {
          refusedSerial = command.serial
          return Promise.reject(refusal)
        }
        admittedSerials.push(command.serial)
        // Only an admitted resize may advance the simulated native applied state.
        f.live.status = {
          ...f.live.status,
          geometry: {
            ...f.live.status.geometry,
            serial: command.serial,
            width: command.width,
            height: command.height,
            backingScale: command.backingScale ?? 1,
          },
        }
      }
      return originalRequest(command, signal)
    })
    let renewedView: string | undefined
    try {
      await expect(
        presenter.update(oldView, {
          width: 64,
          height: 32,
          backingScale: 1,
          visible: true,
        }),
      ).rejects.toBe(refusal)
      expect(refusedSerial).toBe(2)
      expect(admittedSerials).toEqual([])
      expect(
        (await f.host.inspectProducer(handle, previous.instanceId)).geometry.serial,
      ).toBe(1)

      f.live.owner = 2
      f.live.generation = 2
      const renewed = { ...previous, ownerId: 2, ownerGeneration: 2 }
      f.sessions.set(previous.sessionId, renewed)
      renewedView = await presenter.attach(handle, renewed, target(renewed))
      expect(renewedView).not.toBe(oldView)
      expect(
        (await f.host.inspectProducer(handle, renewed.instanceId)).geometry.serial,
      ).toBe(1)
      expect(
        f.request.mock.calls.filter(([command]) => command.kind === 'create'),
      ).toHaveLength(1)

      const grant = await presenter.update(renewedView, {
        width: 64,
        height: 32,
        backingScale: 1,
        visible: true,
      })
      expect(grant).toBeDefined()
      expect(grant!.geometrySerial).toBeGreaterThan(refusedSerial!)
      expect(admittedSerials).toEqual([grant!.geometrySerial])
      expect(presenter.isInputCurrent(renewedView)).toBe(true)
    } finally {
      if (renewedView) await presenter.detach(renewedView)
      await presenter.detach(oldView)
      targets.dispose()
      f.host.dispose()
    }
  })

  it('renews above an admitted reservation while its old applied inspection is pending', async () => {
    const { f, previous, handle, targets, presenter, target, oldView } = await fixture()
    const originalRequest = f.request.getMockImplementation()!
    const oldInspection = deferred<typeof f.live.status>()
    const inspectionEntered = deferred<void>()
    let heldInspection = false
    const admittedSerials: number[] = []
    f.request.mockImplementation((command, signal) => {
      if (command.kind === 'resize') {
        admittedSerials.push(command.serial)
        if (command.serial > 2)
          f.live.status = {
            ...f.live.status,
            geometry: {
              ...f.live.status.geometry,
              serial: command.serial,
              width: command.width,
              height: command.height,
              backingScale: command.backingScale ?? 1,
            },
          }
      }
      if (command.kind === 'inspect' && admittedSerials.length === 1 && !heldInspection) {
        heldInspection = true
        inspectionEntered.resolve()
        return oldInspection.promise
      }
      return originalRequest(command, signal)
    })
    const updating = presenter.update(oldView, {
      width: 64,
      height: 32,
      backingScale: 1,
      visible: true,
    })
    void updating.catch(() => undefined)
    let renewedView: string | undefined
    try {
      await inspectionEntered.promise
      expect(admittedSerials).toEqual([2])
      expect(
        (await f.host.inspectProducer(handle, previous.instanceId)).geometry.serial,
      ).toBe(1)
      f.live.owner = 2
      f.live.generation = 2
      const renewed = { ...previous, ownerId: 2, ownerGeneration: 2 }
      f.sessions.set(previous.sessionId, renewed)
      renewedView = await presenter.attach(handle, renewed, target(renewed))
      expect(
        (await f.host.inspectProducer(handle, renewed.instanceId)).geometry.serial,
      ).toBe(1)
      const grant = await presenter.update(renewedView, {
        width: 64,
        height: 32,
        backingScale: 1,
        visible: true,
      })
      expect(grant!.geometrySerial).toBe(3)
      expect(admittedSerials).toEqual([2, 3])
      oldInspection.resolve(f.live.status)
      await updating
      expect(presenter.isInputCurrent(renewedView)).toBe(true)
    } finally {
      oldInspection.resolve(f.live.status)
      await Promise.allSettled([updating])
      if (renewedView) await presenter.detach(renewedView)
      await presenter.detach(oldView)
      targets.dispose()
      f.host.dispose()
    }
  })

  it('qualifies the floor by exact current owner and attachment without native requests', async () => {
    const f = nativeTerminalHostFixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const first = f.host.attach(handle, session)
    const second = f.host.attach(handle, session)
    const requestsBefore = f.request.mock.calls.length
    try {
      expect(f.host.geometryIssuanceFloor(handle, 1, 1, second)).toBe(1)
      expect(() => f.host.geometryIssuanceFloor(handle, 1, 1, first)).toThrow(
        'native-attachment-stale',
      )
      f.live.owner = 2
      f.live.generation = 2
      const renewed = { ...session, ownerId: 2, ownerGeneration: 2 }
      f.sessions.set(session.sessionId, renewed)
      expect(() => f.host.geometryIssuanceFloor(handle, 1, 1, second)).toThrow(
        'native-state-foreign',
      )
      const next = f.host.attach(handle, renewed)
      expect(() => f.host.geometryIssuanceFloor(handle, 2, 2, second)).toThrow(
        'native-attachment-stale',
      )
      expect(f.host.geometryIssuanceFloor(handle, 2, 2, next)).toBe(1)
      expect(f.request).toHaveBeenCalledTimes(requestsBefore)
    } finally {
      f.host.dispose()
    }
  })
})
