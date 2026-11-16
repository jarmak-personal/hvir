import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { createNativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WebFrameMain } from 'electron'
import { installTerminalApplication } from '../src/main/terminal/terminal-application'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  IpcAuthorityRouter,
  type IpcMainRegistrationPort,
} from '../src/main/ipc/authority-router'
import { registerNativeTerminalPresentationIpc } from '../src/main/ipc/features/native-terminal-presentation'
import { NATIVE_TERMINAL_PRESENTATION } from '../src/shared/native-terminal-presentation'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  packaged: false,
  clipboardWrite: vi.fn<(text: string) => void>(),
}))
vi.mock('electron', () => ({
  ipcMain: {},
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
  it('routes pixel and drawn acknowledgements through the production installation and IPC owner', async () => {
    const cleanup: Array<() => void | Promise<void>> = []
    const runtime = {
      own<T>(
        _label: string,
        resource: T,
        dispose: (resource: T) => void | Promise<void>,
      ): T {
        cleanup.push(() => dispose(resource))
        return resource
      },
    }
    const scopes = new RendererResourceScopes()
    scopes.activateOwner(7)
    const terminals = await installTerminalApplication(
      runtime,
      { recordPty: () => undefined },
      {
        recordIdentity: () => Promise.resolve(true),
        cancelIdentityRegistration: () => undefined,
      },
      scopes,
    )
    type Listener = (event: Electron.IpcMainEvent, payload: unknown) => void
    const listeners = new Map<string, Listener>()
    const transport: IpcMainRegistrationPort = {
      handle: () => {
        throw new Error('Unexpected invoke registration')
      },
      removeHandler: () => undefined,
      on: (channel, listener) => {
        listeners.set(channel, listener)
      },
      removeListener: (channel) => {
        listeners.delete(channel)
      },
    }
    const router = new IpcAuthorityRouter(
      {
        rendererResources: scopes,
        recordIpcContractDiagnostic: () => undefined,
        getProject: () => {
          throw new Error('Presentation has no project authority')
        },
        getProjectState: () => {
          throw new Error('Presentation has no project state')
        },
        getRegisteredWorkspaceRoot: () => {
          throw new Error('Presentation cannot register paths')
        },
      },
      transport,
    )
    cleanup.push(() => router.dispose())
    try {
      registerNativeTerminalPresentationIpc(router, terminals.nativeTerminalPresentation)
      let ticket: string | undefined
      const frame = {
        isDestroyed: () => false,
        send: (channel: string, value: { ticket?: string }) => {
          if (channel === NATIVE_TERMINAL_PRESENTATION.pixelsChannel)
            ticket = value.ticket
        },
      } as unknown as WebFrameMain
      const event = {
        senderFrame: frame,
        sender: { id: 7, mainFrame: frame },
      } as Electron.IpcMainEvent
      const native = terminals.nativeTerminals!
      const target = native.targets.create(
        frame,
        () => true,
        () => true,
      )
      const grant = {
        viewId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        nativeEpoch: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        attachment: 1,
        geometrySerial: 1,
        width: 64,
        height: 32,
        backingScale: 1,
      }
      target.publishGrant(grant)
      const uploaded = target
        .sendPixels({
          nativeTerminal: grant,
          screen: 0,
          colorSpace: 1,
          origin: 1,
          premultiplied: false,
          stride: 256,
          bytes: new Uint8Array(8192),
        })
        .then(
          () => true,
          () => false,
        )
      expect(ticket).toBeTypeOf('string')
      const acknowledge = listeners.get(
        NATIVE_TERMINAL_PRESENTATION.acknowledgementChannel,
      )!
      acknowledge(event, { kind: 'drawn', grant, screen: 0 })
      expect(native.targets.drawn(grant.viewId, frame)).toEqual({
        screen: 0,
        geometrySerial: 1,
      })
      acknowledge(event, { kind: 'pixels', ticket, accepted: true })
      await expect(uploaded).resolves.toBe(true)
    } finally {
      for (const dispose of cleanup.reverse()) await dispose()
      await scopes.dispose()
    }
  })
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
