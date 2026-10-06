import { createContext, useContext, useEffect } from 'react'
import type { ExtensionSessionContext } from '../../../shared/extensions/contract'
import type {
  ExtensionContributionState,
  ExtensionDemand,
  ExtensionSurfaceRequest,
  ExtensionView,
} from '../../../shared/extensions/workbench'

export interface Contributions {
  readonly topActive: boolean
  readonly obscured: boolean
  readonly selectedTop?: ExtensionView
  readonly close: (id: string) => void
  readonly closeTop: (id: string) => void
  readonly selectTop: (view: ExtensionView) => void
  readonly selectViewer: (id: string) => void
  readonly focusLanding: (view: ExtensionView) => void
  readonly retireLandingFocus: (id: string) => void
  readonly landingFocusId?: string
  readonly views: readonly ExtensionView[]
  readonly state: readonly ExtensionContributionState[]
  readonly terminalIds: Readonly<Record<string, string>>
  readonly sessions: readonly ExtensionSessionContext[]
  readonly workspaceId?: string
  readonly foreground: boolean
  readonly open: (
    id: string,
    view: string,
    context: ExtensionSurfaceRequest,
  ) => Promise<ExtensionView>
  readonly demand: (key: string, entries: readonly ExtensionDemand[]) => () => void
}
export const ExtensionContributionContext = createContext<Contributions | undefined>(
  undefined,
)
export function useExtensionContributions(): Contributions | undefined {
  return useContext(ExtensionContributionContext)
}

export function useContributionDemand(
  key: string,
  entries: readonly ExtensionDemand[],
): void {
  const publish = useExtensionContributions()?.demand
  const value = JSON.stringify(entries)
  useEffect(
    () => publish?.(key, JSON.parse(value) as ExtensionDemand[]),
    [publish, key, value],
  )
}
