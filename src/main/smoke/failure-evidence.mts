export const SMOKE_FAILURE_PHASES = [
  'resources-created',
  'host-connected',
  'profile-loaded',
  'pty-active',
  'watch-active',
  'window-ready',
  'renderer-ready',
  'scenario-active',
  'cleanup',
] as const

export type SmokeFailurePhase = (typeof SMOKE_FAILURE_PHASES)[number]

export const SMOKE_FAILURE_CHECKPOINTS = [
  'web-pane-terminal-launch-awaiting',
  'web-pane-terminal-launch-ready',
  'web-pane-dashboard-listen-awaiting',
  'web-pane-dashboard-listening',
  'web-pane-route-activation-awaiting',
  'web-pane-route-activated',
  'web-pane-dashboard-request-awaiting',
  'web-pane-dashboard-requested',
  'web-pane-guest-ready-awaiting',
  'web-pane-guest-ready',
  'web-pane-route-revocation-awaiting',
  'web-pane-route-revoked',
  'web-pane-terminal-disposal-awaiting',
  'web-pane-terminal-disposed',
  'web-pane-dashboard-close-awaiting',
  'web-pane-dashboard-closed',
  'renderer-recovery-route-opening',
  'renderer-recovery-route-opened',
  'renderer-recovery-reload-awaiting',
  'renderer-recovery-reload-loaded',
  'renderer-recovery-readiness-awaiting',
  'renderer-recovery-readiness-ready',
  'renderer-recovery-replacement-ipc-awaiting',
  'renderer-recovery-replacement-ipc-ready',
  'renderer-recovery-controls-awaiting',
  'renderer-recovery-controls-ready',
  'renderer-recovery-terminal-lifecycle-awaiting',
  'renderer-recovery-terminal-lifecycle-ready',
  'renderer-recovery-route-revocation-awaiting',
  'renderer-recovery-route-revoked',
  'renderer-recovery-diagnostics-awaiting',
  'renderer-recovery-diagnostics-ready',
  'renderer-authority-resource-registered',
  'renderer-authority-destruction-awaiting',
  'renderer-authority-destroyed',
  'renderer-authority-resource-revocation-awaiting',
  'renderer-authority-resource-revoked',
  'project-files-local-create-awaiting',
  'project-files-local-create-ready',
  'project-files-local-reveal-menu-awaiting',
  'project-files-local-reveal-menu-ready',
  'project-files-local-reveal-action-awaiting',
  'project-files-local-reveal-action-ready',
  'project-files-local-path-menu-awaiting',
  'project-files-local-path-menu-ready',
  'project-files-local-tree-focus-awaiting',
  'project-files-local-tree-focus-ready',
  'project-files-local-external-write-awaiting',
  'project-files-local-external-write-ready',
  'project-files-local-editor-refresh-awaiting',
  'project-files-local-editor-refresh-ready',
  'project-files-local-organization-awaiting',
  'project-files-local-organization-ready',
  'project-files-local-deletion-awaiting',
  'project-files-local-deletion-ready',
  'project-files-remote-operations-awaiting',
  'project-files-remote-operations-ready',
  'project-files-clipboard-copy-awaiting',
  'project-files-clipboard-copy-ready',
  'project-files-remote-drop-awaiting',
  'project-files-remote-drop-ready',
  'project-files-external-move-awaiting',
  'project-files-external-move-ready',
  'project-files-workspace-switch-awaiting',
  'project-files-workspace-switch-ready',
  'terminal-presentation-explicit-launch-awaiting',
  'terminal-presentation-explicit-launch-ready',
  'terminal-presentation-keyboard-awaiting',
  'terminal-presentation-keyboard-ready',
  'terminal-presentation-file-paste-awaiting',
  'terminal-presentation-file-paste-ready',
  'terminal-presentation-palette-awaiting',
  'terminal-presentation-palette-ready',
  'terminal-presentation-semantic-navigation-awaiting',
  'terminal-presentation-semantic-navigation-ready',
  'terminal-presentation-search-awaiting',
  'terminal-presentation-search-ready',
  'terminal-presentation-horizon-awaiting',
  'terminal-presentation-horizon-ready',
  'terminal-presentation-layout-focus-awaiting',
  'terminal-presentation-layout-focus-ready',
  'terminal-presentation-project-return-awaiting',
  'terminal-presentation-project-return-ready',
  'terminal-presentation-launch-menu-awaiting',
  'terminal-presentation-launch-menu-ready',
  'terminal-presentation-session-switch-awaiting',
  'terminal-presentation-session-switch-ready',
  'terminal-presentation-synchronized-output-awaiting',
  'terminal-presentation-synchronized-output-ready',
  'terminal-presentation-hidden-reveal-awaiting',
  'terminal-presentation-hidden-reveal-ready',
  'terminal-presentation-focus-awaiting',
  'terminal-presentation-focus-ready',
  'terminal-presentation-cursor-cadence-awaiting',
  'terminal-presentation-cursor-cadence-ready',
  'terminal-presentation-input-awaiting',
  'terminal-presentation-input-ready',
  'terminal-presentation-cursor-style-awaiting',
  'terminal-presentation-cursor-style-ready',
  'terminal-presentation-ligatures-awaiting',
  'terminal-presentation-ligatures-ready',
  'terminal-presentation-context-menu-awaiting',
  'terminal-presentation-context-menu-ready',
  'terminal-presentation-typography-awaiting',
  'terminal-presentation-typography-ready',
  'terminal-presentation-theme-gallery-awaiting',
  'terminal-presentation-theme-gallery-ready',
] as const

export type SmokeFailureCheckpoint = (typeof SMOKE_FAILURE_CHECKPOINTS)[number]

export const SMOKE_CLEANUP_RESOURCES = [
  'echo worker',
  'Git worker',
  'filename search',
  'local host',
  'harness profile fixture',
  'large text fixture',
  'large JSON fixture',
  'live reload fixture',
  'viewer position fixture',
  'oversized diff fixture',
  'project watch',
  'supervised terminals',
  'smoke window',
  'IPC authority router',
  'login shell fixture',
  'PTY supervisor',
] as const

export type SmokeCleanupResource = (typeof SMOKE_CLEANUP_RESOURCES)[number]

export interface SmokeOwnedResourceEvidence {
  readonly windowCount: number
  readonly ptyCount: number
  readonly watcherActive: boolean
  readonly rendererOwnerActive: boolean
  readonly rendererGeneration: number | null
}

export interface SmokeFailureEvidence {
  readonly schema: 1
  readonly phase: SmokeFailurePhase
  readonly checkpoint: SmokeFailureCheckpoint | null
  readonly cleanupResource: SmokeCleanupResource | null
  readonly owners: SmokeOwnedResourceEvidence
}

export type SmokeFailureEvidenceSink = (line: string) => void

let stderrGuardInstalled = false

function guardSmokeFailureEvidenceSink(): void {
  if (stderrGuardInstalled) return
  stderrGuardInstalled = true
  process.stderr.on('error', () => {
    // This inherited diagnostic sink is best-effort. Its failure must not
    // become a second smoke-process fault, regardless of the stream error.
  })
}

const stderrSmokeFailureEvidenceSink: SmokeFailureEvidenceSink = (line) => {
  guardSmokeFailureEvidenceSink()
  try {
    process.stderr.write(line)
  } catch {
    // A synchronously rejected diagnostic write is best-effort too.
  }
}

/** Emit only a closed, content-free snapshot for the outer process launcher. */
export function reportSmokeFailureEvidence(
  phase: SmokeFailurePhase,
  owners: SmokeOwnedResourceEvidence,
  checkpoint: SmokeFailureCheckpoint | null = null,
  cleanupResource: SmokeCleanupResource | null = null,
  sink: SmokeFailureEvidenceSink = stderrSmokeFailureEvidenceSink,
): void {
  const line = `[smoke:failure-evidence] ${JSON.stringify({
    schema: 1,
    phase,
    checkpoint,
    cleanupResource,
    owners,
  } satisfies SmokeFailureEvidence)}\n`
  try {
    sink(line)
  } catch {
    // The launcher owns this best-effort pipe. Teardown can revoke it before
    // Electron has finished, and diagnostic loss must not become a new fault.
  }
}

export function smokeCleanupResource(name: string): SmokeCleanupResource | null {
  return SMOKE_CLEANUP_RESOURCES.includes(name as SmokeCleanupResource)
    ? (name as SmokeCleanupResource)
    : null
}
