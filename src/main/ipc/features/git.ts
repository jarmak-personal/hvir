import {
  GIT_BLAME_TYPE,
  GIT_BRANCHES_TYPE,
  GIT_CHANGES_TYPE,
  GIT_COMMIT_DETAIL_TYPE,
  GIT_DIFF_INPUTS_TYPE,
  GIT_HISTORY_TYPE,
  GIT_IGNORED_ENTRIES_TYPE,
} from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'

type GitIpcDeps = Pick<
  IpcDeps,
  'getProject' | 'gitWorker' | 'fetchGit' | 'pullGit' | 'switchGitBranch'
>

export function registerGitIpc(ipc: IpcRegistrar, deps: GitIpcDeps): void {
  ipc.handle('git:diff-inputs', async (req) => {
    const { root, host } = deps.getProject()
    // Historical/deleted Git entries legitimately have no live leaf. Their
    // existing parent is still canonicalized before the worker may inspect
    // repository blobs, so this does not turn into a lexical-only bypass.
    const path = await ipc.authority.projectPath(req.path, root, host, {
      allowMissingLeaf: true,
    })
    return deps.gitWorker.request(GIT_DIFF_INPUTS_TYPE, {
      path,
      base: req.base,
      revision: req.revision,
      root,
    })
  })

  ipc.handle('git:changes', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_CHANGES_TYPE, {
      root,
      relatedWorktreeRoots: ipc.authority.worktreeRoots(root),
    })
  })

  ipc.handle('git:history', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    const path = req.path
      ? await ipc.authority.projectPath(req.path, project.root, project.host)
      : undefined
    return deps.gitWorker.request(GIT_HISTORY_TYPE, {
      root,
      path,
      limit: req.limit,
      cursor: req.cursor,
      allRefs: req.allRefs,
    })
  })

  ipc.handle('git:ignored-entries', async (req) => {
    const project = deps.getProject()
    const [root, directory] = await Promise.all([
      ipc.authority.projectPath(req.root, project.root, project.host),
      ipc.authority.projectPath(req.directory, project.root, project.host),
    ])
    return deps.gitWorker.request(GIT_IGNORED_ENTRIES_TYPE, {
      root,
      directory,
      names: req.names,
    })
  })

  ipc.handle('git:commit-detail', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_COMMIT_DETAIL_TYPE, { root, hash: req.hash })
  })

  ipc.handle('git:blame', async (req) => {
    const { root, host } = deps.getProject()
    const path = await ipc.authority.projectPath(req.path, root, host)
    return deps.gitWorker.request(GIT_BLAME_TYPE, { root, path })
  })

  ipc.handle('git:branches', async (req) => {
    const project = deps.getProject()
    const root = await ipc.authority.projectPath(req.root, project.root, project.host)
    return deps.gitWorker.request(GIT_BRANCHES_TYPE, { root })
  })

  ipc.handle('git:fetch', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.fetchGit(root)
    }),
  )

  ipc.handle('git:pull', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.pullGit(root)
    }),
  )

  ipc.handle('git:switch-branch', (req) =>
    operationResult(async () => {
      const project = deps.getProject()
      const root = await ipc.authority.projectPath(req.root, project.root, project.host)
      return deps.switchGitBranch(root, req.branch)
    }),
  )
}
