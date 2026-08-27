import { describe, expect, it, vi } from 'vitest'

import {
  SessionsObservationPort,
  assembleSessionsObservation,
} from '../src/main/sessions/sessions-observation-port'
import type { ObservedManagedPty } from '../src/main/pty/pty-supervisor'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  asSessionsPtyHandle,
  hostPath,
  localPath,
  type ProjectState,
} from '../src/shared'

const codex = asHarnessProviderId('codex')
const shell = asHarnessProviderId('plain-shell')
const codexProfile = asHarnessProfileId('codex-default')
const shellProfile = asHarnessProfileId('plain-shell-default')
const localRoot = localPath('/private/repo')
const worktreeRoot = localPath('/private/worktree')
const sshRoot = hostPath(asHostId('ssh-prod'), '/secret/remote/repo')

describe('SessionsObservationPort', () => {
  it('joins registered workspaces, retained records, live PTYs, and safe telemetry once', () => {
    const source = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [
        retained('local-session', localRoot, codex, codexProfile, ' Local\u0007Codex '),
        retained('worktree-session', worktreeRoot, shell, shellProfile, 'Shell'),
        retained('remote-session', sshRoot, codex, codexProfile, 'Remote Codex'),
      ],
      ptys: [livePty('local-session', localRoot, telemetry())],
    })

    expect(source.sessions).toHaveLength(3)
    expect(source.sessions.find((row) => row.handle === 'local-session')).toMatchObject({
      title: 'Local Codex',
      lifecycle: 'live',
      livePty: {
        handle: 'pty-instance-local-session',
        rendererOwnerId: 7,
        rendererGeneration: 4,
      },
      telemetry: {
        model: { status: 'available', value: { id: 'gpt-safe' } },
        context: {
          status: 'available',
          value: { usedTokens: 120, windowTokens: 1_000, usedPercent: 12 },
        },
        turn: { status: 'available', value: { state: 'working' } },
      },
    })
    expect(
      source.sessions.find((row) => row.handle === 'worktree-session')?.telemetry,
    ).toEqual({
      model: { status: 'unsupported' },
      context: { status: 'unsupported' },
      turn: { status: 'unsupported' },
      freshness: { status: 'unsupported' },
    })
    expect(
      source.workspaces.find((row) => row.workspaceName === 'remote-main'),
    ).toMatchObject({
      host: { kind: 'ssh', connectionState: 'disconnected', label: 'Production' },
    })
    expect(source.workspaces.map((workspace) => workspace.workspaceId)).toEqual([
      'sessions-workspace-1',
      'sessions-workspace-2',
      'sessions-workspace-3',
    ])

    const serialized = JSON.stringify(source)
    expect(serialized).not.toContain('/private/')
    expect(serialized).not.toContain('/secret/')
    expect(serialized).not.toContain('provider-session-secret')
    expect(serialized).not.toContain('private provenance')
    expect(serialized).not.toContain('freshInputTokens')
    expect(serialized).not.toContain('normalizedTokenTotal')
    expect(serialized).not.toContain('987654')
  })

  it('bounds many-session assembly without duplicating a live retained session', () => {
    const sessions = Array.from(
      { length: MAX_SESSIONS_PROJECTION_ROWS + 80 },
      (_, index) =>
        retained(`terminal-${index}`, localRoot, shell, shellProfile, `Shell ${index}`),
    )

    const source = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions,
      ptys: [livePty('terminal-0', localRoot)],
    })

    expect(source.sessions).toHaveLength(MAX_SESSIONS_PROJECTION_ROWS)
    expect(source.sessions.filter((row) => row.handle === 'terminal-0')).toHaveLength(1)
  })

  it('rejects telemetry attributed to a different provider', () => {
    const mismatched = telemetry()
    mismatched.source.providerId = shell
    const source = assembleSessionsObservation({
      projectState: projectState(),
      hosts: hostOptions(),
      providers: providers(),
      sessions: [retained('local-session', localRoot, codex, codexProfile, 'Codex')],
      ptys: [livePty('local-session', localRoot, mismatched)],
    })

    expect(source.sessions[0]?.telemetry.model).toEqual({
      status: 'unavailable',
      reason: 'source-unavailable',
    })
  })

  it('starts source observation on first demand, deduplicates facts, and goes quiet on last release', () => {
    const sessions = observationSource([
      retained('session-1', localRoot, shell, shellProfile, 'Shell'),
    ])
    const ptys = observationSource<ObservedManagedPty>([])
    const projects = listeners()
    const emit = vi.fn()
    const port = new SessionsObservationPort({
      projectState,
      hosts: hostOptions,
      providers,
      sessions,
      ptys,
      observeProjects: projects.observe,
      emit,
    })
    const owner = { id: 9, generation: 2 }

    expect(() => port.acquire(owner, 0)).toThrow('Invalid Sessions demand generation')

    const initial = port.acquire(owner, 1)
    expect(port.acquire(owner, 1)).toEqual(initial)
    expect(initial.revision).toBeGreaterThan(0)
    expect(sessions.listenerCount()).toBe(1)
    expect(ptys.listenerCount()).toBe(1)
    expect(projects.listenerCount()).toBe(1)

    sessions.publish()
    expect(emit).not.toHaveBeenCalled()
    sessions.set([retained('session-1', localRoot, shell, shellProfile, 'Renamed Shell')])
    expect(emit).toHaveBeenCalledExactlyOnceWith(owner, {
      demandGeneration: 1,
      revision: initial.revision + 1,
    })
    expect(port.snapshot(owner, 1).sessions[0]?.title).toBe('Renamed Shell')
    expect(port.release(owner, 99)).toBe(false)
    expect(port.release(owner, 1)).toBe(true)
    expect(sessions.listenerCount()).toBe(0)
    expect(ptys.listenerCount()).toBe(0)
    expect(projects.listenerCount()).toBe(0)

    emit.mockClear()
    sessions.set([])
    expect(emit).not.toHaveBeenCalled()
    expect(() => port.snapshot(owner, 1)).toThrow('no longer current')
    expect(port.acquire(owner, 2).revision).toBeGreaterThan(initial.revision)
    port.dispose()
  })

  it('resolves exact live Open through opaque identities and rejects stale or disconnected targets', () => {
    const sessions = observationSource([
      retained('local-session', localRoot, codex, codexProfile, 'Local'),
      retained('remote-session', sshRoot, codex, codexProfile, 'Remote'),
    ])
    const ptys = observationSource([livePty('local-session', localRoot)])
    const port = new SessionsObservationPort({
      projectState,
      hosts: hostOptions,
      providers,
      sessions,
      ptys,
      observeProjects: listeners().observe,
      emit: vi.fn(),
    })
    const owner = { id: 7, generation: 4 }
    const snapshot = port.acquire(owner, 1)
    const local = snapshot.sessions.find(
      (candidate) => candidate.handle === 'local-session',
    )!
    const localWorkspace = snapshot.workspaces.find(
      (candidate) => candidate.workspaceId === local.workspaceId,
    )!
    const request = {
      demandGeneration: 1,
      sourceRevision: snapshot.revision,
      handle: local.handle,
      projectId: localWorkspace.projectId,
      workspaceId: localWorkspace.workspaceId,
      workspaceQualifier: localWorkspace.qualifier,
      livePty: local.livePty,
    }

    expect(port.resolveOpen(owner, request)).toMatchObject({
      outcome: 'resolved',
      projectId: `project:${localRoot.hostId}:${localRoot.path}`,
      workspaceId: `workspace:${localRoot.hostId}:${localRoot.path}`,
      livePty: { handle: 'pty-instance-local-session' },
    })

    sessions.set([
      retained('local-session', localRoot, codex, codexProfile, 'Changed'),
      retained('remote-session', sshRoot, codex, codexProfile, 'Remote'),
    ])
    expect(port.resolveOpen(owner, request)).toEqual({
      outcome: 'unavailable',
      reason: 'stale-projection',
    })

    const current = port.snapshot(owner, 1)
    const currentLocal = current.sessions.find(
      (candidate) => candidate.handle === 'local-session',
    )!
    const currentLocalWorkspace = current.workspaces.find(
      (candidate) => candidate.workspaceId === currentLocal.workspaceId,
    )!
    expect(
      port.resolveOpen(owner, {
        demandGeneration: 1,
        sourceRevision: current.revision,
        handle: currentLocal.handle,
        projectId: currentLocalWorkspace.projectId,
        workspaceId: currentLocalWorkspace.workspaceId,
        workspaceQualifier: currentLocalWorkspace.qualifier,
        livePty: {
          ...currentLocal.livePty!,
          handle: asSessionsPtyHandle('replacement-instance'),
        },
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'terminal-unavailable' })
    expect(
      port.resolveOpen(owner, {
        demandGeneration: 1,
        sourceRevision: current.revision,
        handle: currentLocal.handle,
        projectId: currentLocalWorkspace.projectId,
        workspaceId: currentLocalWorkspace.workspaceId,
        workspaceQualifier: currentLocalWorkspace.qualifier,
        livePty: { ...currentLocal.livePty!, rendererGeneration: 5 },
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'terminal-unavailable' })
    const remote = current.sessions.find(
      (candidate) => candidate.handle === 'remote-session',
    )!
    const remoteWorkspace = current.workspaces.find(
      (candidate) => candidate.workspaceId === remote.workspaceId,
    )!
    expect(
      port.resolveOpen(owner, {
        demandGeneration: 1,
        sourceRevision: current.revision,
        handle: remote.handle,
        projectId: remoteWorkspace.projectId,
        workspaceId: remoteWorkspace.workspaceId,
        workspaceQualifier: remoteWorkspace.qualifier,
        livePty: remote.livePty,
      }),
    ).toEqual({ outcome: 'unavailable', reason: 'connection-unavailable' })
    port.dispose()
  })
})

function projectState(): ProjectState {
  const localProjectId = `project:${localRoot.hostId}:${localRoot.path}`
  const localWorkspaceId = `workspace:${localRoot.hostId}:${localRoot.path}`
  const worktreeWorkspaceId = `workspace:${worktreeRoot.hostId}:${worktreeRoot.path}`
  const sshProjectId = `project:${sshRoot.hostId}:${sshRoot.path}`
  const sshWorkspaceId = `workspace:${sshRoot.hostId}:${sshRoot.path}`
  return {
    revision: 1,
    root: localRoot,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: localProjectId,
    activeWorkspaceId: localWorkspaceId,
    projects: [
      {
        id: localProjectId,
        registeredRoot: localRoot,
        displayName: 'Local project',
        connectionState: 'connected',
        watchTier: 'native',
        activeWorkspaceId: localWorkspaceId,
        workspaces: [
          workspace(localWorkspaceId, localRoot, 'main', true),
          workspace(worktreeWorkspaceId, worktreeRoot, 'feature', false),
        ],
      },
      {
        id: sshProjectId,
        registeredRoot: sshRoot,
        displayName: 'Remote project',
        connectionState: 'disconnected',
        watchTier: 'polling',
        activeWorkspaceId: sshWorkspaceId,
        workspaces: [workspace(sshWorkspaceId, sshRoot, 'remote-main', true)],
      },
    ],
  }
}

function workspace(id: string, root: typeof localRoot, name: string, main: boolean) {
  return {
    id,
    root,
    name,
    main,
    closed: false,
    missing: false,
    repository: true,
    changedFiles: 0,
  }
}

function hostOptions() {
  return [
    {
      hostId: 'local',
      label: 'Local',
      kind: 'local' as const,
      connectionState: 'connected' as const,
      watchTier: 'native' as const,
    },
    {
      hostId: 'ssh-prod',
      label: 'Production',
      kind: 'ssh' as const,
      connectionState: 'disconnected' as const,
      watchTier: 'polling' as const,
    },
  ]
}

function providers() {
  return [
    {
      id: codex,
      displayName: 'Codex',
      telemetrySupported: true,
      sessionKind: 'agent' as const,
    },
    {
      id: shell,
      displayName: 'Shell',
      telemetrySupported: false,
      sessionKind: 'shell' as const,
    },
  ]
}

function retained(
  id: string,
  root: typeof localRoot,
  providerId: typeof codex,
  profileId: typeof codexProfile,
  title: string,
): OwnedTerminalSession {
  return {
    id,
    providerId,
    profileId,
    launchRevision: 1,
    recoverySkipCount: 0,
    artifactIdentity: '0123456789abcdef01234567',
    harnessSessionId: 'provider-session-secret',
    hostId: root.hostId,
    workspaceRoot: root,
    cwd: root,
    title,
    position: 0,
    active: true,
    updatedAt: 1,
  }
}

function livePty(
  id: string,
  root: typeof localRoot,
  observedTelemetry = undefined as ReturnType<typeof telemetry> | undefined,
): ObservedManagedPty {
  return {
    info: {
      instanceId: `pty-instance-${id}`,
      id,
      ownerId: 7,
      ownerGeneration: 4,
      hostId: root.hostId,
      cwd: root,
      workspaceRoot: root,
      providerId: id === 'worktree-session' ? shell : codex,
      capabilities: {
        sessionIdentity: 'discovered',
        exactResume: true,
        contextPresentation: 'pressure',
      },
      profileId: id === 'worktree-session' ? shellProfile : codexProfile,
      pid: 123,
      startedAt: 1,
      resumed: false,
      harnessSessionId: 'provider-session-secret',
      identityStatus: 'identified',
    },
    telemetry: observedTelemetry,
  }
}

function telemetry() {
  return {
    version: 1 as const,
    observedAt: 2,
    source: {
      providerId: codex,
      kind: 'session-artifact' as const,
      provenance: 'private provenance /secret/provider/artifact',
    },
    freshness: { state: 'live' as const, staleAfterMs: 30_000 },
    facets: {
      session: {
        status: 'available' as const,
        value: { id: 'provider-session-secret', state: 'active' as const },
      },
      model: { status: 'available' as const, value: { id: 'gpt-safe' } },
      context: {
        status: 'available' as const,
        value: { usedTokens: 120, windowTokens: 1_000, usedPercent: 12 },
      },
      usage: {
        status: 'exact' as const,
        value: {
          freshInputTokens: 987_654,
          outputTokens: 20,
          normalizedTokenTotal: 987_674,
        },
      },
      turn: { status: 'available' as const, value: { state: 'working' as const } },
      integrations: { status: 'unsupported' as const },
    },
    providerData: { secret: '/secret/provider/artifact' },
  }
}

function observationSource<T>(initial: readonly T[]) {
  let snapshot = initial
  const observed = listeners()
  return {
    observationSnapshot: () => snapshot,
    observe: observed.observe,
    listenerCount: observed.listenerCount,
    publish: observed.publish,
    set: (next: readonly T[]) => {
      snapshot = next
      observed.publish()
    },
  }
}

function listeners() {
  const values = new Set<() => void>()
  return {
    observe: (listener: () => void) => {
      values.add(listener)
      return () => {
        values.delete(listener)
      }
    },
    publish: () => {
      for (const listener of values) listener()
    },
    listenerCount: () => values.size,
  }
}
