import type { ExtensionManifest } from './contract'

export interface ExtensionInstallation {
  readonly source: string
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
  readonly failure?: string
}
