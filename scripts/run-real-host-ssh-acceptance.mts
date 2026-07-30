import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'

import {
  asHarnessProviderId,
  contextStatusHarnessSnapshot,
  hostPath,
  joinHostPath,
  type Disposer,
  type HostPath,
} from '../src/shared/index.ts'
import {
  plainShellProvider,
  type HarnessProvider,
  type HarnessTelemetryContext,
} from '../src/main/harness/harness-provider.ts'
import type {
  ExecStreamHandle,
  ProjectHost,
} from '../src/main/project-host/project-host.ts'
import { SshHost } from '../src/main/project-host/ssh-host.ts'
import { PtySupervisor } from '../src/main/pty/pty-supervisor.ts'
import {
  REAL_HOST_SSH_PHASES,
  createRealHostSshFailureEvidence,
  readRealHostSshConfiguration,
  writeRealHostSshFailureEvidence,
  type RealHostSshConfiguration,
  type RealHostSshFailureEvidence,
  type RealHostSshPhase,
  type RealHostSshResourceEvidence,
} from './real-host-ssh-contract.mts'

const OPERATION_TIMEOUT_MS = 15_000
const OWNER_ID = 1
const PTY_MARKER = 'HVIR_REAL_HOST_PTY_OK'
const PROVIDER_MARKER = 'HVIR_REAL_HOST_PROVIDER_OBSERVER_OK'
const HTTP_STATUS = 'HTTP/1.1 204 No Content'
const LOOPBACK_SERVER = String.raw`
import socket

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", 0))
server.listen(1)
server.settimeout(15)
print("PORT %d" % server.getsockname()[1], flush=True)
try:
    connection, _ = server.accept()
    connection.settimeout(5)
    connection.recv(4096)
    connection.sendall(b"HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
    connection.close()
finally:
    server.close()
`.trim()

interface MutableResources {
  rootRegistered: boolean
  watcherActive: boolean
  providerObserverActive: boolean
  loopbackActive: boolean
  streamCount: number
}

interface AcceptanceState {
  phase: RealHostSshPhase
  interrupted: boolean
  readonly startedAt: number
  readonly completed: { phase: RealHostSshPhase; durationMs: number }[]
  readonly resources: MutableResources
  readonly supervisor: PtySupervisor
  readonly capacityStreams: ExecStreamHandle[]
  stopWatch?: Disposer
  loopbackServer?: ExecStreamHandle
  loopbackSocket?: Duplex
  project?: DisposableRemoteProject
}

class DisposableRemoteProject {
  readonly root: HostPath
  readonly markerValue: string
  readonly marker: HostPath

  constructor(root: HostPath, markerValue: string) {
    this.root = root
    this.markerValue = markerValue
    this.marker = this.file('.hvir-real-host-owner')
  }

  file(name: string): HostPath {
    if (!/^(?!\.{1,2}$)[a-z0-9._-]{1,128}$/i.test(name)) {
      throw new Error('Disposable project file name was invalid')
    }
    const value = joinHostPath(this.root, name)
    this.assertContains(value)
    return value
  }

  assertContains(value: HostPath): void {
    if (
      value.hostId !== this.root.hostId ||
      (value.path !== this.root.path && !value.path.startsWith(`${this.root.path}/`))
    ) {
      throw new Error('Remote acceptance path escaped its registered root')
    }
  }
}

async function main(): Promise<number> {
  const configuration = readRealHostSshConfiguration(process.env)
  const inlinePrivateKey = process.env.HVIR_REAL_SSH_PRIVATE_KEY
    ? Buffer.from(process.env.HVIR_REAL_SSH_PRIVATE_KEY, 'utf8')
    : undefined
  const passphrase = process.env.HVIR_REAL_SSH_PASSPHRASE
  delete process.env.HVIR_REAL_SSH_PRIVATE_KEY
  delete process.env.HVIR_REAL_SSH_PASSPHRASE

  if (configuration.kind === 'unavailable') {
    inlinePrivateKey?.fill(0)
    console.error('[real-host:ssh] unavailable: explicit target configuration is absent')
    return 2
  }
  if (configuration.kind === 'invalid') {
    inlinePrivateKey?.fill(0)
    console.error(
      `[real-host:ssh] invalid explicit configuration (${configuration.fields.join(', ')})`,
    )
    const evidence = createRealHostSshFailureEvidence({
      phase: 'configuration',
      durationMs: 0,
      connectionState: 'disconnected',
      watchTier: 'polling',
      resources: emptyResourceEvidence(),
      transports: [],
    })
    await retainFailureEvidence(evidence)
    return 1
  }

  try {
    return await runConfiguredAcceptance(
      configuration.value,
      inlinePrivateKey,
      configuration.value.hasPassphrase ? passphrase : undefined,
    )
  } finally {
    inlinePrivateKey?.fill(0)
  }
}

async function runConfiguredAcceptance(
  configuration: RealHostSshConfiguration,
  inlinePrivateKey: Buffer | undefined,
  passphrase: string | undefined,
): Promise<number> {
  const state: AcceptanceState = {
    phase: 'configuration',
    interrupted: false,
    startedAt: performance.now(),
    completed: [],
    resources: {
      rootRegistered: false,
      watcherActive: false,
      providerObserverActive: false,
      loopbackActive: false,
      streamCount: 0,
    },
    supervisor: new PtySupervisor(),
    capacityStreams: [],
  }
  let privateKey: Buffer | undefined
  let host: SshHost | undefined
  let failure: RealHostSshFailureEvidence | undefined
  const interrupt = (): void => {
    state.interrupted = true
    state.supervisor.disposeSessions()
    void host?.dispose().catch(() => undefined)
  }
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, interrupt)
  }

  try {
    await runPhase(state, 'configuration', () => Promise.resolve())
    await runPhase(state, 'credentials-loaded', async () => {
      const loaded =
        configuration.credential.kind === 'inline'
          ? inlinePrivateKey
          : await readFile(configuration.credential.path)
      if (!loaded || loaded.length === 0) {
        throw new Error('Explicit SSH identity was empty')
      }
      privateKey = loaded
    })

    if (!privateKey) throw new Error('Explicit SSH identity was not loaded')
    host = new SshHost({
      config: {
        alias: configuration.alias,
        hostname: configuration.hostname,
        user: configuration.user,
        port: configuration.port,
        identityFiles: [],
      },
      identities: [{ path: 'explicit-real-host-identity', privateKey }],
      trustedHostKey: () => configuration.trustedHostKey,
      prompter: {
        prompt: (request) => {
          if (request.kind === 'passphrase' && passphrase) {
            return Promise.resolve([passphrase])
          }
          return Promise.resolve(undefined)
        },
      },
      pollIntervalMs: 100,
      watchdogIntervalMs: 500,
      refreshPulseIntervalMs: 1_000,
      slowScanIntervalMs: 100,
      maxSlowScanIntervalMs: 500,
      maxConcurrentExecs: 8,
    })

    await exerciseRealHost(configuration, host, state)
  } catch {
    failure = captureFailure(state, host)
  } finally {
    state.phase = 'cleanup'
    const cleanupStartedAt = performance.now()
    try {
      await cleanupAcceptance(host, state)
      if (!failure) {
        state.completed.push({
          phase: 'cleanup',
          durationMs: performance.now() - cleanupStartedAt,
        })
        console.log(
          `[real-host:ssh] cleanup OK (${Math.round(performance.now() - cleanupStartedAt)}ms)`,
        )
      }
    } catch {
      failure = captureFailure(state, host)
    } finally {
      try {
        await host?.dispose()
      } catch {
        failure ??= captureFailure(state, host)
      }
      privateKey?.fill(0)
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
        process.removeListener(signal, interrupt)
      }
    }
  }

  if (failure) {
    await retainFailureEvidence(failure)
    console.error(`[real-host:ssh] failed ${JSON.stringify(failure)}`)
    return 1
  }

  if (
    state.completed.map(({ phase }) => phase).join(',') !== REAL_HOST_SSH_PHASES.join(',')
  ) {
    const incomplete = captureFailure(state, host)
    await retainFailureEvidence(incomplete)
    console.error(`[real-host:ssh] failed ${JSON.stringify(incomplete)}`)
    return 1
  }
  console.log(
    `[real-host:ssh] passed ${JSON.stringify({
      schema: 1,
      status: 'passed',
      phases: state.completed.map(({ phase, durationMs }) => ({
        phase,
        durationMs: Math.round(durationMs),
      })),
      totalDurationMs: Math.round(performance.now() - state.startedAt),
    })}`,
  )
  return 0
}

async function exerciseRealHost(
  configuration: RealHostSshConfiguration,
  host: SshHost,
  state: AcceptanceState,
): Promise<void> {
  await runPhase(state, 'connected', () => withTimeout(host.connect()))

  await runPhase(state, 'root-registered', async () => {
    const configuredParent = hostPath(host.hostId, configuration.rootParent)
    const parent = await withTimeout(host.realpath(configuredParent))
    const parentStat = await withTimeout(host.stat(parent))
    if (parentStat.type !== 'dir')
      throw new Error('Configured root parent is not a directory')
    const root = joinHostPath(parent, `hvir-real-host-${randomUUID()}`)
    const project = new DisposableRemoteProject(root, randomUUID())
    state.project = project
    state.resources.rootRegistered = true
    const created = await withTimeout(
      host.exec('sh', [
        '-c',
        'umask 077; mkdir "$1" && { printf "%s" "$2" > "$3" || { rmdir "$1"; exit 1; }; }',
        'hvir-real-host-root',
        root.path,
        project.markerValue,
        project.marker.path,
      ]),
    )
    if (created.code !== 0)
      throw new Error('Disposable project root could not be created')
    const canonicalRoot = await withTimeout(host.realpath(root))
    if (canonicalRoot.hostId !== root.hostId || canonicalRoot.path !== root.path) {
      throw new Error('Disposable project root canonicalized outside its expected path')
    }
  })

  const project = requireProject(state)
  await runPhase(state, 'exec', async () => {
    const result = await withTimeout(host.exec('pwd', [], { cwd: project.root }))
    if (result.code !== 0 || result.stdout.trim() !== project.root.path) {
      throw new Error('Remote exec did not preserve the registered root')
    }
    const nonzero = await withTimeout(
      host.exec('sh', ['-c', 'exit 23'], { cwd: project.root }),
    )
    if (nonzero.code !== 23) throw new Error('Remote exec lost its exit status')
  })

  const sftpFile = project.file('sftp-contract.txt')
  await runPhase(state, 'sftp', async () => {
    const value = `sftp-${randomUUID()}`
    await withTimeout(host.writeFile(sftpFile, value))
    if ((await withTimeout(host.readTextFile(sftpFile))) !== value) {
      throw new Error('SFTP round-trip did not preserve exact bytes')
    }
    const stat = await withTimeout(host.stat(sftpFile))
    const entries = await withTimeout(host.readdir(project.root))
    if (
      stat.type !== 'file' ||
      !entries.some(({ name }) => name === 'sftp-contract.txt')
    ) {
      throw new Error('SFTP stat/readdir contract failed')
    }
  })

  await runPhase(state, 'watch', async () => {
    const changed = new Promise<void>((resolve) => {
      state.stopWatch = host.watch(
        project.root,
        (event) => {
          if (
            event.synthetic === undefined &&
            event.path.hostId === sftpFile.hostId &&
            event.path.path === sftpFile.path
          ) {
            resolve()
          }
        },
        { recursive: true },
      )
    })
    state.resources.watcherActive = true
    await delay(300)
    await withTimeout(host.writeFile(sftpFile, `watch-${randomUUID()}`))
    await withTimeout(changed)
    await state.stopWatch?.()
    state.stopWatch = undefined
    state.resources.watcherActive = false
  })

  await runPhase(state, 'pty-provider-observation', async () => {
    await verifyPtyAndProviderObservation(host, project, state)
  })

  await runPhase(state, 'loopback-stream', async () => {
    await verifyLoopbackStream(host, project, state)
  })

  await runPhase(state, 'transport-capacity', async () => {
    await verifyTransportCapacity(host, project, state)
  })

  await runPhase(state, 'reconnected', async () => {
    await withTimeout(host.dispose())
    if (host.connectionState !== 'disconnected') {
      throw new Error('Explicit SSH disconnect did not settle')
    }
    await withTimeout(host.connect())
    if ((await withTimeout(host.readTextFile(project.marker))) !== project.markerValue) {
      throw new Error('Reconnect did not recover the registered project root')
    }
  })
}

async function verifyPtyAndProviderObservation(
  host: SshHost,
  project: DisposableRemoteProject,
  state: AcceptanceState,
): Promise<void> {
  const provider = acceptanceProvider(state.resources)
  const terminal = await withTimeout(
    state.supervisor.spawn({
      host,
      provider,
      cwd: project.root,
      workspaceRoot: project.root,
      ownerId: OWNER_ID,
      sessionId: randomUUID(),
      cols: 80,
      rows: 24,
    }),
  )
  let outputSuffix = ''
  let disposeAttachment: Disposer = () => undefined
  const output = new Promise<void>((resolve) => {
    disposeAttachment = state.supervisor.attach(
      terminal.id,
      OWNER_ID,
      {
        onData: (chunk) => {
          const combined = `${outputSuffix}${chunk}`
          if (combined.includes(PTY_MARKER)) resolve()
          outputSuffix = combined.slice(-(PTY_MARKER.length - 1))
        },
      },
      terminal.ownerGeneration,
    )
  })
  const telemetry = new Promise<void>((resolve) => {
    const previous = disposeAttachment
    const telemetryAttachment = state.supervisor.attach(
      terminal.id,
      OWNER_ID,
      {
        onTelemetry: (snapshot) => {
          if (
            snapshot?.source.providerId === provider.manifest.id &&
            snapshot.facets.session.status === 'available'
          ) {
            resolve()
          }
        },
      },
      terminal.ownerGeneration,
    )
    disposeAttachment = async () => {
      await previous()
      await telemetryAttachment()
    }
  })
  const exited = new Promise<void>((resolve, reject) => {
    const stop = state.supervisor.onExit((info, exit) => {
      if (info.id !== terminal.id) return
      void stop()
      if (exit.exitCode === 0) resolve()
      else reject(new Error('Remote PTY exited unsuccessfully'))
    })
  })
  void exited.catch(() => undefined)

  try {
    await withTimeout(telemetry)
    state.supervisor.resize(terminal.id, OWNER_ID, 96, 30, terminal.ownerGeneration)
    state.supervisor.write(
      terminal.id,
      OWNER_ID,
      `printf '${PTY_MARKER}\\n'; exit\n`,
      terminal.ownerGeneration,
    )
    await withTimeout(Promise.all([output, exited]))
    if (state.supervisor.get(terminal.id)) {
      throw new Error('Exited remote PTY remained supervised')
    }
  } finally {
    await disposeAttachment()
  }
}

function acceptanceProvider(resources: MutableResources): HarnessProvider {
  const providerId = asHarnessProviderId('real-host-acceptance')
  return {
    ...plainShellProvider,
    manifest: {
      ...plainShellProvider.manifest,
      id: providerId,
      displayName: 'Real-host acceptance observer',
      default: false,
    },
    sessionIdentity: 'preassigned',
    telemetry: {
      observe: (host, context) => observeProviderStream(host, context, resources),
    },
  }
}

async function observeProviderStream(
  host: ProjectHost,
  context: HarnessTelemetryContext,
  resources: MutableResources,
): Promise<Disposer> {
  const handle = host.execStream(
    'sh',
    [
      '-c',
      `printf '${PROVIDER_MARKER}\\n'; cat >/dev/null`,
      'hvir-real-host-provider-observer',
    ],
    { keepStdinOpen: true, signal: context.signal, cwd: context.cwd },
  )
  resources.streamCount++
  resources.providerObserverActive = true
  let suffix = ''
  let settled = false
  let disposed = false
  const disposers: Disposer[] = []
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    resources.providerObserverActive = false
    resources.streamCount = Math.max(0, resources.streamCount - 1)
    for (const stop of disposers.splice(0)) void stop()
    void handle.end().catch(() => handle.dispose())
  }
  await new Promise<void>((resolve, reject) => {
    const fail = (): void => {
      if (settled) return
      settled = true
      dispose()
      reject(new Error('Provider observer stream did not become ready'))
    }
    disposers.push(
      handle.onStdout((chunk) => {
        if (settled) return
        const combined = `${suffix}${chunk}`
        if (combined.includes(PROVIDER_MARKER)) {
          settled = true
          context.emit(
            contextStatusHarnessSnapshot({
              providerId: asHarnessProviderId('real-host-acceptance'),
              provenance: 'Real-host SSH provider observation',
              sessionId: context.sessionId,
              context: { status: 'pending', reason: 'Observer stream available' },
            }),
          )
          resolve()
        }
        suffix = combined.slice(-(PROVIDER_MARKER.length - 1))
      }),
      handle.onStderr(() => undefined),
      handle.onError(fail),
      handle.onExit(fail),
    )
    context.signal.addEventListener('abort', dispose, { once: true })
    disposers.push(() => context.signal.removeEventListener('abort', dispose))
  })
  return dispose
}

async function verifyLoopbackStream(
  host: SshHost,
  project: DisposableRemoteProject,
  state: AcceptanceState,
): Promise<void> {
  const server = host.execStream('python3', ['-u', '-c', LOOPBACK_SERVER], {
    cwd: project.root,
  })
  state.loopbackServer = server
  state.resources.loopbackActive = true
  state.resources.streamCount++
  let partial = ''
  let portReported = false
  const serverExit = new Promise<void>((resolve, reject) => {
    server.onError(() => reject(new Error('Remote loopback server failed')))
    server.onExit(({ code }) => {
      if (code === 0) resolve()
      else reject(new Error('Remote loopback server exited unsuccessfully'))
    })
  })
  void serverExit.catch(() => undefined)
  const port = await withTimeout(
    new Promise<number>((resolve, reject) => {
      server.onStdout((chunk) => {
        partial = `${partial}${chunk}`.slice(-128)
        const match = /(?:^|\n)PORT ([0-9]{1,5})(?:\r?\n|$)/.exec(partial)
        if (!match) return
        const value = Number(match[1])
        if (!Number.isInteger(value) || value < 1 || value > 65_535) {
          reject(new Error('Remote loopback server reported an invalid port'))
          return
        }
        portReported = true
        resolve(value)
      })
      server.onError(() => reject(new Error('Remote loopback server failed')))
      server.onExit(() => {
        if (!portReported) reject(new Error('Remote loopback server exited before ready'))
      })
    }),
  )
  const socket = await withTimeout(host.connectLoopback({ hostname: '127.0.0.1', port }))
  state.loopbackSocket = socket
  state.resources.streamCount++
  let response = ''
  const received = new Promise<void>((resolve, reject) => {
    socket.on('data', (chunk: Buffer) => {
      response = `${response}${chunk.toString('utf8')}`
      if (response.length > 2_048) {
        reject(new Error('Loopback response exceeded its acceptance bound'))
      }
    })
    socket.on('end', () => {
      if (response.includes(HTTP_STATUS)) resolve()
      else reject(new Error('Loopback response did not match the semantic contract'))
    })
    socket.on('error', () => reject(new Error('Loopback stream failed')))
  })
  socket.end('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
  await withTimeout(Promise.all([received, serverExit]))
  socket.destroy()
  state.loopbackSocket = undefined
  state.loopbackServer = undefined
  state.resources.streamCount = Math.max(0, state.resources.streamCount - 2)
  state.resources.loopbackActive = false
}

async function verifyTransportCapacity(
  host: SshHost,
  project: DisposableRemoteProject,
  state: AcceptanceState,
): Promise<void> {
  const exits: Promise<void>[] = []
  for (let index = 0; index < 7; index++) {
    const handle = host.execStream(
      'sh',
      ['-c', 'IFS= read -r _', `hvir-real-host-capacity-${index}`],
      { keepStdinOpen: true, cwd: project.root },
    )
    state.capacityStreams.push(handle)
    state.resources.streamCount++
    const exited = new Promise<void>((resolve, reject) => {
      handle.onError(() => reject(new Error('Capacity stream failed')))
      handle.onExit(({ code }) => {
        if (code === 0) resolve()
        else reject(new Error('Capacity stream exited unsuccessfully'))
      })
    })
    void exited.catch(() => undefined)
    exits.push(exited)
    await withTimeout(handle.write(''))
  }
  const diagnostics = host.transportDiagnostics().filter(({ role }) => role === 'control')
  if (
    diagnostics.length < 2 ||
    diagnostics.reduce((total, item) => total + item.channels, 0) < 7
  ) {
    throw new Error('Real SSH transport did not expose bounded pooled capacity')
  }
  await Promise.all(state.capacityStreams.map((handle) => handle.end('\n')))
  await withTimeout(Promise.all(exits))
  state.resources.streamCount = Math.max(
    0,
    state.resources.streamCount - state.capacityStreams.length,
  )
  state.capacityStreams.splice(0)
}

async function cleanupAcceptance(
  host: SshHost | undefined,
  state: AcceptanceState,
): Promise<void> {
  await state.stopWatch?.()
  state.stopWatch = undefined
  state.resources.watcherActive = false

  state.loopbackSocket?.destroy()
  state.loopbackSocket = undefined
  state.loopbackServer?.dispose()
  state.loopbackServer = undefined
  state.resources.loopbackActive = false

  const openCapacityStreams = state.capacityStreams.splice(0)
  for (const stream of openCapacityStreams) stream.dispose()
  state.resources.streamCount = Math.max(
    0,
    state.resources.streamCount - openCapacityStreams.length,
  )
  await state.supervisor.disposeAllAndWait(5_000)
  state.resources.providerObserverActive = false
  state.resources.streamCount = 0

  const project = state.project
  if (host) {
    await withTimeout(host.dispose())
    // The acceptance commands never background work. Give the SSH server one
    // bounded turn to reap any channel closed by the old client generation.
    await delay(250)
  }
  if (host && project && state.resources.rootRegistered) {
    await withTimeout(host.connect())
    let rootExists = false
    try {
      const stat = await withTimeout(host.stat(project.root))
      if (stat.type !== 'dir') throw new Error('Disposable project root changed type')
      rootExists = true
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error('Disposable root state was unreadable', { cause: error })
      }
    }
    if (!rootExists) {
      state.resources.rootRegistered = false
      await withTimeout(host.dispose())
      return
    }
    if ((await withTimeout(host.readTextFile(project.marker))) !== project.markerValue) {
      throw new Error('Disposable root ownership marker did not match')
    }
    const removed = await withTimeout(
      host.exec('sh', [
        '-c',
        'expected=$1; marker=$2; root=$3; [ -f "$marker" ] && [ "$(cat -- "$marker")" = "$expected" ] && rm -rf -- "$root"',
        'hvir-real-host-cleanup',
        project.markerValue,
        project.marker.path,
        project.root.path,
      ]),
    )
    if (removed.code !== 0) throw new Error('Disposable project cleanup failed')
    let absent = false
    try {
      await withTimeout(host.stat(project.root))
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new Error('Removed root state was unreadable', { cause: error })
      }
      absent = true
    }
    if (!absent) throw new Error('Disposable project root remained after cleanup')
    state.resources.rootRegistered = false
  }
  await withTimeout(host?.dispose() ?? Promise.resolve())
}

async function runPhase(
  state: AcceptanceState,
  phase: RealHostSshPhase,
  task: () => Promise<void>,
): Promise<void> {
  state.phase = phase
  if (state.interrupted) throw new Error('Real-host SSH acceptance was interrupted')
  const startedAt = performance.now()
  await task()
  if (state.interrupted) throw new Error('Real-host SSH acceptance was interrupted')
  const durationMs = performance.now() - startedAt
  state.completed.push({ phase, durationMs })
  console.log(`[real-host:ssh] ${phase} OK (${Math.round(durationMs)}ms)`)
}

function requireProject(state: AcceptanceState): DisposableRemoteProject {
  if (!state.project) throw new Error('Disposable project root was not registered')
  return state.project
}

function captureFailure(
  state: AcceptanceState,
  host: SshHost | undefined,
): RealHostSshFailureEvidence {
  return createRealHostSshFailureEvidence({
    phase: state.phase,
    durationMs: performance.now() - state.startedAt,
    connectionState: host?.connectionState ?? 'disconnected',
    watchTier: host?.watchTier ?? 'polling',
    resources: resourceEvidence(state),
    transports: host?.transportDiagnostics() ?? [],
  })
}

function resourceEvidence(state: AcceptanceState): RealHostSshResourceEvidence {
  return {
    rootRegistered: state.resources.rootRegistered,
    watcherActive: state.resources.watcherActive,
    ptyCount: state.supervisor.list().length,
    providerObserverActive: state.resources.providerObserverActive,
    loopbackActive: state.resources.loopbackActive,
    streamCount: state.resources.streamCount,
  }
}

function emptyResourceEvidence(): RealHostSshResourceEvidence {
  return {
    rootRegistered: false,
    watcherActive: false,
    ptyCount: 0,
    providerObserverActive: false,
    loopbackActive: false,
    streamCount: 0,
  }
}

async function retainFailureEvidence(
  evidence: RealHostSshFailureEvidence,
): Promise<void> {
  try {
    if (
      await writeRealHostSshFailureEvidence(
        process.env.HVIR_REAL_SSH_ARTIFACT_DIR,
        evidence,
      )
    ) {
      console.error('[real-host:ssh] retained bounded failure evidence')
    }
  } catch {
    console.error('[real-host:ssh] failed to retain bounded failure evidence')
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
  return withOverallTimeout(operation, timeoutMs)
}

async function withOverallTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Real-host SSH operation timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  return code === 2 || code === 'ENOENT'
}

void main().then(
  (exitCode) => {
    process.exitCode = exitCode
  },
  async () => {
    const evidence = createRealHostSshFailureEvidence({
      phase: 'configuration',
      durationMs: 0,
      connectionState: 'disconnected',
      watchTier: 'polling',
      resources: emptyResourceEvidence(),
      transports: [],
    })
    await retainFailureEvidence(evidence)
    console.error(`[real-host:ssh] failed ${JSON.stringify(evidence)}`)
    process.exitCode = 1
  },
)
