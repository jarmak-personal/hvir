import type {
  NativeTerminalPixelFrame,
  NativeTerminalPresentedFrame,
} from '../shared/native-terminal-presentation'
import type { NativeTerminalCanvasPort } from './native-terminal-presentation'

/** GPU upload/composition only. Pixel inspection belongs to qualification code. */
export function createNativeTerminalCanvas(
  elementId: string,
  lost: () => void,
): NativeTerminalCanvasPort | undefined {
  const parent = document.getElementById(elementId)
  if (!parent?.isConnected) return
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none'
  canvas.setAttribute('aria-hidden', 'true')
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (!gl) {
    // The software compositor reliably consumes an sRGB canvas. ImageData keeps
    // the actual source tag so Canvas2D converts P3 values instead of relabelling.
    const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })
    if (!context) return
    parent.appendChild(canvas)
    let closed = false
    return {
      draw(): void {
        throw new Error('native-gpu-canvas-unavailable')
      },
      pixels(frame): void {
        if (closed || !canvas.isConnected) throw new Error('native-pixel-canvas-lost')
        canvas.width = frame.nativeTerminal.width
        canvas.height = frame.nativeTerminal.height
        if (
          typeof SharedArrayBuffer !== 'undefined' &&
          frame.bytes.buffer instanceof SharedArrayBuffer
        )
          throw new Error('native-pixel-buffer')
        const bytes = new Uint8ClampedArray(
          frame.bytes.buffer as ArrayBuffer,
          frame.bytes.byteOffset,
          frame.bytes.byteLength,
        )
        context.putImageData(
          new ImageData(bytes, canvas.width, canvas.height, {
            colorSpace: frame.colorSpace === 2 ? 'display-p3' : 'srgb',
          }),
          0,
          0,
        )
      },
      dispose(): void {
        closed = true
        canvas.remove()
      },
    }
  }
  let disposed = false
  const shaders: WebGLShader[] = []
  const program = gl.createProgram()
  const texture = gl.createTexture()
  if (!program || !texture) {
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
      if (!shader) throw new Error('native-canvas-shader')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error('native-canvas-shader')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error('native-canvas-program')
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
    dispose()
    return
  }
  const configure = (metadata: NativeTerminalPresentedFrame): void => {
    if (disposed || !canvas.isConnected || gl.isContextLost())
      throw new Error('native-canvas-lost')
    const { width, height } = metadata.nativeTerminal
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    gl.drawingBufferColorSpace = metadata.colorSpace === 2 ? 'display-p3' : 'srgb'
    gl.viewport(0, 0, width, height)
    gl.useProgram(program)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.uniform1i(
      gl.getUniformLocation(program, 'topOrigin'),
      metadata.origin === 1 ? 1 : 0,
    )
    gl.disable(gl.BLEND)
  }
  const submit = (straightAlpha: boolean): void => {
    gl.uniform1i(gl.getUniformLocation(program, 'straightAlpha'), straightAlpha ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (gl.getError() !== gl.NO_ERROR) throw new Error('native-canvas-upload')
    // Submit; Chromium's VideoFrame release sync token owns actual GPU completion.
    gl.flush()
  }
  return {
    draw(frame: unknown, metadata: NativeTerminalPresentedFrame): void {
      configure(metadata)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        frame as TexImageSource,
      )
      submit(false)
    },
    pixels(frame: NativeTerminalPixelFrame): void {
      configure(frame)
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
      submit(true)
    },
    dispose,
  }
}
