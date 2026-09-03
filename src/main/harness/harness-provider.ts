/**
 * Main-owned harness-provider seam (ADR-006/012).
 *
 * Providers own every harness-specific launch, recovery, title, and telemetry
 * convention. The renderer receives only the bounded catalog descriptors.
 */

import {
  asHarnessProviderId,
  asHarnessProfileId,
  type ComposerSubmitMode,
  type HarnessContextPresentation,
  type HarnessContextPressurePolicy,
  type HarnessModifiedKeyProtocol,
  type HarnessProfile,
  type HarnessProfileId,
  type HarnessLaunchMode,
  type HarnessProviderCapabilities,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HarnessSessionIdentity,
  type HarnessTelemetry,
  type HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessUsageSnapshotProvider } from './harness-usage'
import { configureClaudeComposerSubmit } from './claude-keybindings'
import {
  observeClaudeContext,
  observeClaudeUsage,
  snapshotClaudeUsage,
} from './claude-context-telemetry'
import { claudeResumeAvailability } from './claude-session-recovery'
import {
  observeCodexContext,
  observeCodexUsage,
  snapshotCodexUsage,
} from './codex-context-telemetry'
import { codexSessionDiscovery } from './codex-session-discovery'
import { piProvider } from './providers/pi'
import { geminiProvider } from './providers/gemini'
import { githubCopilotProvider } from './providers/github-copilot'
import { cursorProvider } from './providers/cursor'

const CODEX_THREAD_TITLE_CONFIG = 'tui.terminal_title=["thread-title"]'
const CODEX_SUBCOMMAND_BY_LAUNCH_MODE: Readonly<
  Partial<Record<HarnessLaunchMode, 'resume' | 'fork'>>
> = {
  resume: 'resume',
  fork: 'fork',
}
const CLAUDE_CONTEXT_PRESSURE: HarnessContextPressurePolicy = {
  assumedWindowTokens: 1_000_000,
  warningPercent: 20,
  criticalPercent: 40,
}

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

export function harnessProviderCapabilities(
  provider: HarnessProvider,
): HarnessProviderCapabilities {
  return {
    sessionIdentity: provider.sessionIdentity,
    exactResume: provider.supportsResume,
    contextPresentation: provider.manifest.contextPresentation,
    contextPressure: provider.manifest.contextPressure,
  }
}

/**
 * A plain login shell — no session id, no resume. The provider every host
 * supports. "Resume" starts a new shell.
 */
export const plainShellProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('plain-shell'),
    displayName: 'Shell',
    sessionKind: 'shell',
    default: true,
    contextPresentation: 'none',
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('plain-shell-default'),
      displayName: 'Shell',
      description: 'The default interactive shell on this host.',
    },
    reservedArguments: [],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: staticProbe('none', false, 'none'),

  launch(ctx): HarnessLaunchSpec {
    return { file: ctx.defaultShell, args: ['-l'] }
  },

  resume(ctx): HarnessLaunchSpec {
    return this.launch(ctx)
  },
}

const claudeCodeReviewInsert = documentReviewInsertContract(() => claudeCodeProvider)

export const claudeCodeProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('claude-code'),
    displayName: 'Claude Code',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
    contextPressure: CLAUDE_CONTEXT_PRESSURE,
    modifiedKeyProtocol: 'modify-other-keys',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 3,
    defaultProfile: {
      id: asHarnessProfileId('claude-code-default'),
      displayName: 'Claude Code',
      description: 'Claude Code with exact hvir-managed session recovery.',
    },
    reservedArguments: ['--session-id', '--resume', '--continue', '--fork-session'],
    reservedEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactExecutable: true,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
  },
  supportsResume: true,
  sessionIdentity: 'preassigned',
  telemetry: { observe: observeClaudeContext },
  usageTelemetry: { observe: observeClaudeUsage },
  usageSnapshots: { snapshot: snapshotClaudeUsage },
  resumeValidation: { availability: claudeResumeAvailability },
  probe: versionProbe('preassigned', true, 'pressure', {
    contextPressure: CLAUDE_CONTEXT_PRESSURE,
    reviewInsert: claudeCodeReviewInsert,
    supportsExactForkVersion: supportsClaudeExactForkVersion,
  }),
  composerConfiguration: { configure: configureClaudeComposerSubmit },
  remoteImagePaste: pathImagePasteContract(),
  documentReviewInsert: claudeCodeReviewInsert,

  launch(ctx): HarnessLaunchSpec {
    return {
      file: 'claude',
      args: ['--session-id', ctx.sessionId],
      shellEnvironment: true,
    }
  },

  resume(ctx): HarnessLaunchSpec {
    return {
      file: 'claude',
      args: ['--resume', ctx.sessionId],
      shellEnvironment: true,
    }
  },

  fork(ctx): HarnessLaunchSpec {
    if (!ctx.parentSessionId) throw new Error('Claude Code fork requires an exact parent id')
    return {
      file: 'claude',
      args: [
        '--session-id',
        ctx.sessionId,
        '--resume',
        ctx.parentSessionId,
        '--fork-session',
      ],
      shellEnvironment: true,
    }
  },
}

const codexReviewInsert = documentReviewInsertContract(
  () => codexProvider,
  supportsCodexDocumentReviewProfile,
)
const codexReviewSendNow = codexDocumentReviewSendNowContract(codexReviewInsert)

export const codexProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('codex'),
    displayName: 'Codex',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 2,
    defaultProfile: {
      id: asHarnessProfileId('codex-default'),
      displayName: 'Codex',
      description: 'Codex with exact rollout discovery and recovery.',
    },
    reservedArguments: ['resume', 'fork'],
    reservedEnvironmentKeys: ['CODEX_HOME'],
    artifactEnvironmentKeys: ['CODEX_HOME'],
    artifactExecutable: true,
    artifactPathBindings: [],
    applyArgs: (mode, providerArgs, profileArgs) => {
      const subcommand = CODEX_SUBCOMMAND_BY_LAUNCH_MODE[mode]
      if (!subcommand) return [...providerArgs, ...profileArgs]
      const subcommandAt = providerArgs.indexOf(subcommand)
      return subcommandAt < 0
        ? [...providerArgs, ...profileArgs]
        : [
            ...providerArgs.slice(0, subcommandAt),
            ...profileArgs,
            ...providerArgs.slice(subcommandAt),
          ]
    },
  },
  supportsResume: true,
  sessionIdentity: 'discovered',
  sessionDiscovery: codexSessionDiscovery,
  telemetry: { observe: observeCodexContext },
  usageTelemetry: { observe: observeCodexUsage },
  usageSnapshots: { snapshot: snapshotCodexUsage },
  probe: versionProbe('discovered', true, 'pressure', {
    reviewInsert: codexReviewInsert,
    reviewSendNow: codexReviewSendNow,
    supportsReviewSendNowVersion: supportsCodexReviewSendNowVersion,
    supportsExactForkVersion: supportsCodexExactForkVersion,
  }),
  remoteImagePaste: pathImagePasteContract(),
  documentReviewInsert: codexReviewInsert,
  documentReviewSendNow: codexReviewSendNow,

  launch(ctx): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: ['--config', CODEX_THREAD_TITLE_CONFIG, ...codexComposerArgs(ctx)],
      shellEnvironment: true,
    }
  },

  resume(ctx): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: [
        '--config',
        CODEX_THREAD_TITLE_CONFIG,
        ...codexComposerArgs(ctx),
        'resume',
        ctx.sessionId,
      ],
      shellEnvironment: true,
    }
  },

  fork(ctx): HarnessLaunchSpec {
    if (!ctx.parentSessionId) throw new Error('Codex fork requires an exact parent id')
    return {
      file: 'codex',
      args: [
        '--config',
        CODEX_THREAD_TITLE_CONFIG,
        ...codexComposerArgs(ctx),
        'fork',
        ctx.parentSessionId,
      ],
      shellEnvironment: true,
    }
  },
}

export const customCommandProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('custom'),
    displayName: 'Custom',
    sessionKind: 'shell',
    contextPresentation: 'none',
  },
  profile: {
    version: 1,
    reservedArguments: [],
    reservedEnvironmentKeys: [],
    artifactEnvironmentKeys: [],
    artifactExecutable: false,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: staticProbe('none', false, 'none'),
  launch: () => ({ file: 'custom', args: [] }),
  resume: () => ({ file: 'custom', args: [] }),
}

export class HarnessProviderRegistry {
  private readonly providers = new Map<HarnessProviderId, HarnessProvider>()

  constructor(providers: readonly HarnessProvider[]) {
    for (const provider of providers) this.register(provider)
    const defaults = [...this.providers.values()].filter(
      ({ manifest }) => manifest.default,
    )
    if (defaults.length !== 1) {
      throw new Error('Harness provider registry requires exactly one default provider')
    }
  }

  get(id: string): HarnessProvider {
    const provider = this.providers.get(asHarnessProviderId(id))
    if (!provider) throw new Error(`Unknown harness provider '${id}'`)
    return provider
  }

  catalog(): readonly HarnessProviderDescriptor[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.manifest.id,
      displayName: provider.manifest.displayName,
      default: provider.manifest.default === true,
      ...(provider.fork ? { exactForkLaunch: true as const } : {}),
      capabilities: harnessProviderCapabilities(provider),
      terminalInput: {
        modifiedKeyProtocol: provider.manifest.modifiedKeyProtocol ?? 'none',
        metaEnterAliasesControl: provider.manifest.metaEnterAliasesControl === true,
      },
      profileTemplate: provider.profile.defaultProfile
        ? {
            displayName: provider.profile.defaultProfile.displayName,
            description: provider.profile.defaultProfile.description,
          }
        : undefined,
      profileGuidance: {
        reservedArguments: provider.profile.reservedArguments,
      },
    }))
  }

  all(): readonly HarnessProvider[] {
    return [...this.providers.values()]
  }

  private register(provider: HarnessProvider): void {
    const { id, displayName } = provider.manifest
    if (this.providers.has(id)) {
      throw new Error(`Duplicate harness provider '${id}'`)
    }
    if (displayName.trim().length === 0 || displayName.length > 80) {
      throw new Error(`Invalid display name for harness provider '${id}'`)
    }
    if (
      provider.sessionIdentity === 'discovered' &&
      provider.sessionDiscovery === undefined
    ) {
      throw new Error(`Harness provider '${id}' is missing session discovery`)
    }
    if (
      provider.sessionIdentity !== 'discovered' &&
      provider.sessionDiscovery !== undefined
    ) {
      throw new Error(`Harness provider '${id}' has unexpected session discovery`)
    }
    if (provider.resumeValidation && !provider.supportsResume) {
      throw new Error(`Harness provider '${id}' validates resume without supporting it`)
    }
    if (
      (provider.sessionDiscovery || provider.telemetry || provider.usageTelemetry) &&
      provider.profile.reservedEnvironmentKeys.some(
        (key) => !provider.profile.artifactEnvironmentKeys.includes(key),
      )
    ) {
      throw new Error(
        `Harness provider '${id}' has a reserved environment key without artifact semantics`,
      )
    }
    this.providers.set(id, provider)
  }
}

export const harnessProviders = new HarnessProviderRegistry([
  plainShellProvider,
  claudeCodeProvider,
  codexProvider,
  piProvider,
  geminiProvider,
  githubCopilotProvider,
  cursorProvider,
  customCommandProvider,
])

export function harnessProvider(id: string): HarnessProvider {
  return harnessProviders.get(id)
}

/** Trusted capabilities bound to one successful provider launch. */
export function harnessLaunchCapabilities(
  provider: HarnessProvider,
  launch?: {
    readonly profile: HarnessProfile
    readonly composerSubmitMode: ComposerSubmitMode
    readonly probedCapabilities?: HarnessProviderCapabilities
  },
): HarnessProviderCapabilities {
  const probed =
    launch?.probedCapabilities ?? provider.probe.effectiveCapabilities(undefined)
  const insert = provider.documentReviewInsert
  let base: HarnessProviderCapabilities = {
    sessionIdentity: probed.sessionIdentity,
    exactResume: probed.exactResume,
    contextPresentation: probed.contextPresentation,
    ...(probed.exactFork === true ? { exactFork: true as const } : {}),
  }
  if (launch && insert && insert.revision === probed.reviewInsertContractRevision) {
    const candidate = { ...base, reviewInsertContractRevision: insert.revision }
    if (
      insert.supportsLaunch({
        profile: launch.profile,
        effectiveCapabilities: candidate,
      })
    ) {
      base = candidate
    }
  }
  const sendNow = provider.documentReviewSendNow
  if (!launch || !sendNow) return base
  if (sendNow.revision !== probed.reviewSendNowContractRevision) return base
  const effective = { ...base, reviewSendNowContractRevision: sendNow.revision }
  return sendNow.supportsLaunch({
    profile: launch.profile,
    composerSubmitMode: launch.composerSubmitMode,
    effectiveCapabilities: effective,
  })
    ? effective
    : base
}

export function harnessProviderCatalog(): readonly HarnessProviderDescriptor[] {
  return harnessProviders.catalog()
}

export async function configureHarnessComposerSubmit(
  host: ProjectHost,
  mode: ComposerSubmitMode,
): Promise<void> {
  for (const provider of harnessProviders.all()) {
    await provider.composerConfiguration?.configure(host, mode)
  }
}

export type HarnessLaunchDecision =
  | { readonly outcome: 'launch'; readonly mode: HarnessLaunchMode }
  | { readonly outcome: 'resume-unavailable'; readonly reason: 'artifact-missing' }

export async function selectHarnessLaunch(
  host: ProjectHost,
  provider: HarnessProvider,
  requestedMode: HarnessLaunchMode,
  context: HarnessResumeValidationContext,
  effectiveCapabilities: HarnessProviderCapabilities = harnessProviderCapabilities(provider),
): Promise<HarnessLaunchDecision> {
  if (requestedMode === 'fork') {
    if (!provider.fork || effectiveCapabilities.exactFork !== true) {
      throw new Error(`${provider.manifest.displayName} does not support exact forks`)
    }
    if (!provider.resumeValidation) return { outcome: 'launch', mode: 'fork' }
  }
  if (requestedMode === 'fresh' || !provider.resumeValidation) {
    return { outcome: 'launch', mode: requestedMode }
  }
  const availability = await provider.resumeValidation.availability(host, context)
  if (availability === 'available') return { outcome: 'launch', mode: requestedMode }
  if (availability === 'missing') {
    return { outcome: 'resume-unavailable', reason: 'artifact-missing' }
  }
  throw new Error(
    `${provider.manifest.displayName} session state could not be verified; recovery was not started`,
  )
}

/** Data-only inspection surface for diagnostics/tests; never provider-contributed UI. */
export function harnessProviderDiagnostics(): readonly {
  readonly id: HarnessProviderId
  readonly profileContractVersion: number
  readonly defaultProfileId?: HarnessProfileId
  readonly artifactInputs: {
    readonly executable: boolean
    readonly environmentKeys: readonly string[]
    readonly pathBindings: readonly string[]
  }
  readonly probeInvokesVersion: boolean
}[] {
  return harnessProviders.all().map((provider) => ({
    id: provider.manifest.id,
    profileContractVersion: provider.profile.version,
    defaultProfileId: provider.profile.defaultProfile?.id,
    artifactInputs: {
      executable: provider.profile.artifactExecutable,
      environmentKeys: provider.profile.artifactEnvironmentKeys,
      pathBindings: provider.profile.artifactPathBindings,
    },
    probeInvokesVersion: provider.probe.versionArgs !== undefined,
  }))
}

function codexComposerArgs(ctx: HarnessLaunchContext): readonly string[] {
  return ctx.composerSubmitMode === 'ctrl-enter'
    ? ['--config', 'tui.keymap.composer.submit=["ctrl-enter"]']
    : []
}

function pathImagePasteContract(): HarnessRemoteImagePasteContract {
  return {
    revision: 1,
    terminalInput: (path) => {
      if (
        !path.path.startsWith('/') ||
        hasControlCharacter(path.path) ||
        !/^[A-Za-z0-9_./-]+$/.test(path.path)
      ) {
        throw new Error('Remote image paste requires a safe absolute path')
      }
      return `\x1b[200~${path.path}\x1b[201~`
    },
  }
}

function documentReviewInsertContract(
  resolveProvider: () => HarnessProvider,
  supportsProfile: (
    profile: HarnessDocumentReviewInsertLaunch['profile'],
  ) => boolean = supportsDefaultDocumentReviewProfile,
): HarnessDocumentReviewInsertContract {
  const revision = 1
  const supportsLaunch = (launch: HarnessDocumentReviewInsertLaunch): boolean => {
    const provider = resolveProvider()
    return (
      launch.profile.providerId === provider.manifest.id &&
      launch.profile.providerContractVersion === provider.profile.version &&
      launch.profile.executable.kind === 'provider-default' &&
      supportsProfile(launch.profile) &&
      launch.effectiveCapabilities.reviewInsertContractRevision === revision
    )
  }
  return {
    revision,
    supportsLaunch,
    terminalInput: (body) => {
      if (body.length === 0 || hasUnsafeReviewBodyCharacter(body)) {
        throw new Error('Document review insertion requires safe human-readable text')
      }
      return `\x1b[200~${body}\x1b[201~`
    },
  }
}

function codexDocumentReviewSendNowContract(
  insert: HarnessDocumentReviewInsertContract,
): HarnessDocumentReviewSendNowContract {
  const revision = 1
  const supportsLaunch = (launch: HarnessDocumentReviewSendNowLaunch): boolean =>
    launch.profile.providerId === codexProvider.manifest.id &&
    launch.profile.providerContractVersion === codexProvider.profile.version &&
    launch.profile.executable.kind === 'provider-default' &&
    supportsCodexDocumentReviewProfile(launch.profile) &&
    launch.effectiveCapabilities.reviewInsertContractRevision === insert.revision &&
    launch.effectiveCapabilities.reviewSendNowContractRevision === revision
  return {
    revision,
    supportsLaunch,
    terminalInput: (body, launch) => {
      if (!supportsLaunch(launch)) {
        throw new Error('Codex review submission is unavailable for this launch')
      }
      const submit = launch.composerSubmitMode === 'ctrl-enter' ? '\x1b[13;5u' : '\r'
      return `${insert.terminalInput(body)}${submit}`
    },
  }
}

function supportsDefaultDocumentReviewProfile(
  profile: HarnessDocumentReviewInsertLaunch['profile'],
): boolean {
  return (
    profile.args.length === 0 &&
    profile.environment.length === 0 &&
    profile.pathBindings.length === 0
  )
}

/**
 * A live Codex process launched through the provider default remains an explicit
 * best-effort composer target. Profile customization can make the attempt fail,
 * but it must not silently retarget the provider-owned framing contract.
 */
function supportsCodexDocumentReviewProfile(
  _profile: HarnessDocumentReviewInsertLaunch['profile'],
): boolean {
  return true
}

function staticProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
  contextPressure?: HarnessContextPressurePolicy,
): HarnessProbeContract {
  return {
    parseVersion: () => undefined,
    effectiveCapabilities: () => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
      contextPressure,
    }),
  }
}

function versionProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
  capabilities: {
    readonly contextPressure?: HarnessContextPressurePolicy
    readonly reviewInsert?: HarnessDocumentReviewInsertContract
    readonly reviewSendNow?: HarnessDocumentReviewSendNowContract
    readonly supportsReviewSendNowVersion?: (version: string | undefined) => boolean
    readonly supportsExactForkVersion?: (version: string | undefined) => boolean
  } = {},
): HarnessProbeContract {
  return {
    versionArgs: ['--version'],
    parseVersion: (output) => {
      const first = output.trim().split(/\r?\n/, 1)[0]?.trim()
      return first && first.length <= 160 && !hasControlCharacter(first)
        ? first
        : undefined
    },
    effectiveCapabilities: (version) => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
      contextPressure: capabilities.contextPressure,
      ...(capabilities.supportsExactForkVersion?.(version)
        ? { exactFork: true as const }
        : {}),
      reviewInsertContractRevision: capabilities.reviewInsert?.revision,
      reviewSendNowContractRevision:
        capabilities.reviewSendNow && capabilities.supportsReviewSendNowVersion?.(version)
          ? capabilities.reviewSendNow.revision
          : undefined,
    }),
  }
}

function supportsCodexReviewSendNowVersion(version: string | undefined): boolean {
  const parts = codexVersion(version)
  if (!parts) return false
  return parts[0] > 0 || parts[1] > 146 || (parts[1] === 146 && parts[2] >= 0)
}

function supportsCodexExactForkVersion(version: string | undefined): boolean {
  const parts = codexVersion(version)
  return Boolean(
    parts && (parts[0] > 0 || parts[1] > 151 || (parts[1] === 151 && parts[2] >= 0)),
  )
}

function supportsClaudeExactForkVersion(version: string | undefined): boolean {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(version ?? '')
  if (!match) return false
  const parts = match.slice(1).map(Number)
  return (
    parts[0]! > 2 ||
    (parts[0] === 2 &&
      (parts[1]! > 1 || (parts[1] === 1 && parts[2]! >= 258)))
  )
}

function codexVersion(version: string | undefined): readonly [number, number, number] | undefined {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(version ?? '')
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function hasUnsafeReviewBodyCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return (code < 32 && character !== '\n' && character !== '\t') || code === 127
  })
}
