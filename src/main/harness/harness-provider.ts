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
  type HarnessEnvironmentBinding,
  type HarnessLaunchRisk,
  type HarnessModifiedKeyProtocol,
  type HarnessProfileId,
  type HarnessProviderCapabilities,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HarnessSessionIdentity,
  type HarnessTelemetry,
  type HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { configureClaudeComposerSubmit } from './claude-keybindings'
import { observeClaudeContext } from './claude-context-telemetry'
import { claudeResumeAvailability } from './claude-session-recovery'
import { observeCodexContext } from './codex-context-telemetry'
import { codexSessionDiscovery } from './codex-session-discovery'
import { piProvider } from './providers/pi'
import { geminiProvider } from './providers/gemini'
import { githubCopilotProvider } from './providers/github-copilot'
import { cursorProvider } from './providers/cursor'

const CODEX_THREAD_TITLE_CONFIG = 'tui.terminal_title=["thread-title"]'

export interface HarnessLaunchContext {
  /** Exact harness id for pre-assigned launches and resume commands. */
  readonly sessionId: string
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
  /** Resolve the command in the user's interactive shell environment. */
  readonly shellEnvironment?: boolean
}

export interface HarnessComposerConfiguration {
  configure(host: ProjectHost, mode: ComposerSubmitMode): Promise<void>
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
  readonly sessionData?: unknown
  readonly artifact: HarnessArtifactContext
  readonly signal: AbortSignal
  readonly emit: (telemetry: HarnessTelemetry | undefined) => void
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
  readonly default?: boolean
  readonly contextPresentation: HarnessContextPresentation
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

export interface HarnessRiskInput {
  readonly args: readonly string[]
  readonly environment: readonly HarnessEnvironmentBinding[]
  readonly executableOverridden: boolean
}

export interface HarnessProfileContract {
  /** Increment when launch composition or risk rules change. */
  readonly version: number
  readonly defaultProfile?: HarnessDefaultProfile
  readonly reservedArguments: readonly string[]
  readonly reservedEnvironmentKeys: readonly string[]
  readonly artifactEnvironmentKeys: readonly string[]
  readonly artifactExecutable: boolean
  readonly artifactPathBindings: readonly string[]
  applyArgs(
    mode: 'fresh' | 'resume',
    providerArgs: readonly string[],
    profileArgs: readonly string[],
  ): readonly string[]
  classifyRisk(input: HarnessRiskInput): HarnessLaunchRisk
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
  /** Fail-closed check that the exact provider artifact can actually resume. */
  readonly resumeValidation?: HarnessResumeValidation
  readonly probe: HarnessProbeContract
  readonly composerConfiguration?: HarnessComposerConfiguration

  /** Command to start a fresh session. */
  launch(ctx: HarnessLaunchContext): HarnessLaunchSpec
  /** Command to resume `ctx.sessionId`. */
  resume(ctx: HarnessLaunchContext): HarnessLaunchSpec
}

/**
 * A plain login shell — no session id, no resume. The provider every host
 * supports. "Resume" starts a new shell.
 */
export const plainShellProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('plain-shell'),
    displayName: 'Shell',
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
    classifyRisk: ({ args, environment, executableOverridden }) =>
      args.length === 0 && environment.length === 0 && !executableOverridden
        ? 'standard'
        : 'unclassified',
  },
  supportsResume: false,
  sessionIdentity: 'none',
  probe: staticProbe('none', false, 'none'),

  launch(ctx): HarnessLaunchSpec {
    return { file: ctx.defaultShell, args: [] }
  },

  resume(ctx): HarnessLaunchSpec {
    return this.launch(ctx)
  },
}

export const claudeCodeProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('claude-code'),
    displayName: 'Claude Code',
    contextPresentation: 'count',
    modifiedKeyProtocol: 'modify-other-keys',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('claude-code-default'),
      displayName: 'Claude Code',
      description: 'Claude Code with exact hvir-managed session recovery.',
    },
    reservedArguments: ['--session-id', '--resume', '--continue'],
    reservedEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactEnvironmentKeys: ['CLAUDE_CONFIG_DIR'],
    artifactExecutable: true,
    artifactPathBindings: [],
    applyArgs: (_mode, providerArgs, profileArgs) => [...providerArgs, ...profileArgs],
    classifyRisk: classifyClaudeRisk,
  },
  supportsResume: true,
  sessionIdentity: 'preassigned',
  telemetry: { observe: observeClaudeContext },
  resumeValidation: { availability: claudeResumeAvailability },
  probe: versionProbe('preassigned', true, 'count'),
  composerConfiguration: { configure: configureClaudeComposerSubmit },

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
}

export const codexProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('codex'),
    displayName: 'Codex',
    contextPresentation: 'pressure',
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 1,
    defaultProfile: {
      id: asHarnessProfileId('codex-default'),
      displayName: 'Codex',
      description: 'Codex with exact rollout discovery and recovery.',
    },
    reservedArguments: ['resume'],
    reservedEnvironmentKeys: ['CODEX_HOME'],
    artifactEnvironmentKeys: ['CODEX_HOME'],
    artifactExecutable: true,
    artifactPathBindings: [],
    applyArgs: (mode, providerArgs, profileArgs) => {
      if (mode !== 'resume') return [...providerArgs, ...profileArgs]
      const resumeAt = providerArgs.indexOf('resume')
      return resumeAt < 0
        ? [...providerArgs, ...profileArgs]
        : [
            ...providerArgs.slice(0, resumeAt),
            ...profileArgs,
            ...providerArgs.slice(resumeAt),
          ]
    },
    classifyRisk: classifyCodexRisk,
  },
  supportsResume: true,
  sessionIdentity: 'discovered',
  sessionDiscovery: codexSessionDiscovery,
  telemetry: { observe: observeCodexContext },
  probe: versionProbe('discovered', true, 'pressure'),

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
}

export const customCommandProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('custom'),
    displayName: 'Custom',
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
    classifyRisk: () => 'unclassified',
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
      capabilities: {
        sessionIdentity: provider.sessionIdentity,
        exactResume: provider.supportsResume,
        contextPresentation: provider.manifest.contextPresentation,
      },
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
        riskClassification: 'best-effort',
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
      (provider.sessionDiscovery || provider.telemetry) &&
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
  | { readonly outcome: 'launch'; readonly mode: 'fresh' | 'resume' }
  | { readonly outcome: 'resume-unavailable'; readonly reason: 'artifact-missing' }

export async function selectHarnessLaunch(
  host: ProjectHost,
  provider: HarnessProvider,
  requestedMode: 'fresh' | 'resume',
  context: HarnessResumeValidationContext,
): Promise<HarnessLaunchDecision> {
  if (requestedMode === 'fresh' || !provider.resumeValidation) {
    return { outcome: 'launch', mode: requestedMode }
  }
  const availability = await provider.resumeValidation.availability(host, context)
  if (availability === 'available') return { outcome: 'launch', mode: 'resume' }
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

function classifyClaudeRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  if (input.executableOverridden || input.environment.length > 0) return 'unclassified'
  let unclassified = false
  for (const token of input.args) {
    if (
      token === '--dangerously-skip-permissions' ||
      token.startsWith('--dangerously-skip-permissions=')
    ) {
      return 'elevated'
    }
    unclassified = true
  }
  return unclassified ? 'unclassified' : 'standard'
}

function classifyCodexRisk(input: HarnessRiskInput): HarnessLaunchRisk {
  if (input.executableOverridden || input.environment.length > 0) return 'unclassified'
  let unclassified = false
  for (let index = 0; index < input.args.length; index++) {
    const token = input.args[index] ?? ''
    if (token === '--dangerously-bypass-approvals-and-sandbox') return 'elevated'
    if (token === '--add-dir' && input.args[index + 1] !== undefined) {
      index++
      continue
    }
    if (token.startsWith('--add-dir=')) continue
    if ((token === '-c' || token === '--config') && input.args[index + 1]) {
      const value = input.args[++index] ?? ''
      if (isElevatedCodexConfig(value)) return 'elevated'
      unclassified = true
      continue
    }
    if (token.startsWith('-c=') || token.startsWith('--config=')) {
      if (isElevatedCodexConfig(token.slice(token.indexOf('=') + 1))) {
        return 'elevated'
      }
    }
    unclassified = true
  }
  return unclassified ? 'unclassified' : 'standard'
}

function isElevatedCodexConfig(value: string): boolean {
  const normalized = value.replaceAll(/\s/g, '').replaceAll('"', '').replaceAll("'", '')
  return (
    normalized === 'sandbox_mode=danger-full-access' ||
    normalized === 'approval_policy=never'
  )
}

function staticProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
): HarnessProbeContract {
  return {
    parseVersion: () => undefined,
    effectiveCapabilities: () => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
    }),
  }
}

function versionProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
): HarnessProbeContract {
  return {
    versionArgs: ['--version'],
    parseVersion: (output) => {
      const first = output.trim().split(/\r?\n/, 1)[0]?.trim()
      return first && first.length <= 160 && !hasControlCharacter(first)
        ? first
        : undefined
    },
    effectiveCapabilities: () => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
    }),
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
