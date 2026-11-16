// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const NAME = 'hvir.native.presentation.failure-stage'
beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('__HVIR_SMOKE_BUILD__', true)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('private native presentation failure evidence', () => {
  it('captures canvas factory facts before program/texture failure cleanup changes the DOM', async () => {
    const { createNativeTerminalCanvas } =
      await import('../src/preload/native-terminal-canvas')
    document.body.innerHTML = '<div id="native-evidence"></div>'
    const mark = vi.fn(),
      texture = {},
      lost = vi.fn()
    vi.stubGlobal('performance', { mark, clearMarks: vi.fn() })
    const gl = {
      createProgram: () => null,
      createTexture: () => texture,
      isContextLost: () => false,
      deleteTexture: vi.fn(() => document.getElementById('native-evidence')?.remove()),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      gl as unknown as WebGL2RenderingContext,
    )
    expect(createNativeTerminalCanvas('native-evidence', lost)).toBeUndefined()
    expect(mark).toHaveBeenCalledExactlyOnceWith(NAME, {
      detail: {
        stage: 'canvas-program-unavailable',
        flags: {
          parentPresent: true,
          parentConnected: true,
          canvasConnected: false,
          contextLost: false,
        },
      },
    })
    expect(gl.deleteTexture).toHaveBeenCalledExactlyOnceWith(texture)
    expect(document.getElementById('native-evidence')).toBeNull()
    expect(lost).not.toHaveBeenCalled()
  })
  it('emits only fixed stage/boolean facts with a renderer-module bound and no retained Timeline entries', async () => {
    const { nativePresentationFailure } =
      await import('../src/preload/native-terminal-presentation-smoke')
    const mark = vi.fn(),
      clearMarks = vi.fn()
    vi.stubGlobal('performance', { mark, clearMarks })
    for (let index = 0; index < 40; index++)
      nativePresentationFailure('receiver-draw', {
        parentPresent: true,
        parentConnected: false,
        contextLost: true,
        arbitrary: 'terminal-content-must-never-escape',
      } as Parameters<typeof nativePresentationFailure>[1])
    expect(mark).toHaveBeenCalledTimes(32)
    expect(clearMarks).toHaveBeenCalledTimes(32)
    expect(mark).toHaveBeenNthCalledWith(1, NAME, {
      detail: {
        stage: 'receiver-draw',
        flags: { parentPresent: true, parentConnected: false, contextLost: true },
      },
    })
    expect(clearMarks.mock.calls.every(([name]) => name === NAME)).toBe(true)
  })
  it('does not emit diagnostic marks in an ordinary build', async () => {
    const { nativePresentationFailure } =
      await import('../src/preload/native-terminal-presentation-smoke')
    const mark = vi.fn()
    vi.stubGlobal('performance', { mark })
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', false)
    nativePresentationFailure('canvas-context-lost', { contextLost: true })
    expect(mark).not.toHaveBeenCalled()
  })
  it.each(['mark', 'clearMarks'] as const)(
    'never replaces product failure when Timeline %s fails',
    async (method) => {
      const { nativePresentationFailure } =
        await import('../src/preload/native-terminal-presentation-smoke')
      vi.stubGlobal('performance', {
        mark: vi.fn(() => {
          if (method === 'mark') throw new Error('diagnostic-failed')
        }),
        clearMarks: vi.fn(() => {
          if (method === 'clearMarks') throw new Error('diagnostic-failed')
        }),
      })
      expect(() =>
        nativePresentationFailure('canvas-draw-upload', { canvasConnected: true }),
      ).not.toThrow()
    },
  )
  it.each(['get-video-frame', 'draw'] as const)(
    'captures connected DOM before receiver %s cleanup and preserves exact resource cleanup',
    async (stage) => {
      const { NativeTerminalPresentationReceiver } =
        await import('../src/preload/native-terminal-presentation')
      document.body.innerHTML = '<div id="native-evidence"><canvas></canvas></div>'
      const mark = vi.fn(),
        reportFailure = vi.fn()
      vi.stubGlobal('performance', {
        mark,
        clearMarks: vi.fn(),
        now: () => 0,
        measure: vi.fn(),
        clearMeasures: vi.fn(),
      })
      const canvas = {
        draw: vi.fn(() => {
          if (stage === 'draw') throw new Error('private-upload-error')
        }),
        pixels: vi.fn(),
        dispose: vi.fn(() => document.getElementById('native-evidence')?.remove()),
      }
      const receiver = new NativeTerminalPresentationReceiver(() => canvas, reportFailure)
      const grant = {
        viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        attachment: 1,
        geometrySerial: 1,
        width: 64,
        height: 32,
        backingScale: 1,
      }
      receiver.mount(grant.viewId, 'native-evidence')
      receiver.grant({ viewId: grant.viewId, grant })
      const frame = { close: vi.fn() }
      const texture = {
        getVideoFrame: vi.fn(() => {
          if (stage === 'get-video-frame') throw new Error('private-frame-error')
          return frame
        }),
        release: vi.fn(),
      }
      receiver.receive(texture, {
        nativeTerminal: grant,
        screen: 0,
        origin: 1,
        colorSpace: 1,
      })
      expect(mark).toHaveBeenCalledExactlyOnceWith(NAME, {
        detail: {
          stage: stage === 'draw' ? 'receiver-draw' : 'receiver-get-video-frame',
          flags: {
            parentPresent: true,
            parentConnected: true,
            canvasConnected: true,
            mounted: true,
            bindingCurrent: true,
            grantPresent: true,
          },
        },
      })
      expect(document.getElementById('native-evidence')).toBeNull()
      expect(canvas.dispose).toHaveBeenCalledOnce()
      expect(texture.release).toHaveBeenCalledOnce()
      expect(frame.close).toHaveBeenCalledTimes(stage === 'draw' ? 1 : 0)
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(grant)
    },
  )
})
