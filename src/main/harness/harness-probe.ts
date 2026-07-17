import {
  type HarnessProfile,
  type HarnessProfileProbe,
  type HarnessProbeStatus,
  type HostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { resolveHarnessLaunch } from './harness-launch'
import type { HarnessProfileStoreContract } from './harness-profile-store'
import { harnessProvider } from './harness-provider'

const AVAILABLE_TTL_MS = 10 * 60_000
const NEGATIVE_TTL_MS = 2 * 60_000
const PROBE_TIMEOUT_MS = 8_000
const MAX_PROBE_OUTPUT = 32 * 1024
const MAX_PROFILES_PER_REQUEST = 200
const MAX_CONCURRENT_PER_HOST = 2

interface HostProbeState {
  generation: number
  connectionState: ProjectHost['connectionState']
  active: number
  readonly waiters: Array<() => void>
  readonly cache: Map<string, HarnessProfileProbe>
  readonly pending: Map<string, Promise<HarnessProfileProbe>>
  disposeConnection: Disposer
}

export interface ProbeHarnessProfilesRequest {
  readonly host: ProjectHost
  readonly projectRoot: HostPath
  readonly workspaceRoot: HostPath
  readonly profiles: readonly HarnessProfile[]
  readonly store: HarnessProfileStoreContract
  readonly force?: boolean
}

/** Bounded, host-scoped availability probes. No probe runs during renderer startup. */
export class HarnessProbeManager {
  private readonly hosts = new WeakMap<ProjectHost, HostProbeState>()
  private readonly hostStates = new Set<HostProbeState>()

  probeProfiles(
    request: ProbeHarnessProfilesRequest,
  ): Promise<readonly HarnessProfileProbe[]> {
    const profiles = request.profiles.slice(0, MAX_PROFILES_PER_REQUEST)
    return Promise.all(profiles.map((profile) => this.probeProfile(request, profile)))
  }

  invalidate(
    host: ProjectHost,
    profile: Pick<HarnessProfile, 'id' | 'launchRevision' | 'providerId'>,
  ): void {
    const state = this.hosts.get(host)
    if (!state) return
    // One profile may have entries for several worktrees; invalidate every
    // matching host entry rather than leaving a context-specific result stale.
    for (const [key, probe] of state.cache) {
      if (
        probe.providerId === profile.providerId &&
        probe.profileId === profile.id &&
        probe.launchRevision === profile.launchRevision
      ) {
        state.cache.delete(key)
      }
    }
  }

  dispose(): void {
    for (const state of this.hostStates) void state.disposeConnection()
    this.hostStates.clear()
  }

  private probeProfile(
    request: ProbeHarnessProfilesRequest,
    profile: HarnessProfile,
  ): Promise<HarnessProfileProbe> {
    const state = this.stateFor(request.host)
    const key = cacheKey(
      profile,
      state.generation,
      request.projectRoot,
      request.workspaceRoot,
    )
    const now = Date.now()
    const cached = state.cache.get(key)
    if (!request.force && cached?.expiresAt !== undefined && cached.expiresAt > now) {
      return Promise.resolve(cached)
    }
    const pending = state.pending.get(key)
    if (pending) return pending
    const probe = this.withHostSlot(state, () => this.runProbe(request, profile))
      .then((result) => {
        // A reconnect while the command was in flight makes the response stale.
        if (
          key ===
          cacheKey(profile, state.generation, request.projectRoot, request.workspaceRoot)
        ) {
          state.cache.set(key, result)
        }
        return result
      })
      .finally(() => state.pending.delete(key))
    state.pending.set(key, probe)
    return probe
  }

  private async runProbe(
    request: ProbeHarnessProfilesRequest,
    profile: HarnessProfile,
  ): Promise<HarnessProfileProbe> {
    const { host } = request
    const provider = harnessProvider(profile.providerId)
    const base = {
      providerId: profile.providerId,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      hostId: host.hostId,
      capabilities: provider.probe.effectiveCapabilities(undefined),
    } as const
    if (host.connectionState !== 'connected') {
      return result(base, 'disconnected', 'Host is not connected')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const defaultShell = await host.defaultShell()
      const resolved = await resolveHarnessLaunch({
        profile,
        expectedLaunchRevision: profile.launchRevision,
        projectRoot: request.projectRoot,
        workspaceRoot: request.workspaceRoot,
        host,
        store: request.store,
        mode: 'fresh',
        context: {
          sessionId: '00000000-0000-4000-8000-000000000000',
          cwd: request.workspaceRoot,
          defaultShell,
        },
      })
      const options = {
        cwd: request.workspaceRoot,
        env: resolved.spec.env,
        unsetEnv: resolved.unsetEnvironment,
        signal: controller.signal,
        maxBuffer: MAX_PROBE_OUTPUT,
        allowTruncatedOutput: true,
      } as const
      const exists = await host.exec(
        defaultShell,
        ['-ic', `command -v ${shellQuote(resolved.spec.file)} >/dev/null 2>&1`],
        options,
      )
      if (exists.code !== 0) {
        return result(base, 'executable-missing', 'Executable was not found')
      }
      let version: string | undefined
      if (provider.probe.versionArgs) {
        const versionResult = await host.exec(
          defaultShell,
          [
            '-ic',
            `exec ${[resolved.spec.file, ...provider.probe.versionArgs]
              .map(shellQuote)
              .join(' ')}`,
          ],
          options,
        )
        const combined = `${versionResult.stdout}\n${versionResult.stderr}`.trim()
        if (versionResult.code !== 0) {
          return classifiedFailure(base, versionResult.code, combined)
        }
        version = provider.probe.parseVersion(combined)
        if (!version) {
          return result(base, 'malformed-output', 'Version output was not understood')
        }
      }
      let capabilityOutput: string | undefined
      if (provider.probe.capabilityArgs) {
        const capabilityResult = await host.exec(
          defaultShell,
          [
            '-ic',
            `exec ${[resolved.spec.file, ...provider.probe.capabilityArgs]
              .map(shellQuote)
              .join(' ')}`,
          ],
          options,
        )
        if (capabilityResult.code === 0) {
          capabilityOutput = `${capabilityResult.stdout}\n${capabilityResult.stderr}`
        }
      }
      return {
        ...result(base, 'available'),
        version,
        capabilities: provider.probe.effectiveCapabilities(version, capabilityOutput),
      }
    } catch (reason) {
      if (controller.signal.aborted) return result(base, 'timeout', 'Probe timed out')
      if (host.connectionState !== 'connected') {
        return result(base, 'disconnected', 'Host disconnected during probe')
      }
      const message = reason instanceof Error ? reason.message : String(reason)
      return result(base, 'probe-failed', cleanDetail(message))
    } finally {
      clearTimeout(timer)
    }
  }

  private stateFor(host: ProjectHost): HostProbeState {
    const existing = this.hosts.get(host)
    if (existing) return existing
    const state: HostProbeState = {
      generation: 1,
      connectionState: host.connectionState,
      active: 0,
      waiters: [],
      cache: new Map(),
      pending: new Map(),
      disposeConnection: () => undefined,
    }
    state.disposeConnection = host.onConnectionState((connectionState) => {
      if (state.connectionState === connectionState) return
      state.connectionState = connectionState
      state.generation++
      state.cache.clear()
    })
    this.hosts.set(host, state)
    this.hostStates.add(state)
    return state
  }

  private async withHostSlot<T>(
    state: HostProbeState,
    task: () => Promise<T>,
  ): Promise<T> {
    let inheritedSlot = false
    if (state.active >= MAX_CONCURRENT_PER_HOST) {
      await new Promise<void>((resolve) => state.waiters.push(resolve))
      inheritedSlot = true
    }
    if (!inheritedSlot) state.active++
    try {
      return await task()
    } finally {
      const next = state.waiters.shift()
      if (next) next()
      else state.active--
    }
  }
}

function cacheKey(
  profile: Pick<HarnessProfile, 'id' | 'launchRevision' | 'providerId'>,
  generation: number,
  projectRoot: HostPath,
  workspaceRoot: HostPath,
): string {
  return JSON.stringify([
    generation,
    profile.providerId,
    profile.id,
    profile.launchRevision,
    projectRoot.hostId,
    projectRoot.path,
    workspaceRoot.hostId,
    workspaceRoot.path,
  ])
}

function result(
  base: Pick<
    HarnessProfileProbe,
    'providerId' | 'profileId' | 'launchRevision' | 'hostId' | 'capabilities'
  >,
  status: HarnessProbeStatus,
  detail?: string,
): HarnessProfileProbe {
  const checkedAt = Date.now()
  return {
    ...base,
    status,
    checkedAt,
    expiresAt: checkedAt + (status === 'available' ? AVAILABLE_TTL_MS : NEGATIVE_TTL_MS),
    detail,
  }
}

function classifiedFailure(
  base: Pick<
    HarnessProfileProbe,
    'providerId' | 'profileId' | 'launchRevision' | 'hostId' | 'capabilities'
  >,
  code: number | null,
  output: string,
): HarnessProfileProbe {
  const normalized = output.toLowerCase()
  if (code === 127 || /command not found|not found/.test(normalized)) {
    return result(base, 'executable-missing', 'Executable was not found')
  }
  if (/not logged in|authentication|authenticate|unauthorized/.test(normalized)) {
    return result(base, 'authentication-required', 'Harness authentication is required')
  }
  if (/unknown option|unrecognized option|unsupported option/.test(normalized)) {
    return result(
      base,
      'version-unsupported',
      'Installed version lacks the probe surface',
    )
  }
  return result(
    base,
    'probe-failed',
    cleanDetail(output || `Probe exited ${code ?? '?'}`),
  )
}

function cleanDetail(value: string): string {
  const first = [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127 ? ' ' : character
    })
    .join('')
    .trim()
  return first.slice(0, 240) || 'Probe failed'
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
