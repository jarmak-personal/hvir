// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NativeTerminalPresentationReceiver,
  type NativeTerminalCanvasPort,
} from '../src/preload/native-terminal-presentation'
import {
  NATIVE_TERMINAL_PRESENTATION,
  type NativeTerminalPresentationStatus,
} from '../src/shared/native-terminal-presentation'
import {
  nativeTerminalPresenterFixture,
  deferred,
} from './fixtures/native-terminal-presenter'

afterEach(() => vi.restoreAllMocks())

describe('readonly retained pane during native geometry acknowledgement', () => {
  it('revokes its old canvas until current geometry and an actual matching pixel delivery complete', async () => {
    const f = nativeTerminalPresenterFixture('pixels')
    const pane = document.createElement('div')
    pane.className = 'native-terminal-pane'
    const surface = document.createElement('div')
    pane.appendChild(surface)
    document.body.appendChild(pane)
    const createCanvas = vi.fn((_elementId: string): NativeTerminalCanvasPort => {
      const canvas = document.createElement('canvas')
      surface.appendChild(canvas)
      return {
        draw: vi.fn(),
        pixels: (frame) => {
          canvas.width = frame.nativeTerminal.width
          canvas.height = frame.nativeTerminal.height
        },
        dispose: () => canvas.remove(),
      }
    })
    const receiver = new NativeTerminalPresentationReceiver(createCanvas)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const acknowledged = deferred<void>()
    let updating: ReturnType<typeof f.owner.update> | undefined
    let attachedId: string | undefined
    try {
      const id = await f.owner.attach('state', f.session, f.target)
      attachedId = id
      surface.id = `native-terminal-${id}`
      receiver.mount(id, surface.id)
      f.target.publishGrant.mockImplementation((grant) => {
        receiver.grant({ viewId: id, grant })
      })
      f.target.publishStatus.mockImplementation(
        (status: NativeTerminalPresentationStatus) => receiver.status(status),
      )
      f.target.sendPixels.mockImplementation((frame) => {
        if (!receiver.pixels(frame)) throw new Error('test pixel delivery refused')
        return Promise.resolve()
      })
      f.host.takeFrame.mockImplementation(() => {
        const source = f.source()
        source.metadata.kind = 3
        return Promise.resolve(source)
      })
      const first = await f.owner.update(id, {
        width: 64,
        height: 64,
        backingScale: 1,
        visible: true,
      })
      expect(await f.owner.demand(id)).toBe(true)
      const oldPixels = f.target.sendPixels.mock.calls[0]![0]
      expect(oldPixels.nativeTerminal).toEqual(first)
      expect(surface.querySelectorAll('canvas')).toHaveLength(1)

      // Readonly does not dispose the pane. Its surrounding exit UI can change layout.
      pane.setAttribute('aria-readonly', 'true')
      const resize = f.host.resize.getMockImplementation()!
      f.host.resize.mockImplementationOnce(async (...args) => {
        await acknowledged.promise
        return resize(...args)
      })
      updating = f.owner.update(id, {
        width: 64,
        height: 48,
        backingScale: 1,
        visible: true,
      })
      expect(pane.isConnected).toBe(true)
      expect(surface.isConnected).toBe(true)
      expect(pane.getAttribute('aria-readonly')).toBe('true')
      expect(surface.querySelectorAll('canvas')).toHaveLength(0)
      expect(receiver.pixels(oldPixels)).toBe(false)
      expect(await f.owner.demand(id)).toBe(false)
      expect(createCanvas).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(f.host.resize).toHaveBeenCalledTimes(2))
      expect(f.status().geometry.serial).toBe(first!.geometrySerial)

      acknowledged.resolve()
      const current = await updating
      expect(current).toMatchObject({
        geometrySerial: first!.geometrySerial + 1,
        width: 64,
        height: 48,
      })
      // A new grant is not a canvas or draw acknowledgement.
      expect(surface.querySelectorAll('canvas')).toHaveLength(0)
      expect(receiver.pixels(oldPixels)).toBe(false)
      expect(createCanvas).toHaveBeenCalledTimes(1)
      clock.mockReturnValue(NATIVE_TERMINAL_PRESENTATION.compatibilityIntervalMs + 1)
      expect(await f.owner.demand(id)).toBe(true)
      const canvas = surface.querySelector('canvas')!
      expect(canvas.isConnected).toBe(true)
      expect([canvas.width, canvas.height]).toEqual([current!.width, current!.height])
      expect(createCanvas).toHaveBeenCalledTimes(2)
      expect(f.target.publishStatus).toHaveBeenLastCalledWith({
        viewId: id,
        mode: 'native-pixels',
        reason: 'import-unavailable',
      })
      expect(f.imports.acquire).not.toHaveBeenCalled()
    } finally {
      acknowledged.resolve()
      await updating?.catch(() => undefined)
      if (attachedId) await f.owner.detach(attachedId)
      receiver.dispose()
      pane.remove()
    }
  })
})
