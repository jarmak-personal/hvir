import { createContext } from 'react'
import type { HostPath } from '../../../shared'

/** Carries one temporary tab's origin to its existing rendering effects. */
export const TemporaryDocumentWorkspace = createContext<HostPath | undefined>(undefined)
