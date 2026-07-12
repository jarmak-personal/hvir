/**
 * Main-side registration of the typed IPC contract. Every handler is typed
 * against `IpcInvokeMap` from the shared contract, so a channel's request and
 * response shapes are checked on both ends.
 */

import { app, ipcMain } from 'electron'

import {
  ECHO_REQUEST_TYPE,
  asHostId,
  hostPath,
  type AppInfo,
  type EchoWorkerProtocol,
  GIT_DIFF_INPUTS_TYPE,
  type GitWorkerProtocol,
  type HostPath,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcSendChannel,
  type IpcSendPayload,
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

function handleSend<C extends IpcSendChannel>(channel: C, handler: SendHandler<C>): void {
  ipcMain.on(channel, (event, payload: IpcSendPayload<C>) => {
    assertMainFrame(event)
    handler(payload)
  })
}

export type EmitRendererEvent = <E extends IpcEventChannel>(
  channel: E,
  payload: IpcEventPayload<E>,
) => void

export interface IpcDeps {
  readonly echoWorker: WorkerClient<EchoWorkerProtocol>
  readonly gitWorker: WorkerClient<GitWorkerProtocol>
  readonly host: ProjectHost
  readonly root: HostPath
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

  handle('project:root', () => ({ root: deps.root }))

  handle('fs:readdir', async (req) => {
    const path = projectPath(req.path, deps.root)
    return deps.host.readdir(path)
  })

  handle('fs:read', async (req) => {
    const path = projectPath(req.path, deps.root)
    const stat = await deps.host.stat(path)
    if (stat.type !== 'file') throw new Error(`Not a regular file: ${path.path}`)
    if (stat.size > 64 * 1024 * 1024) {
      throw new Error('Files larger than 64 MiB are not opened by the viewer spike')
    }
    const data = await deps.host.readFile(path)
    const sample = data.subarray(0, Math.min(data.length, 8192))
    const binary = sample.includes(0)
    return {
      path,
      content: binary ? '' : data.toString('utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      binary,
    }
  })

  handle('fs:write', async (req) => {
    const path = projectPath(req.path, deps.root)
    if (typeof req.content !== 'string') throw new Error('File content must be text')
    const stat = await deps.host.stat(path)
    if (stat.type !== 'file') throw new Error(`Not a regular file: ${path.path}`)
    await deps.host.writeFile(path, req.content)
    const written = await deps.host.stat(path)
    return { path, size: written.size, mtimeMs: written.mtimeMs }
  })

  handle('git:diff-inputs', async (req) => {
    const path = projectPath(req.path, deps.root)
    return deps.gitWorker.request(GIT_DIFF_INPUTS_TYPE, {
      path,
      base: req.base,
      root: deps.root,
    })
  })

  handle('html-preview:create', (req) => deps.htmlPreviews.create(req.content))

  handle('pty:start', async (req) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(req.sessionId)) {
      throw new Error('Invalid PTY session id')
    }
    const cwd = projectPath(req.cwd, deps.root)
    const cols = terminalDimension(req.cols)
    const rows = terminalDimension(req.rows)
    const managed = await deps.ptySupervisor.spawn({
      host: deps.host,
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

function assertMainFrame(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('IPC is available only to the workbench main frame')
  }
}

/** Rebuild the opaque path at the IPC trust boundary and keep it in-project. */
function projectPath(candidate: HostPath, root: HostPath): HostPath {
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
  return decoded
}

function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}
