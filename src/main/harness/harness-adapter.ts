/**
 * `HarnessAdapter` — the harness seam (ADR-006).
 *
 * All harness-specific behavior — launch flags, resume commands, title
 * conventions — lives behind this interface so harness quirks never leak past
 * it. Harnesses may accept a pre-assigned id or expose a persisted session
 * record after launch. Either way, only an exact identified id may be resumed.
 */

import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { codexSessionDiscovery } from './codex-session-discovery'

export interface LaunchContext {
  /** Exact harness id for pre-assigned launches and resume commands. */
  readonly sessionId: string
  readonly cwd: HostPath
  readonly cols?: number
  readonly rows?: number
  /** Interactive shell resolved by the owning ProjectHost. */
  readonly defaultShell: string
}

export interface LaunchSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Record<string, string>
}

export type HarnessSessionIdentity = 'none' | 'preassigned' | 'discovered'

export type HarnessSessionDiscoveryResult =
  | { readonly status: 'identified'; readonly sessionId: string }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'unavailable' }

export interface HarnessSessionDiscoveryContext {
  readonly cwd: HostPath
  readonly launchedAtMs: number
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

export interface HarnessAdapter {
  readonly id: string
  readonly displayName: string
  /** Whether the harness can deterministically resume a prior session id. */
  readonly supportsResume: boolean
  /** How a fresh launch's harness-owned session id becomes known. */
  readonly sessionIdentity: HarnessSessionIdentity
  /** Present only when `sessionIdentity` is `discovered`. */
  readonly sessionDiscovery?: HarnessSessionDiscovery

  /** Command to start a fresh session. */
  launch(ctx: LaunchContext): LaunchSpec
  /** Command to resume `ctx.sessionId`. Falls back to a fresh launch if the
   *  harness has no resume concept (see `supportsResume`). */
  resume(ctx: LaunchContext): LaunchSpec

  /** Map a raw OSC 0/2 terminal title to a display title, if the harness has a
   *  convention worth normalizing. Optional. */
  deriveTitle?(rawTitle: string): string
}

export type HarnessAdapterId = 'plain-shell' | 'claude-code' | 'codex'

/**
 * A plain login shell — no session id, no resume. The degenerate adapter that
 * every host supports. "Resume" just starts a new shell.
 */
export const plainShellAdapter: HarnessAdapter = {
  id: 'plain-shell',
  displayName: 'Shell',
  supportsResume: false,
  sessionIdentity: 'none',

  launch(ctx): LaunchSpec {
    return { file: ctx.defaultShell, args: [] }
  },

  resume(ctx): LaunchSpec {
    // No session semantics — a resume is indistinguishable from a fresh shell.
    return this.launch(ctx)
  },
}

export const claudeCodeAdapter: HarnessAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportsResume: true,
  sessionIdentity: 'preassigned',

  launch(ctx): LaunchSpec {
    return { file: 'claude', args: ['--session-id', ctx.sessionId] }
  },

  resume(ctx): LaunchSpec {
    return { file: 'claude', args: ['--resume', ctx.sessionId] }
  },
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'Codex',
  supportsResume: true,
  sessionIdentity: 'discovered',
  sessionDiscovery: codexSessionDiscovery,

  launch(): LaunchSpec {
    return { file: 'codex', args: [] }
  },

  resume(ctx): LaunchSpec {
    return { file: 'codex', args: ['resume', ctx.sessionId] }
  },
}

const adapters = new Map<string, HarnessAdapter>(
  [plainShellAdapter, claudeCodeAdapter, codexAdapter].map((adapter) => [
    adapter.id,
    adapter,
  ]),
)

export function harnessAdapter(id: string): HarnessAdapter {
  const adapter = adapters.get(id)
  if (!adapter) throw new Error(`Unknown harness adapter '${id}'`)
  return adapter
}
