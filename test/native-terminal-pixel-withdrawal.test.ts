import type { WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NativeTerminalGpuImportUnavailable } from '../src/main/terminal/native-terminal-import'
import { NativeTerminalPresenter } from '../src/main/terminal/native-terminal-presenter'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import {
  NATIVE_TERMINAL_PRESENTATION as channels,
  type NativeTerminalPixelFrame,
  type NativeTerminalPresentationStatus,
} from '../src/shared/native-terminal-presentation'
import { nativeTerminalPresenterFixture } from './fixtures/native-terminal-presenter'

function fixture() {
  const f = nativeTerminalPresenterFixture()
  const targets = new NativeTerminalPresentationTargets()
  const uploads: { ticket: string; frame: NativeTerminalPixelFrame }[] = []
  const statuses: NativeTerminalPresentationStatus[] = []
  const frame = {
    isDestroyed: () => false,
    send(channel: string, value: unknown) {
      if (channel === channels.pixelsChannel)
        uploads.push(value as (typeof uploads)[number])
      else if (channel === channels.statusChannel)
        statuses.push(value as NativeTerminalPresentationStatus)
    },
  } as unknown as WebFrameMain
  const target = targets.create(
    frame,
    () => true,
    () => true,
  )
  f.imports.acquire.mockRejectedValue(
    new NativeTerminalGpuImportUnavailable(new Error('fixture GPU unavailable')),
  )
  const presenter = new NativeTerminalPresenter(f.host, f.imports)
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  return { ...f, targets, uploads, statuses, frame, target, presenter, clock }
}
const visible = { width: 64, height: 32, backingScale: 1, visible: true }
afterEach(() => vi.restoreAllMocks())

describe('real presentation target pixel withdrawal', () => {
  it('drops a qualified locally-ineligible upload without success, failure or drawn authority and presents after a new grant', async () => {
    const f = fixture()
    const id = await f.presenter.attach('state', f.session, f.target)
    const grant = await f.presenter.update(id, visible)
    const pending = f.presenter.demand(id)
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(f.uploads).toHaveLength(1))
    const upload = f.uploads[0]!
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const withdrawal = {
      kind: 'pixels',
      ticket: upload.ticket,
      accepted: false,
      discarded: 'local-ineligible',
      grant: upload.frame.nativeTerminal,
    }
    f.targets.acknowledge({} as WebFrameMain, withdrawal)
    await Promise.resolve()
    expect(settled).toBe(false)
    f.targets.acknowledge(f.frame, withdrawal)
    await expect(pending).resolves.toBe(false)
    expect(f.sources[0]!.release).toHaveBeenCalledOnce()
    expect(f.statuses).toEqual([])
    expect(f.presenter.isInputCurrent(id)).toBe(true)
    expect(f.targets.drawn(id, f.frame)).toBeUndefined()
    await f.presenter.update(id, { ...visible, visible: false })
    expect(f.presenter.isInputCurrent(id)).toBe(false)
    const resumed = await f.presenter.update(id, visible)
    expect(resumed!.geometrySerial).toBeGreaterThan(grant!.geometrySerial)
    f.clock.mockReturnValue(2000)
    const next = f.presenter.demand(id)
    await vi.waitFor(() => expect(f.uploads).toHaveLength(2))
    const current = f.uploads[1]!
    f.targets.acknowledge(f.frame, withdrawal)
    expect(f.sources[1]!.release).not.toHaveBeenCalled()
    f.targets.acknowledge(f.frame, {
      kind: 'pixels',
      ticket: current.ticket,
      accepted: true,
    })
    await expect(next).resolves.toBe(true)
    expect(f.sources[1]!.release).toHaveBeenCalledOnce()
    expect(f.targets.drawn(id, f.frame)).toBeUndefined()
    f.targets.acknowledge(f.frame, {
      kind: 'drawn',
      grant: current.frame.nativeTerminal,
      screen: 0,
    })
    expect(f.targets.drawn(id, f.frame)).toEqual({
      screen: 0,
      geometrySerial: resumed!.geometrySerial,
      nativeEpoch: resumed!.nativeEpoch,
      attachment: resumed!.attachment,
    })
    expect(f.host.attach).toHaveBeenCalledOnce()
    expect(f.statuses).toEqual([
      { viewId: id, mode: 'native-pixels', reason: 'import-unavailable' },
    ])
    await f.presenter.detach(id)
    f.targets.dispose()
  })

  it.each([
    'ordinary-refusal',
    'wrong-grant',
    'unknown-discard',
    'accepted-discard',
  ] as const)('preserves a genuine %s as presentation failure', async (mode) => {
    const f = fixture()
    const id = await f.presenter.attach('state', f.session, f.target)
    await f.presenter.update(id, visible)
    const pending = f.presenter.demand(id)
    const rejected = expect(pending).rejects.toThrow('rejected')
    await vi.waitFor(() => expect(f.uploads).toHaveLength(1))
    const upload = f.uploads[0]!
    f.targets.acknowledge(f.frame, {
      kind: 'pixels',
      ticket: upload.ticket,
      accepted: mode === 'accepted-discard',
      ...(mode === 'ordinary-refusal'
        ? {}
        : {
            discarded: mode === 'unknown-discard' ? 'unknown' : 'local-ineligible',
            grant: {
              ...upload.frame.nativeTerminal,
              ...(mode === 'wrong-grant'
                ? { geometrySerial: upload.frame.nativeTerminal.geometrySerial + 1 }
                : {}),
            },
          }),
    })
    await rejected
    expect(f.sources[0]!.release).toHaveBeenCalledOnce()
    expect(f.presenter.isInputCurrent(id)).toBe(false)
    expect(f.targets.drawn(id, f.frame)).toBeUndefined()
    expect(f.statuses).toEqual([
      { viewId: id, mode: 'unavailable', reason: 'native-lost' },
    ])
    await f.presenter.detach(id)
    f.targets.dispose()
  })
})
