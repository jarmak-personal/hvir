import { app } from 'electron'

import { configureApplicationRuntime } from './application-runtime-policy'

/** The compiled application identity and storage authority, selected during module load. */
export const applicationRuntime = configureApplicationRuntime(app, __HVIR_BUILD_CHANNEL__)
