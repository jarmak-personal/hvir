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
  'renderer-authority-route-opening',
  'renderer-authority-route-opened',
  'renderer-authority-reload-awaiting',
  'renderer-authority-reload-loaded',
  'renderer-authority-replacement-ipc-awaiting',
  'renderer-authority-replacement-ipc-ready',
  'renderer-authority-route-revocation-awaiting',
  'renderer-authority-route-revoked',
  'renderer-authority-preview-fetch-awaiting',
  'renderer-authority-preview-available',
  'renderer-authority-destruction-awaiting',
  'renderer-authority-destroyed',
  'renderer-authority-preview-revocation-awaiting',
  'renderer-authority-preview-revoked',
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

/** Emit only a closed, content-free snapshot for the outer process launcher. */
export function reportSmokeFailureEvidence(
  phase: SmokeFailurePhase,
  owners: SmokeOwnedResourceEvidence,
  checkpoint: SmokeFailureCheckpoint | null = null,
  cleanupResource: SmokeCleanupResource | null = null,
): void {
  console.error(
    `[smoke:failure-evidence] ${JSON.stringify({
      schema: 1,
      phase,
      checkpoint,
      cleanupResource,
      owners,
    } satisfies SmokeFailureEvidence)}`,
  )
}

export function smokeCleanupResource(name: string): SmokeCleanupResource | null {
  return SMOKE_CLEANUP_RESOURCES.includes(name as SmokeCleanupResource)
    ? (name as SmokeCleanupResource)
    : null
}
