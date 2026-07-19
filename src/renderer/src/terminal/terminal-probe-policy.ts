import type {
  HarnessProfile,
  HarnessProfileProbe,
  HostPath,
  TerminalRecoverySession,
} from '../../../shared'

export function profileProbe(
  probes: readonly HarnessProfileProbe[],
  profile: Pick<HarnessProfile, 'id' | 'launchRevision'>,
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.profileId === profile.id && probe.launchRevision === profile.launchRevision,
  )
}

export function recoveryProbe(
  probes: readonly HarnessProfileProbe[],
  session: TerminalRecoverySession,
): HarnessProfileProbe | undefined {
  return probes.find(
    (probe) =>
      probe.providerId === session.providerId &&
      probe.profileId === session.profileId &&
      probe.launchRevision === session.launchRevision,
  )
}

export function probeLaunchUnavailable(probe: HarnessProfileProbe | undefined): boolean {
  return (
    probe?.status === 'executable-missing' ||
    probe?.status === 'version-unsupported' ||
    probe?.status === 'disconnected'
  )
}

export function mergeTerminalProbe(
  probes: readonly HarnessProfileProbe[],
  next: HarnessProfileProbe,
): readonly HarnessProfileProbe[] {
  return [
    ...probes.filter(
      (probe) =>
        probe.profileId !== next.profileId ||
        probe.launchRevision !== next.launchRevision ||
        probe.hostId !== next.hostId,
    ),
    next,
  ]
}

export function terminalProbeRefreshCandidates(
  profiles: readonly HarnessProfile[],
  probes: readonly HarnessProfileProbe[],
  now: number,
  force: boolean,
): readonly HarnessProfile[] {
  return profiles.filter((profile) => {
    if (profile.builtIn) return false
    const current = profileProbe(probes, profile)
    return force || !current?.expiresAt || current.expiresAt <= now
  })
}

export class TerminalProbeMemory {
  readonly #values = new Map<string, HarnessProfileProbe>()

  constructor(readonly limit = 500) {}

  remember(root: HostPath, probe: HarnessProfileProbe): void {
    if (probe.status !== 'available') return
    const key = probeMemoryKey(root, {
      id: probe.profileId,
      launchRevision: probe.launchRevision,
    })
    this.#values.delete(key)
    this.#values.set(key, probe)
    while (this.#values.size > this.limit) {
      const oldest = this.#values.keys().next().value
      if (oldest === undefined) break
      this.#values.delete(oldest)
    }
  }

  get(
    root: HostPath,
    profile: Pick<HarnessProfile, 'id' | 'launchRevision'>,
  ): HarnessProfileProbe | undefined {
    return this.#values.get(probeMemoryKey(root, profile))
  }

  clear(): void {
    this.#values.clear()
  }
}

export const terminalProbeMemory = new TerminalProbeMemory()

function probeMemoryKey(
  root: HostPath,
  profile: Pick<HarnessProfile, 'id' | 'launchRevision'>,
): string {
  return JSON.stringify([root.hostId, root.path, profile.id, profile.launchRevision])
}
