/**
 * `HarnessAdapter` — the harness seam (ADR-006).
 *
 * All harness-specific behavior — launch flags, resume commands, title
 * conventions — lives behind this interface so harness quirks never leak past
 * it. hvir pre-assigns a session id at launch and passes it in, so resume is
 * deterministic (`claude --session-id <uuid>` → `claude --resume <uuid>`).
 *
 * Real adapters (Claude Code, Codex) land in Phase 6, where their exact CLI
 * surface is verified against the tools themselves. This file ships only the
 * interface plus the `plainShell` adapter, which has no session semantics.
 */

import type { HostPath } from '../../shared'

export interface LaunchContext {
  /** hvir-generated session id, passed to the harness for deterministic resume. */
  readonly sessionId: string
  readonly cwd: HostPath
  readonly cols?: number
  readonly rows?: number
}

export interface LaunchSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Record<string, string>
}

export interface HarnessAdapter {
  readonly id: string
  readonly displayName: string
  /** Whether the harness can deterministically resume a prior session id. */
  readonly supportsResume: boolean

  /** Command to start a fresh session. */
  launch(ctx: LaunchContext): LaunchSpec
  /** Command to resume `ctx.sessionId`. Falls back to a fresh launch if the
   *  harness has no resume concept (see `supportsResume`). */
  resume(ctx: LaunchContext): LaunchSpec

  /** Map a raw OSC 0/2 terminal title to a display title, if the harness has a
   *  convention worth normalizing. Optional. */
  deriveTitle?(rawTitle: string): string
}

/**
 * A plain login shell — no session id, no resume. The degenerate adapter that
 * every host supports. "Resume" just starts a new shell.
 */
export const plainShellAdapter: HarnessAdapter = {
  id: 'plain-shell',
  displayName: 'Shell',
  supportsResume: false,

  launch(): LaunchSpec {
    return { file: defaultShell(), args: [] }
  },

  resume(ctx): LaunchSpec {
    // No session semantics — a resume is indistinguishable from a fresh shell.
    return this.launch(ctx)
  },
}

function defaultShell(): string {
  return (
    process.env.SHELL ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash')
  )
}
