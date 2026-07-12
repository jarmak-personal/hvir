import {
  GIT_DIFF_INPUTS_TYPE,
  asHostId,
  hostPath,
  type DiffBase,
  type GitWorkerPayload,
  type HostPath,
  type WorkerRequest,
  type WorkerResponse,
} from '../shared'
import { GitEngine } from '../main/git/git-engine'
import { LocalHost } from '../main/project-host'

interface ParentPort {
  on(event: 'message', listener: (e: { data: WorkerRequest }) => void): void
  postMessage(message: WorkerResponse): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
if (!port) throw new Error('git-worker must run as an Electron utility process')

const host = new LocalHost()
const engine = new GitEngine(host)

port.on('message', ({ data: request }) => {
  if (request.type !== GIT_DIFF_INPUTS_TYPE || !isPayload(request.payload)) {
    port.postMessage({
      id: request.id,
      ok: false,
      error:
        request.type === GIT_DIFF_INPUTS_TYPE
          ? 'invalid git payload'
          : `unknown request type: ${request.type}`,
    })
    return
  }
  void handle(request.id, request.payload)
})

async function handle(id: number, raw: GitWorkerPayload): Promise<void> {
  try {
    const root = decodePath(raw.root)
    const path = decodePath(raw.path)
    assertProjectPath(path, root)
    const result = await engine.diffInputs(path, raw.base)
    port?.postMessage({ id, ok: true, result })
  } catch (error) {
    port?.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
