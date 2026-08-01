import {
  asHarnessProviderId,
  hostPath,
  joinHostPath,
  type AssistantOutputEvent,
  type HostPath,
} from '../../shared'
import type { Disposer, ExecStreamHandle, ProjectHost } from '../project-host'
import { BoundedLineReader } from './bounded-line-reader'
import { CODEX_ASSISTANT_OUTPUT_PROXY_SCRIPT } from './codex-assistant-output-proxy-script'
import { CodexAssistantOutputSource } from './codex-assistant-output-source'
import type {
  HarnessAssistantOutputCapability,
  HarnessAssistantOutputPreparationContext,
  HarnessAssistantOutputRuntime,
} from './harness-provider'
import { harnessShellCommandArgs } from './harness-shell-environment'

const WAIT_FOR_SOCKET_SCRIPT = String.raw`
i=0
while [ "$i" -lt 40 ]; do
  [ -S "$1" ] && exit 0
  i=$((i + 1))
  sleep 0.025
done
exit 1
`
const CREATE_SOCKET_DIRECTORY_SCRIPT = [
  'set -eu',
  'umask 077',
  'directory=$(mktemp -d /tmp/hvir-codex.XXXXXX)',
  'canonical=$(cd "$directory" && pwd -P)',
  'case "$canonical" in /*/hvir-codex.??????) ;; *) rmdir "$directory"; exit 1 ;; esac',
  '[ "${#canonical}" -le 80 ] || { rmdir "$directory"; exit 1; }',
  'printf \'%s\\n\' "$canonical"',
].join('\n')
const CLEAN_SOCKET_DIRECTORY_SCRIPT = 'rm -f -- "$1" "$2"\nrmdir -- "$3"'
const MAX_PROXY_FRAME_LENGTH = 64 * 1024
const MAX_PREPARATION_MS = 4_000

interface CodexSocketPaths {
  readonly directory: HostPath
  readonly backend: HostPath
  readonly frontend: HostPath
}

export const codexAssistantOutput: HarnessAssistantOutputCapability = {
  async prepare(host, context) {
    const startup = new AbortController()
    const abortStartup = (): void => startup.abort()
    context.signal.addEventListener('abort', abortStartup, { once: true })
    if (context.signal.aborted) startup.abort()
    const timer = setTimeout(abortStartup, MAX_PREPARATION_MS)
    const preparation = { ...context, signal: startup.signal }
    let sockets: CodexSocketPaths | undefined
    let backendStream: ExecStreamHandle | undefined
    let proxyStream: ExecStreamHandle | undefined
    let runtime: CodexAssistantOutputRuntime | undefined
    try {
      const version = await host.exec(
        preparation.defaultShell,
        harnessShellCommandArgs(preparation.launchSpec.file, ['--version']),
        {
          cwd: preparation.cwd,
          env: preparation.launchSpec.env,
          unsetEnv: preparation.unsetEnvironment,
          signal: preparation.signal,
          maxBuffer: 4 * 1024,
        },
      )
      if (
        version.code !== 0 ||
        !admitsCodexAssistantOutput(`${version.stdout}\n${version.stderr}`)
      ) {
        return undefined
      }
      const python = await host.exec('sh', ['-c', 'command -v python3 >/dev/null'], {
        cwd: preparation.cwd,
        signal: preparation.signal,
        maxBuffer: 1024,
      })
      if (python.code !== 0) return undefined
      sockets = await createSocketPaths(host, preparation.signal)
      if (!sockets) return undefined
      backendStream = host.execStream(
        preparation.defaultShell,
        harnessShellCommandArgs(preparation.launchSpec.file, [
          'app-server',
          '--listen',
          `unix://${sockets.backend.path}`,
        ]),
        {
          cwd: preparation.cwd,
          env: preparation.launchSpec.env,
          unsetEnv: preparation.unsetEnvironment,
          signal: preparation.signal,
        },
      )
      if (!(await waitForSocket(host, sockets.backend.path, preparation))) {
        backendStream.dispose()
        await cleanupSockets(host, sockets, preparation.signal)
        return undefined
      }
      proxyStream = host.execStream(
        'python3',
        [
          '-u',
          '-c',
          CODEX_ASSISTANT_OUTPUT_PROXY_SCRIPT,
          sockets.frontend.path,
          sockets.backend.path,
        ],
        {
          cwd: preparation.cwd,
          keepStdinOpen: true,
          signal: preparation.signal,
        },
      )
      runtime = new CodexAssistantOutputRuntime(
        host,
        preparation,
        sockets,
        backendStream,
        proxyStream,
      )
      if (!(await waitForSocket(host, sockets.frontend.path, preparation))) {
        runtime.dispose()
        return undefined
      }
      return runtime
    } catch {
      if (runtime) runtime.dispose()
      else {
        backendStream?.dispose()
        proxyStream?.dispose()
        if (sockets) {
          await cleanupSockets(host, sockets).catch(() => undefined)
        }
      }
      return undefined
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abortStartup)
    }
  },
}

class CodexAssistantOutputRuntime implements HarnessAssistantOutputRuntime {
  readonly launchSpec
  private readonly listeners = new Set<(event: AssistantOutputEvent) => void>()
  private readonly disposers: Disposer[] = []
  private readonly source: CodexAssistantOutputSource
  private readonly generation: number
  private availability: 'available' | 'unavailable' = 'available'
  private sessionAdmitted = false
  private disposed = false

  constructor(
    private readonly host: ProjectHost,
    context: HarnessAssistantOutputPreparationContext,
    private readonly sockets: CodexSocketPaths,
    private readonly backend: ExecStreamHandle,
    private readonly proxy: ExecStreamHandle,
  ) {
    this.generation = context.generation
    this.launchSpec = {
      ...context.launchSpec,
      args: [
        '--remote',
        `unix://${sockets.frontend.path}`,
        ...context.launchSpec.args,
      ],
    }
    this.source = new CodexAssistantOutputSource({
      hostId: host.hostId,
      generation: this.generation,
      emit: (event) => this.emit(event),
      revoke: () => this.revoke('source-invalid'),
    })
    const lines = new BoundedLineReader(
      (line) => this.source.accept(line),
      MAX_PROXY_FRAME_LENGTH,
      () => this.revoke('source-invalid'),
    )
    this.disposers.push(
      proxy.onStdout((chunk) => lines.push(chunk)),
      // Body-bearing stderr is deliberately discarded, never logged.
      proxy.onStderr(() => undefined),
      backend.onStderr(() => undefined),
      proxy.onError(() => this.revoke('source-lost')),
      backend.onError(() => this.revoke('source-lost')),
      proxy.onExit(() => this.revoke('source-lost')),
      backend.onExit(() => this.revoke('source-lost')),
      host.onConnectionState((state) => {
        if (state !== 'connected') this.revoke('source-lost')
      }),
    )
  }

  observe(cb: (event: AssistantOutputEvent) => void): Disposer {
    if (this.disposed) return () => undefined
    this.listeners.add(cb)
    cb(this.availabilityEvent())
    return () => {
      this.listeners.delete(cb)
    }
  }

  admitSession(sessionId: string): boolean {
    this.sessionAdmitted = this.source.admitSession(sessionId)
    return this.sessionAdmitted
  }

  async setMode(enabled: boolean): Promise<boolean> {
    if (
      this.disposed ||
      this.availability !== 'available' ||
      (enabled && !this.sessionAdmitted)
    ) {
      return false
    }
    try {
      await this.proxy.write(`MODE\t${enabled ? '1' : '0'}\n`)
      return true
    } catch {
      this.revoke('source-lost')
      return false
    }
  }

  revoke(
    reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'] = 'source-lost',
  ): void {
    if (this.disposed || this.availability === 'unavailable') return
    this.availability = 'unavailable'
    this.source.dispose(reason)
    void this.proxy.write('REVOKE\n').catch(() => undefined)
    this.emit(this.availabilityEvent())
  }

  dispose(
    reason: Extract<AssistantOutputEvent, { kind: 'abort' }>['reason'] = 'source-lost',
  ): void {
    if (this.disposed) return
    this.disposed = true
    this.source.dispose(reason)
    this.availability = 'unavailable'
    this.emit(this.availabilityEvent())
    for (const dispose of this.disposers.splice(0)) void dispose()
    this.proxy.dispose()
    this.backend.dispose()
    this.listeners.clear()
    void cleanupSockets(this.host, this.sockets).catch(() => undefined)
  }

  private emit(event: AssistantOutputEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private availabilityEvent(): AssistantOutputEvent {
    return {
      hostId: this.host.hostId,
      providerId: asHarnessProviderId('codex'),
      kind: 'availability',
      state: this.availability,
      generation: this.generation,
    }
  }
}

export function admitsCodexAssistantOutput(version: string | undefined): boolean {
  return Boolean(version && /\b0\.146\.\d+\b/.test(version))
}

async function waitForSocket(
  host: ProjectHost,
  path: string,
  context: HarnessAssistantOutputPreparationContext,
): Promise<boolean> {
  const result = await host.exec(
    'sh',
    ['-c', WAIT_FOR_SOCKET_SCRIPT, 'hvir-codex-wait', path],
    {
      cwd: context.cwd,
      signal: context.signal,
      maxBuffer: 1024,
    },
  )
  return result.code === 0
}

async function createSocketPaths(
  host: ProjectHost,
  signal: AbortSignal,
): Promise<CodexSocketPaths | undefined> {
  const result = await host.exec(
    'sh',
    ['-c', CREATE_SOCKET_DIRECTORY_SCRIPT, 'hvir-codex-mktemp'],
    { signal, maxBuffer: 1024 },
  )
  const directoryPath = result.stdout.trim()
  if (
    result.code !== 0 ||
    !/^\/(?:[^\0\r\n/]+\/)*hvir-codex\.[A-Za-z0-9]{6}$/u.test(directoryPath)
  ) {
    return undefined
  }
  const directory = hostPath(host.hostId, directoryPath)
  return {
    directory,
    backend: joinHostPath(directory, 'server.sock'),
    frontend: joinHostPath(directory, 'client.sock'),
  }
}

async function cleanupSockets(
  host: ProjectHost,
  sockets: CodexSocketPaths,
  signal?: AbortSignal,
): Promise<void> {
  await host.exec(
    'sh',
    [
      '-c',
      CLEAN_SOCKET_DIRECTORY_SCRIPT,
      'hvir-codex-clean',
      sockets.backend.path,
      sockets.frontend.path,
      sockets.directory.path,
    ],
    { signal, maxBuffer: 1024 },
  )
}
