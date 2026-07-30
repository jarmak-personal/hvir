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
  readonly owners: SmokeOwnedResourceEvidence
}

/** Emit only a closed, content-free snapshot for the outer process launcher. */
export function reportSmokeFailureEvidence(
  phase: SmokeFailurePhase,
  owners: SmokeOwnedResourceEvidence,
): void {
  console.error(
    `[smoke:failure-evidence] ${JSON.stringify({
      schema: 1,
      phase,
      owners,
    } satisfies SmokeFailureEvidence)}`,
  )
}
