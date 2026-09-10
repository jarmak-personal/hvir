import { createContext } from 'react'
import type { HostPath } from '../../../shared'

/** Carries one outside-project tab's origin to its existing rendering effects. */
export const ExternalDocumentWorkspace = createContext<HostPath | undefined>(undefined)
