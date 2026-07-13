import {
  GIT_DIFF_INPUTS_TYPE,
  GIT_BLAME_TYPE,
  GIT_CHANGES_TYPE,
  GIT_HISTORY_TYPE,
  GIT_COMMIT_DETAIL_TYPE,
  asHostId,
  hostPath,
  type DiffBase,
  type GitWorkerPayload,
  type HostPath,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerHostCall,
  type WorkerHostCallInput,
  type WorkerHostResult,
  type HostId,
  type HostConnectionState,
  type HostWatchTier,
} from '../shared'
import { GitEngine } from '../main/git/git-engine'
import type { ProjectHost } from '../main/project-host'

interface ParentPort {
  on(
    event: 'message',
    listener: (e: { data: WorkerRequest | WorkerHostResult }) => void,
  ): void
  postMessage(message: WorkerResponse | WorkerHostCall): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('git-worker must run as an Electron utility process')

const hostResults = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>()
let nextHostCallId = 0

port.on('message', ({ data }) => {
  if ('kind' in data && data.kind === 'host-result') {
    const pending = hostResults.get(data.callId)
    if (!pending) return
    hostResults.delete(data.callId)
    if (data.ok) pending.resolve(data.result)
    else pending.reject(new Error(data.error))
    return
  }
  void handle(data as WorkerRequest)
})

async function handle(request: WorkerRequest): Promise<void> {
  try {
    if (!request.payload || typeof request.payload !== 'object')
      throw new Error('invalid git payload')
    const raw = request.payload as Record<string, unknown>
    if (!isRawPath(raw['root'])) throw new Error('invalid git root')
    const root = decodePath(raw['root'])
    const engine = new GitEngine(new ProxyGitHost(root.hostId))
    let result: unknown
    if (request.type === GIT_DIFF_INPUTS_TYPE && isPayload(request.payload)) {
      const path = decodePath(request.payload.path)
      assertProjectPath(path, root)
      result = await engine.diffInputs(
        path,
        request.payload.base,
        request.payload.revision,
      )
    } else if (request.type === GIT_CHANGES_TYPE) {
      result = await engine.changes(root)
    } else if (request.type === GIT_HISTORY_TYPE) {
      const path = isRawPath(raw['path']) ? decodePath(raw['path']) : undefined
      if (path) assertProjectPath(path, root)
      result = await engine.history(root, Number(raw['skip']), Number(raw['limit']), path)
    } else if (request.type === GIT_BLAME_TYPE && isRawPath(raw['path'])) {
      const path = decodePath(raw['path'])
      assertProjectPath(path, root)
      result = await engine.blame(path)
    } else if (request.type === GIT_COMMIT_DETAIL_TYPE) {
      result = await engine.commitDetail(root, String(raw['hash']))
    } else throw new Error(`unknown request type: ${request.type}`)
    port?.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    port?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

class ProxyGitHost implements ProjectHost {
  readonly connectionState: HostConnectionState = 'connected'
  readonly watchTier: HostWatchTier = 'native'
  constructor(readonly hostId: HostId) {}
  connect(): Promise<void> {
    return Promise.resolve()
  }
  dispose(): Promise<void> {
    return Promise.resolve()
  }
  onConnectionState(cb: (state: HostConnectionState) => void): () => void {
    cb('connected')
    return () => undefined
  }
  defaultShell(): Promise<string> {
    return Promise.reject(new Error('git worker does not resolve interactive shells'))
  }
  exec(
    command: string,
    args: readonly string[],
    opts: import('../main/project-host').ExecOptions = {},
  ): Promise<import('../shared').ExecResult> {
    return hostCall({
      operation: 'exec',
      hostId: this.hostId,
      command,
      args,
      cwd: opts.cwd,
      input: opts.input,
      maxBuffer: opts.maxBuffer,
    }) as Promise<import('../shared').ExecResult>
  }
  readTextFile(path: HostPath): Promise<string> {
    return hostCall({
      operation: 'readTextFile',
      hostId: this.hostId,
      path,
    }) as Promise<string>
  }
  execStream(): never {
    throw new Error('git worker does not stream host commands')
  }
  spawnPty(): never {
    throw new Error('git worker cannot spawn PTYs')
  }
  readFile(): never {
    throw new Error('git worker reads text only')
  }
  writeFile(): never {
    throw new Error('git worker is read-only')
  }
  readdir(): never {
    throw new Error('git worker does not list directories')
  }
  stat(): never {
    throw new Error('git worker does not stat files')
  }
  realpath(): never {
    throw new Error('git worker does not canonicalize paths')
  }
  watch(): never {
    throw new Error('git worker does not watch paths')
  }
}

function hostCall(call: WorkerHostCallInput): Promise<unknown> {
  const callId = ++nextHostCallId
  return new Promise((resolve, reject) => {
    hostResults.set(callId, { resolve, reject })
    port?.postMessage({ ...call, kind: 'host-call', callId })
  })
}

function isPayload(value: unknown): value is GitWorkerPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as {
    path?: unknown
    root?: unknown
    base?: unknown
  }
  return isRawPath(payload.path) && isRawPath(payload.root) && isDiffBase(payload.base)
}

function isRawPath(value: unknown): value is HostPath {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { hostId?: unknown }).hostId === 'string' &&
    typeof (value as { path?: unknown }).path === 'string'
  )
}

function isDiffBase(value: unknown): value is DiffBase {
  return value === 'working-tree' || value === 'head' || value === 'branch-point'
}

function decodePath(raw: HostPath): HostPath {
  return hostPath(asHostId(raw.hostId), raw.path)
}

function assertProjectPath(path: HostPath, root: HostPath): void {
  if (path.hostId !== root.hostId) throw new Error('Path belongs to another host')
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  if (path.path !== root.path && !path.path.startsWith(prefix)) {
    throw new Error('Path escapes the project root')
  }
}
