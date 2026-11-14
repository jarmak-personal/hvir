import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { createNativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  packaged: false,
  clipboardWrite: vi.fn<(text: string) => void>(),
}))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged
    },
  },
  sharedTexture: {},
  clipboard: { writeText: mocks.clipboardWrite },
}))
vi.mock('../src/main/terminal/native-terminal-process', () => ({
  NativeTerminalProcess: class {
    epoch = 'native-epoch'
    available = true
    constructor(...args: unknown[]) {
      mocks.start(...args)
    }
    request = vi.fn()
    dispose = mocks.dispose
  },
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.clearAllMocks()
  mocks.packaged = false
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.stubEnv('HVIR_NATIVE_TERMINAL_LIBRARY', '/trusted/libghostty')
  vi.stubEnv('HVIR_NATIVE_TERMINAL_DEVICE', 'default')
  vi.stubEnv('HVIR_NATIVE_TERMINAL_PRESENTATION', 'auto')
})
afterEach(() => {
  expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})
function ptys() {
  return { observe: () => () => undefined, list: () => [] } as unknown as PtySupervisor
}

describe('trusted native Linux application startup', () => {
  it('selects the local device and initial pixels before constructing a lazy native process', async () => {
    vi.stubEnv('HVIR_NATIVE_TERMINAL_DEVICE', '/dev/dri/renderD128')
    vi.stubEnv('HVIR_NATIVE_TERMINAL_PRESENTATION', 'pixels')
    const owner = await createNativeTerminalApplication(ptys(), () => true)
    expect(owner).toBeDefined()
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
      '/trusted/libghostty',
      undefined,
      undefined,
      {
        device: { kind: 'drm-render-node', node: localPath('/dev/dri/renderD128') },
        presentationMode: 'pixels',
      },
    )
    owner!.dispose()
    expect(mocks.dispose).toHaveBeenCalledOnce()
  })
  it('rejects an explicit unsupported selection before creating native state', async () => {
    vi.stubEnv('HVIR_NATIVE_TERMINAL_DEVICE', '/other/device')
    await expect(createNativeTerminalApplication(ptys(), () => true)).rejects.toThrow(
      'native-linux-device-invalid',
    )
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it('retains default and packaged startup without opening the native path', async () => {
    vi.stubEnv('HVIR_NATIVE_TERMINAL_LIBRARY', '')
    await expect(
      createNativeTerminalApplication(ptys(), () => true),
    ).resolves.toBeUndefined()
    vi.stubEnv('HVIR_NATIVE_TERMINAL_LIBRARY', '/trusted/libghostty')
    mocks.packaged = true
    await expect(
      createNativeTerminalApplication(ptys(), () => true),
    ).resolves.toBeUndefined()
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
