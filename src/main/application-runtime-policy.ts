import { join, isAbsolute } from 'node:path'

import type { ApplicationBuildChannel } from '../shared'

export const SSH_ACCEPTANCE_USER_DATA_DIRECTORY = 'hvir-ssh-acceptance'

export interface ApplicationRuntime {
  readonly buildChannel: ApplicationBuildChannel
  readonly userDataRoot: string
}

interface ElectronApplicationPaths {
  getPath(name: 'appData' | 'userData'): string
  setPath(name: 'userData', path: string): void
}

/** Selects the one application-state authority before any storage owner is built. */
export function configureApplicationRuntime(
  paths: ElectronApplicationPaths,
  buildChannel: ApplicationBuildChannel,
  prepareUserDataRoot: (path: string) => void,
  requestedUserDataRoot?: string,
): ApplicationRuntime {
  if (requestedUserDataRoot !== undefined) {
    if (!isAbsolute(requestedUserDataRoot))
      throw new Error('hvir user-data directory must be absolute')
    prepareUserDataRoot(requestedUserDataRoot)
    paths.setPath('userData', requestedUserDataRoot)
    return { buildChannel, userDataRoot: requestedUserDataRoot }
  }
  if (buildChannel !== 'ssh-acceptance') {
    return { buildChannel, userDataRoot: paths.getPath('userData') }
  }
  const userDataRoot = join(paths.getPath('appData'), SSH_ACCEPTANCE_USER_DATA_DIRECTORY)
  prepareUserDataRoot(userDataRoot)
  paths.setPath('userData', userDataRoot)
  return { buildChannel, userDataRoot }
}

/** Selects the existing project launch argument for production and smoke composition. */
export function projectRootArgument(): string | undefined {
  const fromFlag = process.argv.find((arg) => arg.startsWith('--project-root='))
  return fromFlag?.slice('--project-root='.length) || process.env.HVIR_PROJECT_ROOT
}
