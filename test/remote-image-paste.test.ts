import { describe, expect, it, vi } from 'vitest'

import {
  RemoteImagePasteCoordinator,
  RemoteImagePasteStorage,
  REMOTE_IMAGE_PASTE_MAX_BYTES,
  REMOTE_IMAGE_PASTE_MAX_CONCURRENT,
  REMOTE_IMAGE_PASTE_MAX_DIMENSION,
  REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS,
  REMOTE_IMAGE_PASTE_MAX_PIXELS,
  REMOTE_IMAGE_PASTE_TRANSFER_TIMEOUT_MS,
  REMOTE_IMAGE_PASTE_TTL_MS,
  type ClipboardPngSource,
  type RemoteImagePasteStoragePort,
} from '../src/main/harness/remote-image-paste'
import { ElectronClipboardPngSource } from '../src/main/harness/electron-clipboard-image'
import type { ProjectHost, PtyExit } from '../src/main/project-host'
import type { ManagedPty } from '../src/main/pty/pty-supervisor'
import type {
  RendererOwner,
  RendererResourceLease,
} from '../src/main/renderer-resource-scopes'
import {
  asHarnessProviderId,
  asHostId,
  hostPath,
  localPath,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'

const OWNER: RendererOwner = { id: 7, generation: 3 }
const REMOTE_ID = asHostId('ssh-test')
const REMOTE_ROOT = hostPath(REMOTE_ID, '/srv/project')
const STAGED_PATH = hostPath(
  REMOTE_ID,
  '/run/user/501/hvir/image-paste/paste.abc123/image.png',
)

describe('RemoteImagePasteCoordinator', () => {
  it('leaves local and unsupported terminals on their native Ctrl+V path', async () => {
    const clipboard = imageClipboard()
    const local = managedTerminal('terminal-local', 'local', localPath('/repo'))
    const unsupported = managedTerminal('terminal-shell', 'plain-shell', REMOTE_ROOT)
    const fixture = coordinatorFixture([local, unsupported], clipboard)

    await expect(fixture.coordinator.paste(local.id, OWNER)).resolves.toEqual({
      outcome: 'forward-key',
    })
    await expect(fixture.coordinator.paste(unsupported.id, OWNER)).resolves.toEqual({
      outcome: 'forward-key',
    })
    expect(clipboard.read.mock.calls).toHaveLength(0)
    expect(fixture.storage.stage).not.toHaveBeenCalled()
    await fixture.coordinator.pasteOrForward(local.id, OWNER, '\x16')
    expect(fixture.write).toHaveBeenCalledWith(
      local.id,
      OWNER.id,
      '\x16',
      OWNER.generation,
    )
    await fixture.coordinator.dispose()
  })

  it('forwards the exact native key when a supported remote has no image', async () => {
    const terminal = managedTerminal('terminal-empty', 'codex', REMOTE_ROOT)
    const clipboard = emptyClipboard()
    const fixture = coordinatorFixture([terminal], clipboard)

    await fixture.coordinator.pasteOrForward(terminal.id, OWNER, '\x1b\x16')

    expect(clipboard.read.mock.calls).toHaveLength(1)
    expect(fixture.storage.stage).not.toHaveBeenCalled()
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith(
      terminal.id,
      OWNER.id,
      '\x1b\x16',
      OWNER.generation,
    )
    await fixture.coordinator.dispose()
  })

  it('stages one bounded image and writes only the provider bracketed path', async () => {
    const terminal = managedTerminal('terminal-codex', 'codex', REMOTE_ROOT)
    const fixture = coordinatorFixture([terminal])

    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'path-inserted',
    })

    expect(fixture.storage.stage).toHaveBeenCalledWith(
      fixture.host,
      new Uint8Array([1, 2, 3]),
      expect.any(AbortSignal),
    )
    expect(fixture.write).toHaveBeenCalledExactlyOnceWith(
      terminal.id,
      OWNER.id,
      '\x1b[200~/run/user/501/hvir/image-paste/paste.abc123/image.png\x1b[201~',
      OWNER.generation,
    )
    expect(fixture.storage.remove).not.toHaveBeenCalled()

    await fixture.disposeRegistered()
    expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
    await fixture.coordinator.dispose()
  })

  it('fails closed and removes late material when the PTY instance changes', async () => {
    const original = managedTerminal('terminal-claude', 'claude-code', REMOTE_ROOT)
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([original], undefined, staged.promise)
    const paste = fixture.coordinator.paste(original.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledOnce())

    fixture.terminals.set(original.id, {
      ...original,
      instanceId: 'replacement-instance',
    })
    staged.resolve(STAGED_PATH)

    await expect(paste).resolves.toEqual({
      outcome: 'failed',
      reason: 'target-changed',
    })
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
    await fixture.coordinator.dispose()
  })

  it('bounds clipboard image bytes before allocating SSH work', async () => {
    const terminal = managedTerminal('terminal-large', 'codex', REMOTE_ROOT)
    const clipboard = imageClipboard({
      width: 10,
      height: 10,
      bytes: new Uint8Array(REMOTE_IMAGE_PASTE_MAX_BYTES + 1),
    })
    const fixture = coordinatorFixture([terminal], clipboard)

    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'failed',
      reason: 'image-too-large',
    })
    expect(fixture.storage.stage).not.toHaveBeenCalled()
    await fixture.coordinator.dispose()
  })

  it('admits at most one in-flight paste for an exact terminal', async () => {
    const terminal = managedTerminal('terminal-busy', 'codex', REMOTE_ROOT)
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([terminal], undefined, staged.promise)
    const first = fixture.coordinator.paste(terminal.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledOnce())

    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'failed',
      reason: 'busy',
    })
    staged.resolve(STAGED_PATH)
    await expect(first).resolves.toEqual({ outcome: 'path-inserted' })
    await fixture.coordinator.dispose()
  })

  it('admits at most two in-flight pastes across the application', async () => {
    const terminals = ['one', 'two', 'three'].map((suffix) =>
      managedTerminal(`terminal-${suffix}`, 'codex', REMOTE_ROOT),
    )
    const firstStage = deferred<HostPath>()
    const secondStage = deferred<HostPath>()
    const fixture = coordinatorFixture(terminals)
    fixture.storage.stage
      .mockReturnValueOnce(firstStage.promise)
      .mockReturnValueOnce(secondStage.promise)

    const first = fixture.coordinator.paste(terminals[0]!.id, OWNER)
    const second = fixture.coordinator.paste(terminals[1]!.id, OWNER)
    await vi.waitFor(() =>
      expect(fixture.storage.stage).toHaveBeenCalledTimes(
        REMOTE_IMAGE_PASTE_MAX_CONCURRENT,
      ),
    )

    await expect(fixture.coordinator.paste(terminals[2]!.id, OWNER)).resolves.toEqual({
      outcome: 'failed',
      reason: 'busy',
    })

    firstStage.resolve(stagedPath('first'))
    secondStage.resolve(stagedPath('second'))
    await expect(first).resolves.toEqual({ outcome: 'path-inserted' })
    await expect(second).resolves.toEqual({ outcome: 'path-inserted' })
    await fixture.coordinator.dispose()
  })

  it('keeps the per-terminal guard when an older retained paste is retired', async () => {
    const terminal = managedTerminal('terminal-overlap', 'codex', REMOTE_ROOT)
    const laterPath = hostPath(
      REMOTE_ID,
      '/run/user/501/hvir/image-paste/paste.def456/image.png',
    )
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([terminal])
    fixture.storage.stage
      .mockResolvedValueOnce(STAGED_PATH)
      .mockReturnValueOnce(staged.promise)

    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'path-inserted',
    })
    const second = fixture.coordinator.paste(terminal.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledTimes(2))

    await fixture.disposeRegistration(0)
    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'failed',
      reason: 'busy',
    })

    staged.resolve(laterPath)
    await expect(second).resolves.toEqual({ outcome: 'path-inserted' })
    await fixture.coordinator.dispose()
  })

  it('bounds retained and in-flight material per SSH host', async () => {
    const terminals = Array.from(
      { length: REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS + 1 },
      (_value, index) => managedTerminal(`terminal-host-${index}`, 'codex', REMOTE_ROOT),
    )
    const fixture = coordinatorFixture(terminals)
    fixture.storage.stage.mockResolvedValue(STAGED_PATH)

    for (const terminal of terminals.slice(0, REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS)) {
      await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
        outcome: 'path-inserted',
      })
    }

    await expect(fixture.coordinator.paste(terminals.at(-1)!.id, OWNER)).resolves.toEqual(
      { outcome: 'failed', reason: 'busy' },
    )
    expect(fixture.storage.stage).toHaveBeenCalledTimes(REMOTE_IMAGE_PASTE_MAX_HOST_ITEMS)
    await fixture.coordinator.dispose()
  })

  it('fails closed when renderer authority changes during transfer', async () => {
    const terminal = managedTerminal('terminal-renderer', 'claude-code', REMOTE_ROOT)
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([terminal], undefined, staged.promise)
    const paste = fixture.coordinator.paste(terminal.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledOnce())

    fixture.assertCurrent.mockImplementation(() => {
      throw new Error('stale renderer')
    })
    staged.resolve(STAGED_PATH)

    await expect(paste).resolves.toEqual({
      outcome: 'failed',
      reason: 'target-changed',
    })
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
    await fixture.coordinator.dispose()
  })

  it('fails closed and removes material when the SSH host disconnects in flight', async () => {
    const terminal = managedTerminal('terminal-disconnect', 'codex', REMOTE_ROOT)
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([terminal], undefined, staged.promise)
    const paste = fixture.coordinator.paste(terminal.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledOnce())

    fixture.emitConnection('disconnected')
    staged.resolve(STAGED_PATH)

    await expect(paste).resolves.toEqual({
      outcome: 'failed',
      reason: 'target-changed',
    })
    expect(fixture.write).not.toHaveBeenCalled()
    expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
    await fixture.coordinator.dispose()
  })

  it('aborts a transfer at its deadline and removes late material', async () => {
    vi.useFakeTimers()
    try {
      const terminal = managedTerminal('terminal-timeout', 'codex', REMOTE_ROOT)
      const retryTerminal = managedTerminal(
        'terminal-after-timeout',
        'codex',
        REMOTE_ROOT,
      )
      const staged = deferred<HostPath>()
      const fixture = coordinatorFixture(
        [terminal, retryTerminal],
        undefined,
        staged.promise,
      )
      const paste = fixture.coordinator.paste(terminal.id, OWNER)
      await Promise.resolve()
      expect(fixture.storage.stage).toHaveBeenCalledOnce()

      await vi.advanceTimersByTimeAsync(REMOTE_IMAGE_PASTE_TRANSFER_TIMEOUT_MS)
      await expect(paste).resolves.toEqual({
        outcome: 'failed',
        reason: 'transfer-failed',
      })

      fixture.storage.stage.mockResolvedValueOnce(stagedPath('after-timeout'))
      await expect(fixture.coordinator.paste(retryTerminal.id, OWNER)).resolves.toEqual({
        outcome: 'path-inserted',
      })

      staged.resolve(STAGED_PATH)
      await Promise.resolve()
      await Promise.resolve()
      expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
      await fixture.coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes retained material when the exact PTY exits', async () => {
    const terminal = managedTerminal('terminal-exit', 'claude-code', REMOTE_ROOT)
    const fixture = coordinatorFixture([terminal])
    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'path-inserted',
    })

    fixture.emitExit(terminal)

    await vi.waitFor(() =>
      expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH),
    )
    await fixture.coordinator.dispose()
  })

  it('retries failed cleanup on reconnect and removes the idle observer', async () => {
    const terminal = managedTerminal('terminal-reconnect', 'codex', REMOTE_ROOT)
    const fixture = coordinatorFixture([terminal])
    fixture.storage.remove
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce(undefined)
    await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
      outcome: 'path-inserted',
    })

    await fixture.disposeRegistration(0)
    expect(fixture.connectionListenerCount()).toBe(1)
    fixture.emitConnection('connected')

    await vi.waitFor(() => expect(fixture.storage.remove).toHaveBeenCalledTimes(2))
    expect(fixture.connectionListenerCount()).toBe(0)
    await fixture.coordinator.dispose()
  })

  it('awaits late staging cleanup during a clean shutdown', async () => {
    const terminal = managedTerminal('terminal-shutdown', 'codex', REMOTE_ROOT)
    const staged = deferred<HostPath>()
    const fixture = coordinatorFixture([terminal], undefined, staged.promise)
    const paste = fixture.coordinator.paste(terminal.id, OWNER)
    await vi.waitFor(() => expect(fixture.storage.stage).toHaveBeenCalledOnce())

    const shutdown = fixture.coordinator.dispose()
    staged.resolve(STAGED_PATH)

    await shutdown
    expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
    await expect(paste).resolves.toEqual({
      outcome: 'failed',
      reason: 'target-changed',
    })
  })

  it('expires retained material after the bounded lease', async () => {
    vi.useFakeTimers()
    try {
      const terminal = managedTerminal('terminal-expiry', 'codex', REMOTE_ROOT)
      const fixture = coordinatorFixture([terminal])
      await expect(fixture.coordinator.paste(terminal.id, OWNER)).resolves.toEqual({
        outcome: 'path-inserted',
      })

      await vi.advanceTimersByTimeAsync(REMOTE_IMAGE_PASTE_TTL_MS)

      expect(fixture.storage.remove).toHaveBeenCalledWith(fixture.host, STAGED_PATH)
      await fixture.coordinator.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ElectronClipboardPngSource', () => {
  it('returns no image for an empty application clipboard', () => {
    const toPNG = vi.fn(() => Buffer.from([1]))
    const image = electronImage({ empty: true, toPNG })
    const source = new ElectronClipboardPngSource({ readImage: () => image })

    expect(source.read()).toBeUndefined()
    expect(toPNG).not.toHaveBeenCalled()
  })

  it('rejects dimensions and pixel counts before PNG encoding', () => {
    const toPNG = vi.fn(() => Buffer.from([1]))
    const readImage = vi
      .fn<() => Electron.NativeImage>()
      .mockReturnValueOnce(
        electronImage({ width: REMOTE_IMAGE_PASTE_MAX_DIMENSION + 1, toPNG }),
      )
      .mockReturnValueOnce(
        electronImage({
          width: REMOTE_IMAGE_PASTE_MAX_DIMENSION,
          height:
            Math.floor(REMOTE_IMAGE_PASTE_MAX_PIXELS / REMOTE_IMAGE_PASTE_MAX_DIMENSION) +
            1,
          toPNG,
        }),
      )
    const source = new ElectronClipboardPngSource({ readImage })

    expect(source.read()).toBe('too-large')
    expect(source.read()).toBe('too-large')
    expect(toPNG).not.toHaveBeenCalled()
  })

  it('returns bounded PNG bytes with their clipboard dimensions', () => {
    const bytes = Buffer.from([1, 2, 3])
    const toPNG = vi.fn(() => bytes)
    const image = electronImage({ width: 2, height: 3, bytes, toPNG })
    const source = new ElectronClipboardPngSource({ readImage: () => image })

    expect(source.read()).toEqual({ width: 2, height: 3, bytes })
    expect(toPNG).toHaveBeenCalledOnce()
  })
})

describe('RemoteImagePasteStorage', () => {
  it('uses the private hvir temp root, verifies mode, and cleans the exact leaf', async () => {
    const exec = vi
      .fn<ProjectHost['exec']>()
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: `${STAGED_PATH.path}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
    const writeFile = vi.fn<ProjectHost['writeFile']>(() => Promise.resolve())
    const removeFile = vi.fn<ProjectHost['removeFile']>(() => Promise.resolve())
    const stat = vi.fn<ProjectHost['stat']>(() =>
      Promise.resolve({ type: 'file', size: 3, mtimeMs: 1, mode: 0o100600 }),
    )
    const host = {
      hostId: REMOTE_ID,
      exec,
      writeFile,
      removeFile,
      stat,
    } as unknown as ProjectHost
    const storage = new RemoteImagePasteStorage()
    const signal = new AbortController().signal

    const path = await storage.stage(host, new Uint8Array([1, 2, 3]), signal)
    expect(path).toEqual(STAGED_PATH)
    expect(exec.mock.calls[0]?.[1]?.[1]).toContain('XDG_RUNTIME_DIR')
    expect(exec.mock.calls[0]?.[1]?.[1]).toContain('hvir-$uid')
    expect(exec.mock.calls[0]?.[1]?.[1]).toContain('safe_parent')
    expect(exec.mock.calls[1]?.[1]?.[1]).toContain('image-paste')
    expect(writeFile).toHaveBeenCalledWith(STAGED_PATH, new Uint8Array([1, 2, 3]), {
      signal,
    })

    await storage.remove(host, path)
    expect(removeFile).toHaveBeenCalledWith(STAGED_PATH, { ignoreMissing: true })
    expect(exec.mock.calls[2]?.[1]).toEqual([
      '-c',
      expect.not.stringContaining('rm -f'),
      'hvir-image-paste',
      STAGED_PATH.path,
    ])
  })

  it('removes the placeholder when staged file verification fails', async () => {
    const exec = vi
      .fn<ProjectHost['exec']>()
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout: `${STAGED_PATH.path}\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '' })
    const removeFile = vi.fn<ProjectHost['removeFile']>(() => Promise.resolve())
    const host = {
      hostId: REMOTE_ID,
      exec,
      writeFile: vi.fn<ProjectHost['writeFile']>(() => Promise.resolve()),
      removeFile,
      stat: vi.fn<ProjectHost['stat']>(() =>
        Promise.resolve({ type: 'file', size: 2, mtimeMs: 1, mode: 0o100600 }),
      ),
    } as unknown as ProjectHost
    const storage = new RemoteImagePasteStorage()

    await expect(
      storage.stage(host, new Uint8Array([1, 2, 3]), new AbortController().signal),
    ).rejects.toThrow('verification failed')
    expect(removeFile).toHaveBeenCalledWith(STAGED_PATH, { ignoreMissing: true })
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('bounds each preparatory shell control operation', async () => {
    vi.useFakeTimers()
    try {
      const exec = vi.fn<ProjectHost['exec']>(
        (_command, _args, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'))
            })
          }),
      )
      const host = { hostId: REMOTE_ID, exec } as unknown as ProjectHost
      const storage = new RemoteImagePasteStorage()
      const stage = storage.stage(
        host,
        new Uint8Array([1, 2, 3]),
        new AbortController().signal,
      )
      const failure = stage.catch((error: unknown) => error)

      await vi.advanceTimersByTimeAsync(8_000)

      await expect(failure).resolves.toEqual(
        expect.objectContaining({ message: 'aborted' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

function coordinatorFixture(
  initialTerminals: readonly ManagedPty[],
  clipboard = imageClipboard(),
  stageResult: Promise<HostPath> = Promise.resolve(STAGED_PATH),
) {
  const terminals = new Map(initialTerminals.map((terminal) => [terminal.id, terminal]))
  const connectionListeners = new Set<(state: HostConnectionState) => void>()
  const exitListeners = new Set<(info: ManagedPty, exit: PtyExit) => void>()
  let connectionState: HostConnectionState = 'connected'
  const host = {
    hostId: REMOTE_ID,
    get connectionState() {
      return connectionState
    },
    onConnectionState: (listener: (state: HostConnectionState) => void) => {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
  } as unknown as ProjectHost
  const write = vi.fn()
  const storage: RemoteImagePasteStoragePort = {
    stage: vi.fn(() => stageResult),
    remove: vi.fn(() => Promise.resolve()),
  }
  const registered: Array<{
    active: boolean
    dispose: () => void | Promise<void>
  }> = []
  const resources = {
    assertCurrent: vi.fn(),
    register: vi.fn(
      (
        _owner: RendererOwner,
        _qualifier: unknown,
        dispose: () => void | Promise<void>,
      ): RendererResourceLease => {
        const record = { active: true, dispose }
        registered.push(record)
        return {
          release: () => {
            record.active = false
          },
          dispose: async () => {
            if (!record.active) return
            record.active = false
            await dispose()
          },
        }
      },
    ),
  }
  const coordinator = new RemoteImagePasteCoordinator({
    clipboard,
    storage,
    getHost: (hostId) => (hostId === REMOTE_ID ? host : undefined),
    resources,
    ptys: {
      get: (id) => terminals.get(id),
      isOwnedBy: (id, ownerId, ownerGeneration) => {
        const terminal = terminals.get(id)
        return (
          terminal?.ownerId === ownerId && terminal.ownerGeneration === ownerGeneration
        )
      },
      write,
      onExit: (listener) => {
        exitListeners.add(listener)
        return () => {
          exitListeners.delete(listener)
        }
      },
    },
  })
  return {
    coordinator,
    terminals,
    host,
    storage: storage as {
      stage: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
    },
    write,
    assertCurrent: resources.assertCurrent,
    disposeRegistration: async (index: number) => {
      const record = registered[index]
      if (!record?.active) return
      record.active = false
      await record.dispose()
    },
    disposeRegistered: async () => {
      for (const record of registered) {
        if (!record.active) continue
        record.active = false
        await record.dispose()
      }
    },
    emitConnection: (state: HostConnectionState) => {
      connectionState = state
      for (const listener of connectionListeners) listener(state)
    },
    connectionListenerCount: () => connectionListeners.size,
    emitExit: (terminal: ManagedPty) => {
      const exit = { exitCode: 0, signal: undefined }
      for (const listener of exitListeners) listener(terminal, exit)
    },
  }
}

function imageClipboard(
  image = { width: 1, height: 1, bytes: new Uint8Array([1, 2, 3]) },
): ClipboardPngSource & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(() => image) }
}

function emptyClipboard(): ClipboardPngSource & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(() => undefined) }
}

function stagedPath(suffix: string): HostPath {
  return hostPath(REMOTE_ID, `/run/user/501/hvir/image-paste/paste.${suffix}/image.png`)
}

function electronImage(
  options: {
    readonly empty?: boolean
    readonly width?: number
    readonly height?: number
    readonly bytes?: Buffer
    readonly toPNG?: () => Buffer
  } = {},
): Electron.NativeImage {
  const bytes = options.bytes ?? Buffer.from([1])
  return {
    isEmpty: () => options.empty ?? false,
    getSize: () => ({ width: options.width ?? 1, height: options.height ?? 1 }),
    toPNG: options.toPNG ?? vi.fn(() => bytes),
  } as unknown as Electron.NativeImage
}

function managedTerminal(
  id: string,
  providerId: string,
  workspaceRoot: HostPath,
): ManagedPty {
  return {
    instanceId: `instance-${id}`,
    id,
    ownerId: OWNER.id,
    ownerGeneration: OWNER.generation,
    hostId: workspaceRoot.hostId,
    cwd: workspaceRoot,
    workspaceRoot,
    providerId: asHarnessProviderId(providerId),
    capabilities: {
      sessionIdentity: 'none',
      exactResume: false,
      contextPresentation: 'none',
    },
    pid: 10,
    startedAt: 1,
    resumed: false,
    identityStatus: 'none',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}
