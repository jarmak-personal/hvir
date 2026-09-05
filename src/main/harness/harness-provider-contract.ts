/** Main-owned, host-qualified harness capability ports; no bundled implementations. */

import type {
  ComposerSubmitMode,
  HarnessContextPresentation,
  HarnessContextPressurePolicy,
  HarnessModifiedKeyProtocol,
  HarnessProfile,
  HarnessProfileId,
  HarnessLaunchMode,
  HarnessProviderCapabilities,
  HarnessProviderId,
  HarnessSessionIdentity,
  HarnessTelemetry,
  HarnessUsageCounters,
  HarnessUsageUnavailableReason,
  HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host/project-host'

export interface HarnessLaunchContext {
  /** Exact harness id for pre-assigned launches and resume commands. */
  readonly sessionId: string
  /** Exact registered parent identity for a provider-derived fork. */
  readonly parentSessionId?: string
  readonly cwd: HostPath
  readonly cols?: number
  readonly rows?: number
  /** Interactive shell resolved by the owning ProjectHost. */
  readonly defaultShell: string
  readonly composerSubmitMode?: ComposerSubmitMode
  readonly effectiveCapabilities?: HarnessProviderCapabilities
}

export interface HarnessLaunchSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Record<string, string>
  /** Resolve the command in the user's login-interactive shell environment. */
  readonly shellEnvironment?: boolean
}

export interface HarnessComposerConfiguration {
  configure(host: ProjectHost, mode: ComposerSubmitMode): Promise<void>
}

/** Exact native-composer behavior approved for an explicit remote image-paste gesture. */
export interface HarnessRemoteImagePasteContract {
  /** Increment when path insertion or acknowledgement semantics change. */
  readonly revision: number
  /** Produce one atomic terminal paste; never submit the composer. */
  terminalInput(path: HostPath): string
}

/** Exact native-composer behavior approved only for prepared document review. */
export interface HarnessDocumentReviewInsertContract {
  /** Increment whenever the atomic composer framing semantics change. */
  readonly revision: number
  /** Admit insertion only for an exact provider-owned launch profile. */
  supportsLaunch(launch: HarnessDocumentReviewInsertLaunch): boolean
  /** Frame one immutable body as one bracketed paste; never submit it. */
  terminalInput(body: string): string
}

export interface HarnessDocumentReviewInsertLaunch {
  readonly profile: Pick<
    HarnessProfile,
    | 'providerId'
    | 'providerContractVersion'
    | 'executable'
    | 'args'
    | 'environment'
    | 'pathBindings'
  >
  readonly effectiveCapabilities: HarnessProviderCapabilities
}

export interface HarnessDocumentReviewSendNowLaunch extends HarnessDocumentReviewInsertLaunch {
  readonly composerSubmitMode: ComposerSubmitMode
}

/** Complete provider-owned composer framing and submission for one exact launch. */
export interface HarnessDocumentReviewSendNowContract {
  /** Increment whenever launch eligibility, framing, or submission bytes change. */
  readonly revision: number
  supportsLaunch(launch: HarnessDocumentReviewSendNowLaunch): boolean
  /** Return one bracketed-paste-plus-submit transport for one supervisor write. */
  terminalInput(body: string, launch: HarnessDocumentReviewSendNowLaunch): string
}

export type HarnessSessionDiscoveryResult =
  | {
      readonly status: 'identified'
      readonly sessionId: string
      /** Provider-private state associated with the exact persisted session. */
      readonly sessionData?: unknown
    }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'unavailable' }

export interface HarnessSessionDiscoveryContext {
  readonly cwd: HostPath
  readonly launchedAtMs: number
  /** Start of this bounded attempt; later input may re-arm discovery. */
  readonly discoveryStartedAtMs?: number
  readonly signal: AbortSignal
  readonly artifact: HarnessArtifactContext
}

export interface HarnessArtifactContext {
  readonly identity: string
  readonly environment: Readonly<Record<string, string>>
  readonly unsetEnvironment: readonly string[]
}

export interface HarnessSessionDiscovery {
  /** Capture the persisted-session baseline immediately before launch. */
  snapshot(host: ProjectHost, artifact: HarnessArtifactContext): Promise<unknown>
  /** Identify exactly one session created after the baseline, or fail closed. */
  identify(
    host: ProjectHost,
    snapshot: unknown,
    context: HarnessSessionDiscoveryContext,
  ): Promise<HarnessSessionDiscoveryResult>
}

export interface HarnessTelemetryContext {
  /** Stable hvir PTY identity used to route multiplexed provider telemetry. */
  readonly subscriptionId: string
  readonly sessionId: string
  readonly cwd: HostPath
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
  readonly signal: AbortSignal
  readonly emit: (telemetry: HarnessTelemetry | undefined) => void
  /** Sticky terminal-scoped signal; the observer still discards the mismatched record. */
  readonly identityDiverged?: () => void
}

export interface HarnessTelemetryObserver {
  observe(
    host: ProjectHost,
    context: HarnessTelemetryContext,
  ): Disposer | Promise<Disposer>
}

export type HarnessResumeAvailability = 'available' | 'missing' | 'unknown'

export interface HarnessResumeValidationContext {
  readonly sessionId: string
  readonly cwd: HostPath
  readonly artifact: HarnessArtifactContext
}

export interface HarnessResumeValidation {
  availability(
    host: ProjectHost,
    context: HarnessResumeValidationContext,
  ): Promise<HarnessResumeAvailability>
}

export interface HarnessManifest {
  readonly id: HarnessProviderId
  readonly displayName: string
  /** Product-neutral presentation kind; provider behavior stays behind this registry. */
  readonly sessionKind: 'agent' | 'shell'
  readonly default?: boolean
  readonly contextPresentation: HarnessContextPresentation
  readonly contextPressure?: HarnessContextPressurePolicy
  /** Opt in only when the harness understands a specific modified-key wire format. */
  readonly modifiedKeyProtocol?: Exclude<HarnessModifiedKeyProtocol, 'none'>
  /** Compatibility shim for harness keymaps that cannot bind Command/Super. */
  readonly metaEnterAliasesControl?: boolean
}

export interface HarnessDefaultProfile {
  readonly id: HarnessProfileId
  readonly displayName: string
  readonly description: string
}

export interface HarnessProfileContract {
  /** Increment when launch composition changes. */
  readonly version: number
  readonly defaultProfile?: HarnessDefaultProfile
  readonly reservedArguments: readonly string[]
  readonly reservedEnvironmentKeys: readonly string[]
  readonly artifactEnvironmentKeys: readonly string[]
  readonly artifactExecutable: boolean
  readonly artifactPathBindings: readonly string[]
  applyArgs(
    mode: HarnessLaunchMode,
    providerArgs: readonly string[],
    profileArgs: readonly string[],
  ): readonly string[]
}

export interface HarnessProbeContract {
  /** Omit to check executable resolution without invoking the harness. */
  readonly versionArgs?: readonly string[]
  /** Optional bounded help/capability surface, parsed only by this provider. */
  readonly capabilityArgs?: readonly string[]
  /** Extract one bounded human-readable version or fail closed. */
  parseVersion(output: string): string | undefined
  effectiveCapabilities(
    version: string | undefined,
    capabilityOutput?: string,
  ): HarnessProviderCapabilities
}

export interface HarnessProvider {
  readonly manifest: HarnessManifest
  readonly profile: HarnessProfileContract
  /** Whether the harness can deterministically resume a prior session id. */
  readonly supportsResume: boolean
  /** How a fresh launch's harness-owned session id becomes known. */
  readonly sessionIdentity: HarnessSessionIdentity
  /** Present only when `sessionIdentity` is `discovered`. */
  readonly sessionDiscovery?: HarnessSessionDiscovery
  /** Optional structured, read-only operational state for this harness. */
  readonly telemetry?: HarnessTelemetryObserver
  /** Demand-scoped cumulative usage observation for an exact live session. */
  readonly usageTelemetry?: HarnessTelemetryObserver
  /** Content-free cumulative counters for bounded lifecycle phase snapshots. */
  readonly usageSnapshots?: HarnessUsageSnapshotProvider
  /** Fail-closed check that the exact provider artifact can actually resume. */
  readonly resumeValidation?: HarnessResumeValidation
  readonly probe: HarnessProbeContract
  readonly composerConfiguration?: HarnessComposerConfiguration
  readonly remoteImagePaste?: HarnessRemoteImagePasteContract
  readonly documentReviewInsert?: HarnessDocumentReviewInsertContract
  readonly documentReviewSendNow?: HarnessDocumentReviewSendNowContract

  /** Command to start a fresh session. */
  launch(ctx: HarnessLaunchContext): HarnessLaunchSpec
  /** Command to resume `ctx.sessionId`. */
  resume(ctx: HarnessLaunchContext): HarnessLaunchSpec
  /** Command to derive `ctx.sessionId` from the exact `ctx.parentSessionId`. */
  fork?(ctx: HarnessLaunchContext): HarnessLaunchSpec
}

export interface HarnessUsageSnapshotContext {
  readonly sessionId: string
  readonly cwd: HostPath
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
  readonly signal: AbortSignal
}

export interface HarnessUsageRoute {
  readonly modelId?: string
  readonly reasoningEffort?: string
}

export interface HarnessUsageTiming {
  readonly modelOrApiMilliseconds?: number
}

export type HarnessUsageSnapshot =
  | {
      readonly version: 1
      readonly status: 'available'
      readonly providerId: HarnessProviderId
      readonly observedAt: number
      readonly route: HarnessUsageRoute
      readonly counters: HarnessUsageCounters
      readonly timing: HarnessUsageTiming
    }
  | {
      readonly version: 1
      readonly status: 'unavailable'
      readonly providerId: HarnessProviderId
      readonly observedAt: number
      readonly reason: HarnessUsageUnavailableReason
    }

export interface HarnessUsageSnapshotProvider {
  snapshot(
    host: ProjectHost,
    context: HarnessUsageSnapshotContext,
  ): Promise<HarnessUsageSnapshot>
}
