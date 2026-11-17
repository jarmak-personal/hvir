import type {
  NativeTerminalPixelFrame,
  NativeTerminalPresentedFrame,
} from '../shared/native-terminal-presentation'
import type { NativeTerminalCanvasPort } from './native-terminal-presentation'
import {
  nativePresentationSpanEnd,
  nativePresentationSpanStart,
  nativePresentationFailure,
  type NativePresentationFailureStage,
} from './native-terminal-presentation-smoke'

/** GPU upload/composition only. Pixel inspection belongs to qualification code. */
export function createNativeTerminalCanvas(
  elementId: string,
  lost: () => void,
): NativeTerminalCanvasPort | undefined {
  const parent = document.getElementById(elementId)
  if (!parent?.isConnected) {
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
      nativePresentationFailure(
        parent ? 'canvas-parent-disconnected' : 'canvas-parent-missing',
        {
          parentPresent: !!parent,
          parentConnected: false,
          canvasConnected: false,
        },
      )
    return
  }
  const canvas = document.createElement('canvas')
  // Fractional CSS bounds must not blend away one-pixel native cursor/glyph edges.
  canvas.style.cssText =
    'display:block;width:100%;height:100%;pointer-events:none;image-rendering:pixelated'
  canvas.setAttribute('aria-hidden', 'true')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  const failure = (stage: NativePresentationFailureStage): void => {
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__) {
      try {
        const flags: Parameters<typeof nativePresentationFailure>[1] = {
          parentPresent: true,
          parentConnected: parent.isConnected,
          canvasConnected: canvas.isConnected,
        }
        try {
          if (gl) flags.contextLost = gl.isContextLost()
        } catch {
          /* Optional failure fact. */
        }
        nativePresentationFailure(stage, flags)
      } catch {
        /* Diagnostics cannot alter a canvas failure. */
      }
    }
  }
  if (!gl) {
    // The software compositor reliably consumes an sRGB canvas. ImageData keeps
    // the actual source tag so Canvas2D converts P3 values instead of relabelling.
    const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
    if (!context) {
      failure('canvas-context-unavailable')
      return
    }
    parent.appendChild(canvas)
    let closed = false
    return {
      draw(): void {
        failure('canvas-context-unavailable')
        throw new Error('native-gpu-canvas-unavailable')
      },
      pixels(frame): void {
        if (closed || !canvas.isConnected) {
          failure('canvas-pixel-disconnected')
          throw new Error('native-pixel-canvas-lost')
        }
        if (canvas.width !== frame.nativeTerminal.width)
          canvas.width = frame.nativeTerminal.width
        if (canvas.height !== frame.nativeTerminal.height)
          canvas.height = frame.nativeTerminal.height
        if (
          typeof SharedArrayBuffer !== 'undefined' &&
          frame.bytes.buffer instanceof SharedArrayBuffer
        ) {
          failure('canvas-pixel-buffer')
          throw new Error('native-pixel-buffer')
        }
        const bytes = new Uint8ClampedArray(
          frame.bytes.buffer as ArrayBuffer,
          frame.bytes.byteOffset,
          frame.bytes.byteLength,
        )
        try {
          context.putImageData(
            new ImageData(bytes, canvas.width, canvas.height, {
              colorSpace: frame.colorSpace === 2 ? 'display-p3' : 'srgb',
            }),
            0,
            0,
          )
        } catch (error) {
          failure('canvas-pixel-upload')
          throw error
        }
      },
      dispose(): void {
        closed = true
        canvas.remove()
      },
    }
  }
  let disposed = false
  let topOriginLocation: WebGLUniformLocation | null = null
  let straightAlphaLocation: WebGLUniformLocation | null = null
  let maximumTextureSize = 0
  const shaders: WebGLShader[] = []
  const program = gl.createProgram()
  const texture = gl.createTexture()
  if (!program || !texture) {
    if (!program) failure('canvas-program-unavailable')
    if (!texture) failure('canvas-texture-unavailable')
    if (program) gl.deleteProgram(program)
    if (texture) gl.deleteTexture(texture)
    return
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    canvas.removeEventListener('webglcontextlost', onLost)
    gl.deleteTexture(texture)
    gl.deleteProgram(program)
    for (const shader of shaders) gl.deleteShader(shader)
    canvas.remove()
  }
  const onLost = (event: Event): void => {
    event.preventDefault()
    failure('canvas-context-lost')
    dispose()
    lost()
  }
  try {
    for (const [kind, source] of [
      [
        gl.VERTEX_SHADER,
        `#version 300 es
        out vec2 uv;
        void main() {
          uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
          gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
        }`,
      ],
      [
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision highp float;
        uniform sampler2D image;
        uniform bool topOrigin;
        uniform bool straightAlpha;
        in vec2 uv;
        out vec4 color;
        void main() {
          vec4 pixel = texture(image, vec2(uv.x, topOrigin ? 1.0 - uv.y : uv.y));
          color = straightAlpha ? vec4(pixel.rgb * pixel.a, pixel.a) : pixel;
        }`,
      ],
    ] as const) {
      const shader = gl.createShader(kind)
      if (!shader) {
        failure('canvas-shader-unavailable')
        throw new Error('native-canvas-shader')
      }
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        failure('canvas-shader-compile')
        throw new Error('native-canvas-shader')
      }
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      failure('canvas-program-link')
      throw new Error('native-canvas-program')
    }
    topOriginLocation = gl.getUniformLocation(program, 'topOrigin')
    straightAlphaLocation = gl.getUniformLocation(program, 'straightAlpha')
    if (!topOriginLocation || !straightAlphaLocation) {
      failure('canvas-uniform-unavailable')
      throw new Error('native-canvas-uniform')
    }
    const deviceTextureSize: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    if (
      typeof deviceTextureSize !== 'number' ||
      !Number.isSafeInteger(deviceTextureSize) ||
      deviceTextureSize <= 0
    ) {
      failure('canvas-texture-size-invalid')
      throw new Error('native-canvas-texture-bound')
    }
    maximumTextureSize = deviceTextureSize
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // Preserve native numeric P3/sRGB values. Keep the sRGB unpack selector for
    // Chromium's VideoFrame GPU-copy path; NONE suppresses source conversion.
    gl.unpackColorSpace = 'srgb'
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    canvas.addEventListener('webglcontextlost', onLost)
    parent.appendChild(canvas)
  } catch {
    failure('canvas-initialize')
    dispose()
    return
  }
  const configure = (metadata: NativeTerminalPresentedFrame): void => {
    if (disposed) {
      failure('canvas-draw-disposed')
      throw new Error('native-canvas-lost')
    }
    if (!canvas.isConnected) {
      failure('canvas-draw-disconnected')
      throw new Error('native-canvas-lost')
    }
    if (gl.isContextLost()) {
      failure('canvas-draw-context-lost')
      throw new Error('native-canvas-lost')
    }
    const { width, height } = metadata.nativeTerminal
    if (width > maximumTextureSize || height > maximumTextureSize) {
      failure('canvas-draw-size-bound')
      throw new Error('native-canvas-texture-bound')
    }
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    gl.drawingBufferColorSpace = metadata.colorSpace === 2 ? 'display-p3' : 'srgb'
    gl.viewport(0, 0, width, height)
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(topOriginLocation, metadata.origin === 1 ? 1 : 0)
    gl.disable(gl.BLEND)
  }
  const submit = (straightAlpha: boolean): void => {
    let started: number | undefined
    if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
      started = nativePresentationSpanStart()
    try {
      gl.uniform1i(straightAlphaLocation, straightAlpha ? 1 : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      // Synchronous GPU status queries can wait for compositor work on this thread.
      // Submit; Chromium's VideoFrame release sync token owns actual GPU completion.
      gl.flush()
      if (!disposed && canvas.isConnected && canvas.style.visibility === 'hidden')
        canvas.style.visibility = ''
    } finally {
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        nativePresentationSpanEnd('canvas-submit', started)
    }
  }
  return {
    suspendForRefit(): void {
      if (disposed || !canvas.isConnected) {
        failure(disposed ? 'canvas-refit-disposed' : 'canvas-refit-disconnected')
        throw new Error('native-canvas-lost')
      }
      canvas.style.visibility = 'hidden'
    },
    draw(frame: unknown, metadata: NativeTerminalPresentedFrame): void {
      let started: number | undefined
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        started = nativePresentationSpanStart()
      try {
        try {
          configure(metadata)
        } catch (error) {
          failure('canvas-draw-configure')
          throw error
        }
        try {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            frame as TexImageSource,
          )
        } catch (error) {
          failure('canvas-draw-upload')
          throw error
        }
      } finally {
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationSpanEnd('canvas-upload', started)
      }
      submit(false)
    },
    pixels(frame: NativeTerminalPixelFrame): void {
      let started: number | undefined
      if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
        started = nativePresentationSpanStart()
      try {
        try {
          configure(frame)
        } catch (error) {
          failure('canvas-draw-configure')
          throw error
        }
        try {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            frame.nativeTerminal.width,
            frame.nativeTerminal.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            frame.bytes,
          )
        } catch (error) {
          failure('canvas-pixel-upload')
          throw error
        }
      } finally {
        if (typeof __HVIR_SMOKE_BUILD__ !== 'undefined' && __HVIR_SMOKE_BUILD__)
          nativePresentationSpanEnd('canvas-upload', started)
      }
      submit(true)
    },
    dispose,
  }
}
