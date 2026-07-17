/**
 * Main-owned harness-provider seam (ADR-006/012).
 *
 * Providers own every harness-specific launch, recovery, title, and telemetry
 * convention. The renderer receives only the bounded catalog descriptors.
 */

import {
  asHarnessProviderId,
  type HarnessContextPresentation,
  type HarnessProviderDescriptor,
  type HarnessProviderId,
  type HarnessSessionIdentity,
  type HarnessTelemetry,
  type HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { observeClaudeContext } from './claude-context-telemetry'
import { observeCodexContext } from './codex-context-telemetry'
import { codexSessionDiscovery } from './codex-session-discovery'

const CODEX_THREAD_TITLE_CONFIG = 'tui.terminal_title=["thread-title"]'

export interface HarnessLaunchContext {
  /** Exact harness id for pre-assigned launches and resume commands. */
  readonly sessionId: string
  readonly cwd: HostPath
  readonly cols?: number
  readonly rows?: number
  /** Interactive shell resolved by the owning ProjectHost. */
  readonly defaultShell: string
}

export interface HarnessLaunchSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Record<string, string>
  /** Resolve the command in the user's interactive shell environment. */
  readonly shellEnvironment?: boolean
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
}

export interface HarnessSessionDiscovery {
  /** Capture the persisted-session baseline immediately before launch. */
  snapshot(host: ProjectHost): Promise<unknown>
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
  readonly signal: AbortSignal
  readonly emit: (telemetry: HarnessTelemetry | undefined) => void
}

export interface HarnessTelemetryObserver {
  observe(
    host: ProjectHost,
    context: HarnessTelemetryContext,
  ): Disposer | Promise<Disposer>
}

export interface HarnessManifest {
  readonly id: HarnessProviderId
  readonly displayName: string
  readonly default?: boolean
  readonly contextPresentation: HarnessContextPresentation
}

export interface HarnessProvider {
  readonly manifest: HarnessManifest
  /** Whether the harness can deterministically resume a prior session id. */
  readonly supportsResume: boolean
  /** How a fresh launch's harness-owned session id becomes known. */
  readonly sessionIdentity: HarnessSessionIdentity
  /** Present only when `sessionIdentity` is `discovered`. */
  readonly sessionDiscovery?: HarnessSessionDiscovery
  /** Optional structured, read-only operational state for this harness. */
  readonly telemetry?: HarnessTelemetryObserver

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
  supportsResume: false,
  sessionIdentity: 'none',

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
  },
  supportsResume: true,
  sessionIdentity: 'preassigned',
  telemetry: { observe: observeClaudeContext },

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
  },
  supportsResume: true,
  sessionIdentity: 'discovered',
  sessionDiscovery: codexSessionDiscovery,
  telemetry: { observe: observeCodexContext },

  launch(): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: ['--config', CODEX_THREAD_TITLE_CONFIG],
      shellEnvironment: true,
    }
  },

  resume(ctx): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: ['--config', CODEX_THREAD_TITLE_CONFIG, 'resume', ctx.sessionId],
      shellEnvironment: true,
    }
  },
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
    }))
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
    this.providers.set(id, provider)
  }
}

export const harnessProviders = new HarnessProviderRegistry([
  plainShellProvider,
  claudeCodeProvider,
  codexProvider,
])

export function harnessProvider(id: string): HarnessProvider {
  return harnessProviders.get(id)
}

export function harnessProviderCatalog(): readonly HarnessProviderDescriptor[] {
  return harnessProviders.catalog()
}
