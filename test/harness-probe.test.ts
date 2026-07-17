import { describe, expect, it, vi } from 'vitest'

import { HarnessProbeManager } from '../src/main/harness/harness-probe'
import {
  builtInProfiles,
  providerTemplateProfiles,
  type HarnessProfileStoreContract,
} from '../src/main/harness/harness-profile-store'
import type { ProjectHost } from '../src/main/project-host'
import {
  asHarnessProfileId,
  asHostId,
  hostPath,
  type HostConnectionState,
  type HostPath,
} from '../src/shared'

describe('HarnessProbeManager', () => {
  it('coalesces duplicate probes and reuses a positive cached result', async () => {
    const { host, exec } = probeHost('probe-local', 'claude 9.2.1')
    const manager = new HarnessProbeManager()
    const request = probeRequest(host)

    const [first, second] = await Promise.all([
      manager.probeProfiles(request),
      manager.probeProfiles(request),
    ])
    expect(first[0]).toMatchObject({ status: 'available', version: 'claude 9.2.1' })
    expect(second).toEqual(first)
    expect(exec).toHaveBeenCalledTimes(2)

    await manager.probeProfiles(request)
    expect(exec).toHaveBeenCalledTimes(2)
    await manager.probeProfiles({ ...request, force: true })
    expect(exec).toHaveBeenCalledTimes(4)
    manager.dispose()
  })

  it('keeps host-version skew isolated and reports disconnected hosts without exec', async () => {
    const first = probeHost('probe-one', 'claude 1.0.0')
    const second = probeHost('probe-two', 'claude 2.0.0')
    const disconnected = probeHost('probe-offline', 'unused', 'disconnected')
    const manager = new HarnessProbeManager()

    const [one, two, offline] = await Promise.all([
      manager.probeProfiles(probeRequest(first.host)),
      manager.probeProfiles(probeRequest(second.host)),
      manager.probeProfiles(probeRequest(disconnected.host)),
    ])
    expect(one[0]).toMatchObject({ hostId: 'probe-one', version: 'claude 1.0.0' })
    expect(two[0]).toMatchObject({ hostId: 'probe-two', version: 'claude 2.0.0' })
    expect(offline[0]).toMatchObject({ status: 'disconnected' })
    expect(disconnected.exec).not.toHaveBeenCalled()
    manager.dispose()
  })

  it('does not infer Copilot recovery semantics from help substrings', async () => {
    const older = probeHost('copilot-old', '0.0.394', 'connected', true, '--resume')
    const newer = probeHost(
      'copilot-new',
      '1.2.0',
      'connected',
      true,
      '--resume\n--session-id ID',
    )
    const manager = new HarnessProbeManager()
    const [[oldProbe], [newProbe]] = await Promise.all([
      manager.probeProfiles(probeRequest(older.host, 'github-copilot-cli')),
      manager.probeProfiles(probeRequest(newer.host, 'github-copilot-cli')),
    ])
    expect(oldProbe?.capabilities).toMatchObject({
      sessionIdentity: 'none',
      exactResume: false,
    })
    expect(newProbe?.capabilities).toEqual(oldProbe?.capabilities)
    expect(newProbe?.capabilities).toMatchObject({
      sessionIdentity: 'none',
      exactResume: false,
    })
    expect(newer.exec).toHaveBeenCalledTimes(2)
    manager.dispose()
  })

  it('classifies a missing executable without invoking its version surface', async () => {
    const fixture = probeHost('probe-missing', 'unused', 'connected', false)
    const manager = new HarnessProbeManager()
    const [probe] = await manager.probeProfiles(probeRequest(fixture.host))
    expect(probe).toMatchObject({ status: 'executable-missing' })
    expect(fixture.exec).toHaveBeenCalledOnce()
    manager.dispose()
  })

  it('expires positive/negative cache entries and invalidates on reconnect', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const available = probeHost('probe-ttl', 'claude 3.0.0')
    const missing = probeHost('probe-negative-ttl', 'unused', 'connected', false)
    const manager = new HarnessProbeManager()
    try {
      await manager.probeProfiles(probeRequest(available.host))
      await manager.probeProfiles(probeRequest(missing.host))
      now += 2 * 60_000 - 1
      await manager.probeProfiles(probeRequest(available.host))
      await manager.probeProfiles(probeRequest(missing.host))
      expect(available.exec).toHaveBeenCalledTimes(2)
      expect(missing.exec).toHaveBeenCalledTimes(1)

      now += 2
      await manager.probeProfiles(probeRequest(missing.host))
      expect(missing.exec).toHaveBeenCalledTimes(2)

      available.setConnection('disconnected')
      available.setConnection('connected')
      await manager.probeProfiles(probeRequest(available.host))
      expect(available.exec).toHaveBeenCalledTimes(4)

      now += 10 * 60_000 + 1
      await manager.probeProfiles(probeRequest(available.host))
      expect(available.exec).toHaveBeenCalledTimes(6)
    } finally {
      manager.dispose()
      clock.mockRestore()
    }
  })

  it('keeps probe cache entries distinct across workspace context', async () => {
    const { host, exec } = probeHost('probe-context', 'claude 4.0.0')
    const manager = new HarnessProbeManager()
    await manager.probeProfiles(probeRequest(host, 'claude-code', '/project/one'))
    await manager.probeProfiles(probeRequest(host, 'claude-code', '/project/two'))
    expect(exec).toHaveBeenCalledTimes(4)
    manager.dispose()
  })

  it('never runs more than two probes concurrently on one host', async () => {
    const { host, exec } = probeHost('probe-slots', 'claude 4.0.0')
    const implementation = exec.getMockImplementation() as (
      command: string,
      args: readonly string[],
    ) => Promise<{ code: number; signal: null; stdout: string; stderr: string }>
    let active = 0
    let maximum = 0
    exec.mockImplementation(async (command, args) => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      try {
        return await implementation(command, args)
      } finally {
        active--
      }
    })
    const request = probeRequest(host)
    const profile = request.profiles[0]!
    const manager = new HarnessProbeManager()
    await manager.probeProfiles({
      ...request,
      profiles: [
        profile,
        { ...profile, id: asHarnessProfileId('probe-slot-two') },
        { ...profile, id: asHarnessProfileId('probe-slot-three') },
        { ...profile, id: asHarnessProfileId('probe-slot-four') },
      ],
    })
    expect(maximum).toBe(2)
    manager.dispose()
  })
})

function probeRequest(
  host: ProjectHost,
  providerId = 'claude-code',
  workspacePath = '/project',
) {
  const profile = [...builtInProfiles(), ...providerTemplateProfiles()].find(
    (candidate) => candidate.providerId === providerId,
  )!
  const root = hostPath(host.hostId, '/project')
  return {
    host,
    projectRoot: root,
    workspaceRoot: hostPath(host.hostId, workspacePath),
    profiles: [profile],
    store: {
      list: () => [profile],
      get: () => profile,
      prepare: () => profile,
      save: () => Promise.resolve(profile),
      materializeTemplates: () => Promise.resolve([]),
      acknowledgeRisk: () => Promise.resolve(profile),
      duplicate: () => Promise.resolve(profile),
      delete: () => Promise.resolve(),
      authorizePath: () => Promise.reject(new Error('not used')),
      hasPathGrant: () => false,
      flush: () => Promise.resolve(),
    } satisfies HarnessProfileStoreContract,
  }
}

function probeHost(
  id: string,
  version: string,
  connectionState: ProjectHost['connectionState'] = 'connected',
  executableAvailable = true,
  capabilityOutput = '',
) {
  const exec = vi.fn((_command: string, args: readonly string[]) => {
    const script = args.at(-1) ?? ''
    if (script.startsWith('command -v')) {
      return Promise.resolve({
        code: executableAvailable ? 0 : 1,
        signal: null,
        stdout: '',
        stderr: '',
      })
    }
    if (script.includes('--help')) {
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: capabilityOutput,
        stderr: '',
      })
    }
    return Promise.resolve({ code: 0, signal: null, stdout: `${version}\n`, stderr: '' })
  })
  const listeners = new Set<(state: HostConnectionState) => void>()
  let currentConnectionState = connectionState
  const host = {
    hostId: asHostId(id),
    connectionState,
    watchTier: 'native',
    defaultShell: () => Promise.resolve('/bin/zsh'),
    realpath: (path: HostPath) => Promise.resolve(path),
    exec,
    onConnectionState: (callback: (state: HostConnectionState) => void) => {
      listeners.add(callback)
      callback(currentConnectionState)
      return () => listeners.delete(callback)
    },
  } as unknown as ProjectHost
  return {
    host,
    exec,
    setConnection: (state: HostConnectionState) => {
      currentConnectionState = state
      Object.assign(host, { connectionState: state })
      for (const listener of listeners) listener(state)
    },
  }
}
