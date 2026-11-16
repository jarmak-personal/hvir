import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { createNativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
let packagedResources: string | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mocks.packaged = false
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.stubEnv('HVIR_NATIVE_TERMINAL_LIBRARY', '/trusted/libghostty')
  vi.stubEnv('HVIR_NATIVE_TERMINAL', '')
  vi.stubEnv('HVIR_NATIVE_TERMINAL_DEVICE', 'default')
  vi.stubEnv('HVIR_NATIVE_TERMINAL_PRESENTATION', 'auto')
})
afterEach(async () => {
  expect(mocks.clipboardWrite).not.toHaveBeenCalled()
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  if (originalResources)
    Object.defineProperty(process, 'resourcesPath', originalResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
  if (packagedResources) await rm(packagedResources, { recursive: true, force: true })
  packagedResources = undefined
})
function ptys() {
  return { observe: () => () => undefined, list: () => [] } as unknown as PtySupervisor
}

describe('trusted native Linux application startup', () => {
  it.each(['missing', 'mismatched'])(
    'refuses a %s packaged payload before native construction or a PTY, ignoring the developer override',
    async (kind) => {
      mocks.packaged = true
      vi.stubEnv('HVIR_NATIVE_TERMINAL', '1')
      vi.stubEnv('HVIR_NATIVE_TERMINAL_LIBRARY', '/developer/override-must-not-load')
      packagedResources = await realpath(
        await mkdtemp(join(tmpdir(), 'hvir-native-startup-')),
      )
      Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value: packagedResources,
      })
      if (kind === 'mismatched') {
        await mkdir(join(packagedResources, 'native-terminal'))
        await writeFile(
          join(packagedResources, 'native-terminal/runtime.json'),
          JSON.stringify({ schema: 1, target: 'wrong-target' }),
        )
      }
      const spawn = vi.fn(),
        observe = vi.fn(),
        list = vi.fn()
      const supervisor = { spawn, observe, list } as unknown as PtySupervisor
      await expect(
        createNativeTerminalApplication(supervisor, () => true),
      ).rejects.toThrow(
        kind === 'missing' ? 'native-package-unavailable' : 'native-package-identity',
      )
      expect(mocks.start).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
      expect(observe).not.toHaveBeenCalled()
    },
  )
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
