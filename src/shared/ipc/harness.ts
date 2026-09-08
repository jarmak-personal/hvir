import { invoke, type IpcFeatureContract } from '../ipc-contract'
import { type ComposerSubmitMode } from '../composer-submit'
import { type HostPath } from '../host-path'
import {
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HarnessProfileProbe,
} from '../harness-provider'
import {
  type HarnessCommandPreview,
  type HarnessPathGrant,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessProfileInput,
} from '../harness-profile'

export interface HarnessProfilesRequest {
  readonly root: HostPath
}

export interface HarnessProbeProfilesRequest {
  readonly root: HostPath
  readonly profileIds?: readonly HarnessProfileId[]
  readonly force?: boolean
}

export interface HarnessProbeTemplatesRequest {
  readonly root: HostPath
  readonly providerIds?: readonly HarnessProviderId[]
  readonly force?: boolean
}

export interface MaterializeHarnessProfilesRequest {
  readonly root: HostPath
  readonly providerIds: readonly HarnessProviderId[]
}

interface SaveHarnessProfileRequestBase {
  readonly root: HostPath
  readonly input: HarnessProfileInput
}

export type SaveHarnessProfileRequest = SaveHarnessProfileRequestBase &
  (
    | {
        readonly id?: never
        readonly expectedLaunchRevision?: never
        readonly expectedMetadataRevision?: never
      }
    | {
        readonly id: HarnessProfileId
        readonly expectedLaunchRevision: number
        readonly expectedMetadataRevision: number
      }
  )

export interface HarnessProfileRequest {
  readonly id: HarnessProfileId
}

interface HarnessPreviewRequestBase {
  readonly root: HostPath
  readonly cwd: HostPath
  readonly mode: 'fresh' | 'resume'
  readonly harnessSessionId?: string
}

export type HarnessPreviewRequest = HarnessPreviewRequestBase &
  (
    | {
        readonly profileId: HarnessProfileId
        readonly launchRevision: number
        readonly input?: never
      }
    | {
        readonly input: HarnessProfileInput
        readonly profileId?: HarnessProfileId
        readonly launchRevision?: never
      }
  )

export interface AuthorizeHarnessPathRequest {
  readonly root: HostPath
  readonly path: HostPath
}

export type ConfigureComposerSubmitRequest =
  | {
      readonly scope: 'host'
      readonly hostId: string
      readonly mode: ComposerSubmitMode
    }
  | {
      readonly scope: 'all-connected'
      readonly mode: ComposerSubmitMode
      readonly previousMode: ComposerSubmitMode
    }

export const harnessIpc = {
  invoke: {
    'harness:catalog': invoke<void, readonly HarnessProviderDescriptor[]>(),
    'harness:profiles': invoke<HarnessProfilesRequest, readonly HarnessProfile[]>(),
    'harness:probe-snapshot': invoke<
      HarnessProfilesRequest,
      readonly HarnessProfileProbe[]
    >(),
    'harness:probe-profiles': invoke<
      HarnessProbeProfilesRequest,
      readonly HarnessProfileProbe[]
    >(),
    'harness:probe-templates': invoke<
      HarnessProbeTemplatesRequest,
      readonly HarnessProfileProbe[]
    >(),
    'harness:profile-materialize': invoke<
      MaterializeHarnessProfilesRequest,
      readonly HarnessProfile[]
    >(),
    'harness:profile-save': invoke<SaveHarnessProfileRequest, HarnessProfile>(),
    'harness:profile-duplicate': invoke<HarnessProfileRequest, HarnessProfile>(),
    'harness:profile-delete': invoke<HarnessProfileRequest, void>(),
    'harness:preview': invoke<HarnessPreviewRequest, HarnessCommandPreview>(),
    'harness:authorize-path': invoke<AuthorizeHarnessPathRequest, HarnessPathGrant>(),
    'harness:configure-composer-submit': invoke<ConfigureComposerSubmitRequest, void>(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
