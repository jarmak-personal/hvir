import type { ExtensionContext, ExtensionItemValue, ExtensionManifest } from './contract'

export interface ExtensionInstallation {
  readonly source: string
  readonly sourceIdentity?: string
  readonly kind?: 'directory' | 'zip' | 'development'
  readonly retainedIdentity?: boolean
  readonly removalPending?: boolean
  readonly installationId?: string
  readonly manifest?: ExtensionManifest
  readonly revision?: string
  readonly acceptedRevision?: string
  readonly warnings: readonly string[]
  readonly enabled: boolean
  readonly error?: string
}

export interface ExtensionPlatformState {
  readonly writable: boolean
  readonly explanation?: string
  readonly installations: readonly ExtensionInstallation[]
}

export interface ExtensionView {
  readonly id: string
  readonly installationId: string
  readonly contributionId: string
  readonly extensionName: string
  readonly title: string
  readonly partition: string
  readonly url: string
  readonly context?: ExtensionContext
  readonly role?: 'view' | 'updater'
  readonly failure?: string
}

export interface ExtensionContributionState {
  readonly installationId: string
  readonly extensionName: string
  readonly manifest: ExtensionManifest
  readonly values: readonly ExtensionItemValue[]
  readonly error?: string
}
export interface ExtensionSurfaceRequest {
  readonly surface: 'viewer' | 'left' | 'top' | 'popup'
  readonly workspaceId?: string
  readonly sessionId?: string
}
export interface ExtensionDemand {
  readonly installationId: string
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly contributionId: string
  readonly surface: 'left' | 'top' | 'rail'
}
