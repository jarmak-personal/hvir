/**
 * Main-side registration of the typed IPC contract. Every handler is typed
 * against `IpcInvokeMap` from the shared contract, so a channel's request and
 * response shapes are checked on both ends.
 */

import { app, ipcMain } from 'electron'

import {
  ECHO_REQUEST_TYPE,
  asHostId,
  dirnameHostPath,
  hostPath,
  type AppInfo,
  type EchoWorkerProtocol,
  GIT_DIFF_INPUTS_TYPE,
  GIT_BLAME_TYPE,
  GIT_CHANGES_TYPE,
  GIT_HISTORY_TYPE,
  GIT_IGNORED_ENTRIES_TYPE,
  GIT_COMMIT_DETAIL_TYPE,
  repositoryImageMimeType,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcSendChannel,
  type IpcSendPayload,
  type ProjectHostOption,
  type ProjectState,
  type OperationResult,
  type ConnectedHost,
  type BrowseHostResponse,
} from '../shared'
import { plainShellAdapter } from './harness/harness-adapter'
import type { ProjectHost } from './project-host'
import type { HtmlPreviewProtocol } from './html-preview-protocol'
import type { PtySupervisor } from './pty/pty-supervisor'
import type { WorkerClient } from './worker-host'

type Handler<C extends IpcInvokeChannel> = (
  req: IpcRequest<C>,
) => IpcResponse<C> | Promise<IpcResponse<C>>

function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (event, req: IpcRequest<C>) => {
    assertMainFrame(event)
    return handler(req)
  })
}

type SendHandler<C extends IpcSendChannel> = (payload: IpcSendPayload<C>) => void

const canonicalRoots = new WeakMap<ProjectHost, Map<string, Promise<HostPath>>>()

function handleSend<C extends IpcSendChannel>(channel: C, handler: SendHandler<C>): void {
  ipcMain.on(channel, (event, payload: IpcSendPayload<C>) => {
    try {
      assertMainFrame(event)
      handler(payload)
    } catch (reason) {
      // `ipcMain.on` has no response promise. Throwing here would become an
      // uncaught main-process exception during renderer reload/teardown.
      console.warn(
        `[ipc] ignored invalid ${channel} message: ${reason instanceof Error ? reason.message : String(reason)}`,
      )
    }
  })
}

export type EmitRendererEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void

export interface IpcDeps {
  readonly echoWorker: WorkerClient<EchoWorkerProtocol>
  readonly gitWorker: WorkerClient<GitWorkerProtocol>
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  readonly listHosts: () => readonly ProjectHostOption[]
  readonly connectHost: (hostId: string) => Promise<ConnectedHost>
  readonly disconnectHost: (hostId: string) => Promise<ProjectHostOption>
  readonly browseHost: (hostId: string, path: string) => Promise<BrowseHostResponse>
  readonly openProject: (hostId: string, path: string) => Promise<ProjectState>
  readonly respondSshPrompt: (id: number, answers?: readonly string[]) => void
  readonly ptySupervisor: PtySupervisor
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly emit: EmitRendererEvent
}

export function registerIpcHandlers(deps: IpcDeps): void {
  handle('app:info', (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    nodeVersion: process.versions.node,
    platform: process.platform,
  }))

  handle('demo:echo', async (req) => {
    const result = await deps.echoWorker.request(ECHO_REQUEST_TYPE, {
      text: req.text,
    })
    return { text: result.text, workerPid: result.workerPid }
  })

  handle('project:root', () => {
    const { root, host } = deps.getProject()
    return {
      root,
      connectionState: host.connectionState,
      watchTier: host.watchTier,
    }
  })
  handle('project:hosts', () => deps.listHosts())
  handle('project:connect-host', (req) =>
    operationResult(() => deps.connectHost(req.hostId)),
  )
  handle('project:disconnect-host', (req) =>
    operationResult(() => deps.disconnectHost(req.hostId)),
  )
  handle('project:browse-host', (req) =>
    operationResult(() => deps.browseHost(req.hostId, req.path)),
  )
  handle('project:open', (req) =>
    operationResult(() => deps.openProject(req.hostId, req.path)),
  )
  handle('ssh:prompt-response', (req) => {
    if (!Number.isSafeInteger(req?.id) || req.id <= 0) {
      throw new Error('Invalid SSH prompt id')
    }
    if (
      req.answers !== undefined &&
      (!Array.isArray(req.answers) ||
        req.answers.length > 16 ||
        req.answers.some(
          (answer) => typeof answer !== 'string' || answer.length > 16_384,
        ))
    ) {
      throw new Error('Invalid SSH prompt answers')
    }
    deps.respondSshPrompt(req.id, req.answers)
  })

  handle('fs:readdir', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      return host.readdir(canonical)
    }),
  )

  handle('fs:resolve-entry', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      const stat = await host.stat(canonical)
      return {
        path: hostPath(canonical.hostId, req.path.path),
        type: stat.type,
      }
    }),
  )

  handle('fs:read', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      const path = hostPath(canonical.hostId, req.path.path)
      const stat = await host.stat(canonical)
      if (stat.type !== 'file') throw new Error(`Not a regular file: ${path.path}`)
      if (stat.size > 64 * 1024 * 1024) {
        throw new Error('Files larger than 64 MiB are not opened by the viewer spike')
      }
      const data = await host.readFile(canonical, { pollingInterest: true })
      const sample = data.subarray(0, Math.min(data.length, 8192))
      const binary = sample.includes(0)
      return {
        path,
        content: binary ? '' : data.toString('utf8'),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        binary,
      }
    }),
  )

  handle('fs:read-asset', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      const path = hostPath(canonical.hostId, req.path.path)
      const mimeType = repositoryImageMimeType(path.path)
      if (!mimeType) throw new Error('Only repository image assets can be previewed')
      const stat = await host.stat(canonical)
      if (stat.type !== 'file') throw new Error(`Not a regular file: ${path.path}`)
      if (stat.size > 16 * 1024 * 1024) {
        throw new Error('Repository images larger than 16 MiB are not previewed')
      }
      const data = await host.readFile(canonical, { pollingInterest: true })
      if (data.byteLength > 16 * 1024 * 1024) {
        throw new Error('Repository images larger than 16 MiB are not previewed')
      }
      return {
        path,
        data: new Uint8Array(data),
        size: data.byteLength,
        mimeType,
      }
    }),
  )

  handle('fs:write', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      if (typeof req.content !== 'string') throw new Error('File content must be text')
      if (
        req.expectedMtimeMs !== undefined &&
        (!Number.isFinite(req.expectedMtimeMs) || req.expectedMtimeMs < 0)
      ) {
        throw new Error('Invalid expected file modification time')
      }
      const canonical = await projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      const path = hostPath(canonical.hostId, req.path.path)
      const stat = await host.stat(canonical)
      if (stat.type !== 'file') throw new Error(`Not a regular file: ${path.path}`)
      const expectedMtimeMs =
        req.expectedMtimeMs !== undefined && req.expectedMtimeMs > 0
          ? req.expectedMtimeMs
          : undefined
      if (expectedMtimeMs !== undefined && stat.mtimeMs !== expectedMtimeMs) {
        throw new Error('File changed since it was opened; reload before saving')
      }
      await host.writeFile(
        canonical,
        req.content,
        expectedMtimeMs === undefined ? {} : { expectedMtimeMs },
      )
      const written = await host.stat(canonical)
      return { path, size: written.size, mtimeMs: written.mtimeMs }
    }),
  )

  handle('git:diff-inputs', async (req) => {
    const { root, host } = deps.getProject()
    // Historical/deleted Git entries legitimately have no live leaf. Their
    // existing parent is still canonicalized before the worker may inspect
    // repository blobs, so this does not turn into a lexical-only bypass.
    const path = await projectPath(req.path, root, host, {
      allowMissingLeaf: true,
    })
    return deps.gitWorker.request(GIT_DIFF_INPUTS_TYPE, {
      path,
      base: req.base,
      revision: req.revision,
      root,
    })
  })

  handle('git:changes', async (req) => {
    const project = deps.getProject()
    const root = await projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_CHANGES_TYPE, { root })
  })

  handle('git:history', async (req) => {
    const project = deps.getProject()
    const root = await projectPath(req.root, project.root, project.host)
    const path = req.path
      ? await projectPath(req.path, project.root, project.host)
      : undefined
    return deps.gitWorker.request(GIT_HISTORY_TYPE, {
      root,
      path,
      limit: req.limit,
      cursor: req.cursor,
      allRefs: req.allRefs,
    })
  })

  handle('git:ignored-entries', async (req) => {
    const project = deps.getProject()
    const [root, directory] = await Promise.all([
      projectPath(req.root, project.root, project.host),
      projectPath(req.directory, project.root, project.host),
    ])
    return deps.gitWorker.request(GIT_IGNORED_ENTRIES_TYPE, {
      root,
      directory,
      names: req.names,
    })
  })

  handle('git:commit-detail', async (req) => {
    const project = deps.getProject()
    const root = await projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_COMMIT_DETAIL_TYPE, {
      root,
      hash: req.hash,
    })
  })

  handle('git:blame', async (req) => {
    const { root, host } = deps.getProject()
    const path = await projectPath(req.path, root, host)
    return deps.gitWorker.request(GIT_BLAME_TYPE, { root, path })
  })

  handle('html-preview:create', (req) => deps.htmlPreviews.create(req.content))

  handle('pty:start', async (req) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(req.sessionId)) {
      throw new Error('Invalid PTY session id')
    }
    const { root, host } = deps.getProject()
    const cwd = await projectPath(req.cwd, root, host)
    const cols = terminalDimension(req.cols)
    const rows = terminalDimension(req.rows)
    const managed = await deps.ptySupervisor.spawn({
      host,
      adapter: plainShellAdapter,
      cwd,
      sessionId: req.sessionId,
      cols,
      rows,
    })
    let detach: () => void | Promise<void> = () => undefined
    detach = deps.ptySupervisor.attach(managed.id, {
      onData: (data) => deps.emit('pty:data', { id: managed.id, data }),
      onExit: (exit) => {
        void detach()
        deps.emit('pty:exit', { id: managed.id, ...exit })
      },
    })
    return { id: managed.id, pid: managed.pid }
  })

  handleSend('pty:write', ({ id, data }) => {
    if (deps.ptySupervisor.get(id)) deps.ptySupervisor.write(id, data)
  })
  handleSend('html-preview:release', ({ id }) => deps.htmlPreviews.release(id))
  handleSend('pty:resize', ({ id, cols, rows }) => {
    if (deps.ptySupervisor.get(id)) {
      deps.ptySupervisor.resize(id, terminalDimension(cols), terminalDimension(rows))
    }
  })
  handleSend('pty:kill', ({ id }) => {
    if (deps.ptySupervisor.get(id)) deps.ptySupervisor.kill(id)
  })
}

async function operationResult<T>(
  operation: () => Promise<T>,
): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
  }
}

function assertMainFrame(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC is available only to the workbench main frame')
  }
}

/** Rebuild the opaque path at the IPC trust boundary and keep it in-project. */
async function projectPath(
  candidate: HostPath,
  root: HostPath,
  host: ProjectHost,
  options: {
    readonly allowMissingLeaf?: boolean
    readonly returnCanonical?: boolean
  } = {},
): Promise<HostPath> {
  if (
    !candidate ||
    typeof candidate.path !== 'string' ||
    typeof candidate.hostId !== 'string'
  ) {
    throw new Error('Invalid host-qualified path')
  }
  const decoded = hostPath(asHostId(candidate.hostId), candidate.path)
  if (decoded.hostId !== root.hostId) throw new Error('Path belongs to another host')
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  if (decoded.path !== root.path && !decoded.path.startsWith(prefix)) {
    throw new Error('Path escapes the project root')
  }
  let roots = canonicalRoots.get(host)
  if (!roots) {
    roots = new Map()
    canonicalRoots.set(host, roots)
  }
  const rootKey = `${root.hostId}:${root.path}`
  let canonicalRootPromise = roots.get(rootKey)
  if (!canonicalRootPromise) {
    canonicalRootPromise = host.realpath(root)
    roots.set(rootKey, canonicalRootPromise)
    void canonicalRootPromise.catch(() => roots?.delete(rootKey))
  }
  const canonicalRoot = await canonicalRootPromise
  let canonicalPath: HostPath
  try {
    canonicalPath = await host.realpath(decoded)
  } catch (reason) {
    if (!options.allowMissingLeaf || !isMissingPathError(reason)) throw reason
    let ancestor = dirnameHostPath(decoded)
    for (;;) {
      try {
        canonicalPath = await host.realpath(ancestor)
        break
      } catch (ancestorReason) {
        if (!isMissingPathError(ancestorReason) || ancestor.path === root.path) {
          throw ancestorReason
        }
        const parent = dirnameHostPath(ancestor)
        if (parent.path === ancestor.path || !isLexicallyInside(parent, root)) {
          throw reason
        }
        ancestor = parent
      }
    }
  }
  const canonicalPrefix = canonicalRoot.path === '/' ? '/' : `${canonicalRoot.path}/`
  if (
    canonicalPath.path !== canonicalRoot.path &&
    !canonicalPath.path.startsWith(canonicalPrefix)
  ) {
    throw new Error('Path escapes the project root through a symlink')
  }
  return options.returnCanonical ? canonicalPath : decoded
}

function isLexicallyInside(candidate: HostPath, root: HostPath): boolean {
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return candidate.path === root.path || candidate.path.startsWith(prefix)
}

function isMissingPathError(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const code = (reason as { code?: unknown }).code
  const message = reason instanceof Error ? reason.message : ''
  return code === 'ENOENT' || code === 2 || /no such file|not found/i.test(message)
}

function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}
