import { join } from 'node:path'
import { app } from 'electron'

import { localPath } from '../shared'
import { configureApplicationRuntime } from './application-runtime-policy'
import { LocalHost } from './project-host/local-host'

/** The compiled application identity and storage authority, selected during module load. */
export const applicationRuntime = configureApplicationRuntime(
  app,
  __HVIR_BUILD_CHANNEL__,
  (path) => LocalHost.ensureBootstrapDirectory(localPath(path)),
)

/** Resolves one application-owned state file beneath the selected runtime root. */
export function applicationUserDataPath(name: string): string {
  return join(applicationRuntime.userDataRoot, name)
}
