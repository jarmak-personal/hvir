// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNativeTerminalCanvas } from '../src/preload/native-terminal-canvas'
import type {
  NativeTerminalPixelFrame,
  NativeTerminalPresentedFrame,
} from '../src/shared/native-terminal-presentation'

const metadata: NativeTerminalPresentedFrame = {
  nativeTerminal: {
    viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    attachment: 1,
    geometrySerial: 1,
    width: 64,
    height: 32,
    backingScale: 1,
  },
  screen: 0,
  colorSpace: 1,
  origin: 1,
}

/** API ownership fixture; actual GPU/color/context-loss proof remains in Electron. */
function fixture(maximumTextureSize = 16384) {
  document.body.innerHTML = '<div id="native-canvas"></div>'
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    TEXTURE_2D: 5,
    TEXTURE_MIN_FILTER: 6,
    TEXTURE_MAG_FILTER: 7,
    TEXTURE_WRAP_S: 8,
    TEXTURE_WRAP_T: 9,
    NEAREST: 10,
    CLAMP_TO_EDGE: 11,
    UNPACK_ALIGNMENT: 12,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 13,
    NONE: 14,
    BLEND: 15,
    TRIANGLES: 16,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    MAX_TEXTURE_SIZE: 20,
    createProgram: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({})),
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    getParameter: vi.fn(() => maximumTextureSize),
    useProgram: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    isContextLost: vi.fn(() => false),
    viewport: vi.fn(),
    uniform1i: vi.fn(),
    disable: vi.fn(),
    texImage2D: vi.fn(),
    drawArrays: vi.fn(),
    flush: vi.fn(),
    deleteTexture: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    getError: vi.fn(() => {
      throw new Error('synchronous GPU status query')
    }),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    gl as unknown as WebGL2RenderingContext,
  )
  const lost = vi.fn()
  const port = createNativeTerminalCanvas('native-canvas', lost)
  if (!port) throw new Error('Canvas initialization refused')
  const canvas = document.querySelector('canvas')!
  return { gl, port, canvas, lost }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('native canvas submission ownership', () => {
  it('updates software pixels without resetting unchanged backing dimensions', () => {
    document.body.innerHTML = '<div id="native-canvas"></div>'
    let currentImage: ImageData | undefined
    const context = {
      putImageData: vi.fn((image: ImageData) => {
        currentImage = image
      }),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((kind) =>
      kind === '2d' ? (context as unknown as CanvasRenderingContext2D) : null,
    )
    vi.stubGlobal(
      'ImageData',
      class {
        readonly colorSpace: PredefinedColorSpace
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
          settings: ImageDataSettings,
        ) {
          this.colorSpace = settings.colorSpace ?? 'srgb'
        }
      },
    )
    const port = createNativeTerminalCanvas('native-canvas', vi.fn())
    if (!port) throw new Error('Software canvas unavailable')
    const canvas = document.querySelector('canvas')!
    const width = vi.spyOn(canvas, 'width', 'set'),
      height = vi.spyOn(canvas, 'height', 'set')
    const frames = [
      [64, 32, 1, 17],
      [64, 32, 2, 39],
      [128, 32, 1, 61],
      [128, 64, 2, 83],
    ].map(([w, h, colorSpace, color]) => {
      const storage = new Uint8Array(w! * h! * 4 + 8)
      const bytes = storage.subarray(4, storage.length - 4)
      bytes.fill(color!)
      return {
        frame: {
          ...metadata,
          colorSpace: colorSpace!,
          nativeTerminal: { ...metadata.nativeTerminal, width: w!, height: h! },
          bytes,
          stride: w! * 4,
          premultiplied: false,
        } satisfies NativeTerminalPixelFrame,
        storage,
        original: storage.slice(),
      }
    })
    for (const [index, { frame, storage, original }] of frames.entries()) {
      port.pixels(frame)
      expect([canvas.width, canvas.height]).toEqual([
        frame.nativeTerminal.width,
        frame.nativeTerminal.height,
      ])
      expect(currentImage).toMatchObject({
        width: canvas.width,
        height: canvas.height,
        colorSpace: frame.colorSpace === 2 ? 'display-p3' : 'srgb',
      })
      expect(currentImage?.data).toEqual(new Uint8ClampedArray(frame.bytes))
      expect(currentImage?.data.buffer).toBe(frame.bytes.buffer)
      expect(currentImage?.data.byteOffset).toBe(frame.bytes.byteOffset)
      expect(storage).toEqual(original)
      expect(width).toHaveBeenCalledTimes(index < 2 ? 1 : 2)
      expect(height).toHaveBeenCalledTimes(index < 3 ? 1 : 2)
      expect(context.putImageData).toHaveBeenLastCalledWith(currentImage, 0, 0)
    }
    const failed = new Error('software upload failure')
    context.putImageData.mockImplementationOnce(() => {
      throw failed
    })
    expect(() => port.pixels(frames[3]!.frame)).toThrow(failed)
    expect(width).toHaveBeenCalledTimes(2)
    expect(height).toHaveBeenCalledTimes(2)
    port.dispose()
    expect(canvas.isConnected).toBe(false)
    expect(() => port.pixels(frames[3]!.frame)).toThrow('native-pixel-canvas-lost')
    expect(context.putImageData).toHaveBeenCalledTimes(5)
  })

  it('submits GPU and pixel frames without querying GPU status or program locations', () => {
    const { gl, port } = fixture()
    expect(gl.getUniformLocation.mock.calls.map(([, name]) => name)).toEqual([
      'topOrigin',
      'straightAlpha',
    ])
    gl.getUniformLocation.mockImplementation(() => {
      throw new Error('program query during draw')
    })
    gl.getParameter.mockImplementation(() => {
      throw new Error('device query during draw')
    })
    port.draw({}, metadata)
    port.pixels({
      ...metadata,
      bytes: new Uint8Array(64 * 32 * 4),
      stride: 64 * 4,
      premultiplied: false,
    })
    expect(gl.drawArrays).toHaveBeenCalledTimes(2)
    expect(gl.flush).toHaveBeenCalledTimes(2)
    expect(gl.getError).not.toHaveBeenCalled()
    expect(gl.getUniformLocation).toHaveBeenCalledTimes(2)
    expect(gl.getParameter).toHaveBeenCalledExactlyOnceWith(gl.MAX_TEXTURE_SIZE)
    expect(gl.uniform1i.mock.calls).toEqual([
      [{ name: 'topOrigin' }, 1],
      [{ name: 'straightAlpha' }, 0],
      [{ name: 'topOrigin' }, 1],
      [{ name: 'straightAlpha' }, 1],
    ])
    port.dispose()
  })

  it('retains only the WebGL context while hiding stale pixels until a refitted frame submits', () => {
    const { gl, port, canvas } = fixture()
    port.draw({}, metadata)
    const programCalls = gl.createProgram.mock.calls.length
    port.suspendForRefit!()
    expect(canvas.style.visibility).toBe('hidden')
    expect(canvas.isConnected).toBe(true)
    expect(gl.deleteTexture).not.toHaveBeenCalled()
    const next = {
      ...metadata,
      colorSpace: 2,
      nativeTerminal: {
        ...metadata.nativeTerminal,
        geometrySerial: 2,
        width: 128,
        height: 64,
        backingScale: 2,
      },
    }
    port.draw({}, next)
    expect(canvas.style.visibility).toBe('')
    expect([canvas.width, canvas.height]).toEqual([128, 64])
    expect(gl.viewport).toHaveBeenLastCalledWith(0, 0, 128, 64)
    expect(
      (gl as typeof gl & { drawingBufferColorSpace?: string }).drawingBufferColorSpace,
    ).toBe('display-p3')
    expect(gl.createProgram).toHaveBeenCalledTimes(programCalls)
    expect(gl.createTexture).toHaveBeenCalledOnce()
    port.suspendForRefit!()
    gl.texImage2D.mockImplementationOnce(() => {
      throw new Error('upload failed')
    })
    expect(() => port.draw({}, next)).toThrow('upload failed')
    expect(canvas.style.visibility).toBe('hidden')
    port.dispose()
    expect(() => port.suspendForRefit!()).toThrow('native-canvas-lost')
  })

  it('refuses unsupported device extents before resizing or uploading either frame mode', () => {
    const { gl, port, canvas } = fixture(4096)
    const originalSize = [canvas.width, canvas.height]
    expect(() =>
      port.draw(
        {},
        {
          ...metadata,
          nativeTerminal: { ...metadata.nativeTerminal, width: 4097 },
        },
      ),
    ).toThrow('native-canvas-texture-bound')
    expect(() =>
      port.pixels({
        ...metadata,
        nativeTerminal: { ...metadata.nativeTerminal, height: 4097 },
        bytes: new Uint8Array(64 * 4097 * 4),
        stride: 64 * 4,
        premultiplied: false,
      }),
    ).toThrow('native-canvas-texture-bound')
    expect([canvas.width, canvas.height]).toEqual(originalSize)
    expect(gl.texImage2D).not.toHaveBeenCalled()
    expect(gl.drawArrays).not.toHaveBeenCalled()
    expect(gl.flush).not.toHaveBeenCalled()
    expect(gl.getParameter).toHaveBeenCalledExactlyOnceWith(gl.MAX_TEXTURE_SIZE)
    port.dispose()
  })

  it('preserves upload exceptions and refuses a lost context before submission', () => {
    vi.stubGlobal('__HVIR_SMOKE_BUILD__', true)
    vi.spyOn(performance, 'measure').mockImplementation(() => {
      throw new Error('measurement unavailable')
    })
    vi.spyOn(performance, 'clearMeasures').mockImplementation(() => {
      throw new Error('measurement cleanup unavailable')
    })
    const { gl, port } = fixture()
    const error = new Error('VideoFrame upload failed')
    gl.texImage2D.mockImplementationOnce(() => {
      throw error
    })
    expect(() => port.draw({}, metadata)).toThrow(error)
    expect(gl.flush).not.toHaveBeenCalled()
    gl.isContextLost.mockReturnValue(true)
    expect(() => port.draw({}, metadata)).toThrow('native-canvas-lost')
    expect(gl.texImage2D).toHaveBeenCalledTimes(1)
    port.dispose()
  })

  it('reports actual canvas context loss and disposes resources once', () => {
    const { gl, port, canvas, lost } = fixture()
    const event = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(lost).toHaveBeenCalledOnce()
    expect(canvas.isConnected).toBe(false)
    port.dispose()
    canvas.dispatchEvent(new Event('webglcontextlost'))
    expect(lost).toHaveBeenCalledOnce()
    expect(gl.deleteTexture).toHaveBeenCalledOnce()
    expect(gl.deleteProgram).toHaveBeenCalledOnce()
    expect(gl.deleteShader).toHaveBeenCalledTimes(2)
    expect(() => port.draw({}, metadata)).toThrow('native-canvas-lost')
  })
})
