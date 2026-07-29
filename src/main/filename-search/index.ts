import { GIT_IGNORED_ENTRIES_TYPE, type GitWorkerProtocol } from '../../shared'
import type { WorkerClient } from '../worker-host'
import { FilenameSearchCoordinator } from './filename-search-coordinator'

export function createFilenameSearchCoordinator(
  gitWorker: WorkerClient<GitWorkerProtocol>,
): FilenameSearchCoordinator {
  return new FilenameSearchCoordinator({
    async ignoredEntries(root, directory, names) {
      const response = await gitWorker.request(GIT_IGNORED_ENTRIES_TYPE, {
        root,
        directory,
        names,
      })
      return new Set(response.ignoredNames)
    },
  })
}
