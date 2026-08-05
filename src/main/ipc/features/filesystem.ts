import {
  containsHostPath,
  hostPath,
  hostPathEquals,
  repositoryImageMimeType,
} from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type FilesystemIpcDeps = Pick<
  IpcDeps,
  | 'getProject'
  | 'getProjectState'
  | 'filenameSearch'
  | 'projectFiles'
  | 'rendererResources'
>

export function registerFilesystemIpc(ipc: IpcRegistrar, deps: FilesystemIpcDeps): void {
  ipc.handle('fs:readdir', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await ipc.authority.projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      return host.readdir(canonical)
    }),
  )

  ipc.handle('fs:filename-search', (req, context) =>
    operationResult(async () => {
      const project = deps.getProject()
      if (!hostPathEquals(req.root, project.root)) {
        throw new Error('Filename search root is not the active workspace')
      }
      const canonicalRoot = ipc.authority.projectPath(
        req.root,
        project.root,
        project.host,
        { returnCanonical: true },
      )
      const owner = context.owner()
      const state = deps.getProjectState()
      const activeProject = state.projects.find(
        (candidate) => candidate.id === state.activeProjectId,
      )
      const activeWorkspace = activeProject?.workspaces.find(
        (candidate) => candidate.id === state.activeWorkspaceId,
      )
      deps.rendererResources.register(
        owner,
        { lifetime: 'renderer', type: 'filename-search' },
        () => deps.filenameSearch.revoke(owner),
        { duplicate: 'reuse' },
      )
      return deps.filenameSearch.search({
        owner,
        host: project.host,
        root: req.root,
        canonicalRoot,
        query: req.query,
        includeIgnored: req.includeIgnored,
        gitIgnoreAvailable: activeWorkspace?.repository === true,
        refreshVersion: req.refreshVersion,
        requestId: req.requestId,
      })
    }),
  )

  ipc.handleSend('fs:filename-search-cancel', ({ requestId }, context) => {
    deps.filenameSearch.cancel(context.owner(), requestId)
  })

  ipc.handle('fs:resolve-entry', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await ipc.authority.projectPath(req.path, root, host, {
        returnCanonical: true,
      })
      const stat = await host.stat(canonical)
      return { path: hostPath(canonical.hostId, req.path.path), type: stat.type }
    }),
  )

  ipc.handle('fs:read', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await ipc.authority.projectPath(req.path, root, host, {
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

  ipc.handle('fs:read-asset', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      const canonical = await ipc.authority.projectPath(req.path, root, host, {
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

  ipc.handle('fs:write', (req) =>
    operationResult(async () => {
      const { root, host } = deps.getProject()
      if (typeof req.content !== 'string') throw new Error('File content must be text')
      if (
        req.expectedMtimeMs !== undefined &&
        (!Number.isFinite(req.expectedMtimeMs) || req.expectedMtimeMs < 0)
      ) {
        throw new Error('Invalid expected file modification time')
      }
      const canonical = await ipc.authority.projectPath(req.path, root, host, {
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

  ipc.handle('fs:create-entry', (req, context) =>
    operationResult(async () => {
      const workspaceRoot = ipc.authority.workspaceRoot(
        ipc.authority.reconstructHostPath(req.workspaceRoot),
      )
      const destinationDirectory = ipc.authority.reconstructHostPath(
        req.destinationDirectory,
      )
      if (!containsHostPath(workspaceRoot, destinationDirectory)) {
        throw new Error('The destination directory escapes the workspace')
      }
      return deps.projectFiles.create({
        owner: context.owner(),
        workspaceRoot,
        destinationDirectory,
        name: req.name,
        kind: req.kind,
      })
    }),
  )
}
