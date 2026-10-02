import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeExtensionGuestVisibility } from '../src/preload/extension-guest-visibility'

function fixture() {
  let native = 'hidden'
  let listener: (event: { isTrusted: boolean }) => void = () => undefined
  class NativeDocument {
    get visibilityState(): string {
      return native
    }
  }
  const document = {
    visibilityState: 'visible', // Electron's own-property compatibility mask.
    addEventListener: vi.fn(
      (
        _name: string,
        callback: (event: { isTrusted: boolean }) => void,
        _capture: boolean,
      ) => {
        listener = callback
      },
    ),
  }
  vi.stubGlobal('Document', NativeDocument)
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', document)
  const publish = vi.fn()
  observeExtensionGuestVisibility(publish)
  return {
    publish,
    document,
    prototype: NativeDocument.prototype,
    event: (trusted: boolean, state: string) => {
      native = state
      listener({ isTrusted: trusted })
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('isolated extension native visibility observation', () => {
  it('ignores untrusted notifications and native hidden despite the public visible mask', async () => {
    const data = fixture()
    expect(data.document.addEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
      true,
    )
    data.event(false, 'visible')
    data.event(true, 'hidden')
    await Promise.resolve()
    expect(data.publish).not.toHaveBeenCalled()
  })
  it('captures the native getter and sends immediately before package propagation or long tasks', () => {
    const data = fixture()
    Object.defineProperty(data.prototype, 'visibilityState', { get: () => 'hidden' })
    data.event(true, 'visible')
    expect(data.publish.mock.calls).toEqual([[]])
    data.event(true, 'visible')
    expect(data.publish).toHaveBeenCalledTimes(2)
  })
  it('refuses to install without the engine visibility getter', () => {
    vi.stubGlobal('Document', class {})
    expect(() => observeExtensionGuestVisibility(vi.fn())).toThrow(
      'Extension native visibility is unavailable',
    )
  })
})
