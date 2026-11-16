import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateInstalledRendererWithPixelSnapshot } from '../scripts/installed-renderer-probe.mts'

function rendererTransport(fault?: 'oversized' | 'unavailable' | 'decode') {
  const commands: { method: string; params: Record<string, unknown> }[] = []
  const closed = vi.fn()
  class Socket extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(value: string) {
      const request = JSON.parse(value) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      commands.push(request)
      const expression = request.params.expression
      const result =
        request.method === 'Page.captureScreenshot'
          ? { data: fault === 'oversized' ? 'A'.repeat(16385) : 'iVBORw0KGgo=' }
          : expression === 'prepare'
            ? {
                result: {
                  value: JSON.stringify({
                    evidence: '{"passed":true}',
                    point: { x: 200, y: 160 },
                  }),
                },
              }
            : expression === 'visible'
              ? fault === 'unavailable'
                ? { exceptionDetails: { text: 'presentation unavailable' } }
                : { result: { value: 'visible' } }
              : expression === 'close'
                ? { result: { value: 'closed' } }
                : fault === 'decode'
                  ? { exceptionDetails: { text: 'image decoding failed' } }
                  : { result: { value: '{"matched":true}' } }
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ id: request.id, result }),
          }),
        ),
      )
    }
    close() {
      closed()
    }
  }
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/renderer' },
          ]),
      }),
  )
  return { commands, closed }
}
const exercise = () =>
  evaluateInstalledRendererWithPixelSnapshot(
    () => Promise.resolve('9222\n'),
    'prepare',
    'close',
    [83, 83, 83],
    'visible',
  )

afterEach(() => vi.unstubAllGlobals())

describe('installed compositor pixel snapshot lifetime', () => {
  it('samples the compositor, decodes its bounded PNG through Chromium, and closes ordinary UI', async () => {
    const f = rendererTransport()
    await expect(exercise()).resolves.toEqual({ evidence: '{"passed":true}' })
    expect(
      f.commands.find((command) => command.method === 'Page.captureScreenshot')?.params,
    ).toEqual({
      format: 'png',
      clip: { x: 200, y: 160, width: 1, height: 1, scale: 1 },
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const decoder = f.commands.find((command) =>
      String(command.params.expression).includes('new Image()'),
    )
    expect(decoder?.params.expression).toContain('await image.decode()')
    expect(decoder?.params.expression).toContain('image.naturalWidth > 8')
    expect(decoder?.params.expression).not.toContain('readPixels')
    expect(f.commands.at(-1)?.params.expression).toBe('close')
    expect(f.closed).toHaveBeenCalledOnce()
  })
  it.each(['oversized', 'decode', 'unavailable'] as const)(
    'closes UI and CDP after %s snapshot refusal',
    async (fault) => {
      const f = rendererTransport(fault)
      await expect(exercise()).rejects.toThrow()
      expect(f.commands.at(-1)?.params.expression).toBe('close')
      expect(f.closed).toHaveBeenCalledOnce()
      if (fault === 'unavailable')
        expect(
          f.commands.some((command) => command.method === 'Page.captureScreenshot'),
        ).toBe(false)
    },
  )
})
