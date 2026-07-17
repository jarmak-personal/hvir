import type { HarnessProviderId } from './harness-provider'
import type { HostPath } from './host-path'

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/
const BINDING_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/
const ENVIRONMENT_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/

declare const harnessProfileIdBrand: unique symbol

export type HarnessProfileId = string & {
  readonly [harnessProfileIdBrand]: 'HarnessProfileId'
}

export type HarnessLaunchRisk = 'standard' | 'elevated' | 'unclassified'

export type HarnessProfileScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly projectRoot: HostPath }

export type HarnessProfileExecutable =
  | { readonly kind: 'provider-default' }
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'path'; readonly path: HostPath; readonly grantId?: string }

export type HarnessArgumentPart =
  | { readonly kind: 'literal'; readonly value: string }
  | {
      readonly kind: 'path'
      readonly source: 'projectRoot' | 'workspaceRoot' | 'binding'
      readonly binding?: string
    }

export interface HarnessProfileArgument {
  readonly parts: readonly HarnessArgumentPart[]
}

export type HarnessEnvironmentBinding =
  | {
      readonly kind: 'literal'
      readonly name: string
      readonly value: string
    }
  | {
      readonly kind: 'reference'
      readonly name: string
      readonly source: 'host' | 'local-forward'
      readonly sourceName: string
    }
  | { readonly kind: 'unset'; readonly name: string }

export interface HarnessPathBinding {
  readonly name: string
  readonly path: HostPath
  /** Main-issued authorization for paths outside the registered project. */
  readonly grantId?: string
}

export interface HarnessPathGrant {
  readonly id: string
  readonly path: HostPath
}

export interface HarnessProfileInput {
  readonly displayName: string
  readonly description?: string
  readonly providerId: HarnessProviderId
  readonly scope: HarnessProfileScope
  readonly executable: HarnessProfileExecutable
  readonly args: readonly HarnessProfileArgument[]
  readonly environment: readonly HarnessEnvironmentBinding[]
  readonly pathBindings: readonly HarnessPathBinding[]
  readonly order: number
}

export interface HarnessProfile extends HarnessProfileInput {
  readonly id: HarnessProfileId
  readonly launchRevision: number
  readonly metadataRevision: number
  readonly providerContractVersion: number
  readonly builtIn: boolean
  readonly risk: HarnessLaunchRisk
}

export interface HarnessCommandPreviewEnvironment {
  readonly name: string
  readonly operation: 'set' | 'reference' | 'unset'
  readonly displayValue?: string
  readonly redacted: boolean
}

export interface HarnessCommandPreview {
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
  readonly providerId: HarnessProviderId
  readonly mode: 'fresh' | 'resume'
  readonly executable: string
  readonly args: readonly string[]
  readonly environment: readonly HarnessCommandPreviewEnvironment[]
  readonly command: string
  readonly risk: HarnessLaunchRisk
  readonly artifactIdentity: string
}

export function isHarnessProfileId(value: unknown): value is HarnessProfileId {
  return typeof value === 'string' && PROFILE_ID.test(value)
}

export function asHarnessProfileId(value: string): HarnessProfileId {
  if (!isHarnessProfileId(value)) {
    throw new Error(`Invalid harness profile id '${value}'`)
  }
  return value
}

export function isHarnessBindingName(value: unknown): value is string {
  return typeof value === 'string' && BINDING_NAME.test(value)
}

export function isHarnessEnvironmentName(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_NAME.test(value)
}
