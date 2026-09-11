import type { WorkbenchRuntime } from '../workbench-runtime'
import { GIT_IGNORED_PATHS_TYPE, type GitWorkerProtocol } from '../../shared'
import type { WorkerClient } from '../worker-host'
import { FilenameSearchCoordinator } from './filename-search-coordinator'

export function createFilenameSearchCoordinator(
  gitWorker: WorkerClient<GitWorkerProtocol>,
): FilenameSearchCoordinator {
  return new FilenameSearchCoordinator({
    async ignoredPaths(root, paths) {
      const response = await gitWorker.request(GIT_IGNORED_PATHS_TYPE, {
        root,
        paths,
      })
      return new Set(response.ignoredPaths)
    },
  })
}

export function installFilenameSearch(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  gitWorker: WorkerClient<GitWorkerProtocol>,
): FilenameSearchCoordinator {
  return runtime.own(
    'filename search',
    createFilenameSearchCoordinator(gitWorker),
    (search) => search.dispose(),
  )
}
