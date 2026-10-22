import { expect, it, vi } from 'vitest'
import { AgentWorkbenchCommandOwner } from '../src/main/agent/command-owner'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { ExtensionContextOwner } from '../src/main/extensions/context-owner'
import {
  AGENT_CONTRACT,
  AGENT_LIMITS,
  type AgentTarget,
} from '../src/shared/agent/contract'
import {
  EXTENSION_LIMITS,
  type ExtensionSessionContext,
} from '../src/shared/extensions/contract'
import { asHostId, hostPath } from '../src/shared/host-path'
import { contextFixture } from './fixtures/extension-context'

it('admits a live terminal beyond guest metadata limits and retains exact renderer/session lifetime', async () => {
  const f = await fixture()
  try {
    const target = f.contexts.launchTarget(f.entries.at(-1)!.info)!
    expect(f.contexts.sessions({ id: 1, generation: 1 })).not.toContainEqual(
      expect.objectContaining({ id: target.session }),
    )
    expect(f.contexts.sessionOwner(target.session)).toEqual({ id: 1, generation: 1 })
    const admitted = f.contexts.admit(
      { id: 1, generation: 1 },
      {
        surface: 'viewer',
        workspaceId: target.workspace,
        sessionId: target.session,
      },
    )
    expect(admitted.value.session?.id).toBe(target.session)
    expect(admitted.current()).toBe(true)
    expect(() =>
      f.contexts.admit(
        { id: 2, generation: 1 },
        {
          surface: 'viewer',
          sessionId: target.session,
        },
      ),
    ).toThrow('stale')
    expect(() =>
      f.contexts.admit(
        { id: 1, generation: 2 },
        {
          surface: 'viewer',
          sessionId: target.session,
        },
      ),
    ).toThrow('stale')
    const response = await f.run(['report', '--title', 'Late terminal'], target)
    expect(response.exitStatus).toBe(0)
    expect(f.reports.snapshot()).toEqual([
      expect.objectContaining({ workspace: target.workspace, root: f.remoteRoot }),
    ])
    f.entries.splice(0, 100)
    expect(admitted.current()).toBe(true)
    f.entries.pop()
    expect(admitted.current()).toBe(false)
    expect((await f.run(['sessions'], target)).exitStatus).toBe(69)
  } finally {
    f.dispose()
  }
})

it('filters and pages every authorized live session before guest presentation limits, preserving SSH scope', async () => {
  const f = await fixture()
  try {
    const expected = f.entries.map(({ info }) => f.contexts.launchTarget(info)!.session)
    const all = await pages(f, [])
    expect(all.map((entry) => entry.id)).toEqual(expected)
    const remoteWorkspace = f.contexts.launchTarget(f.entries.at(-1)!.info)!.workspace
    const remote = await pages(f, ['--workspace', remoteWorkspace])
    expect(remote).toHaveLength(70)
    expect(remote.every((entry) => entry.workspace.host === 'ssh')).toBe(true)
    const filtered = await pages(f, ['--filter', 'terminal-139'])
    expect(filtered.map((entry) => entry.id)).toEqual([expected.at(-1)])
    const forwarded = await pages(f, [], true)
    expect(forwarded).toEqual(remote)
    const forbidden = await f.run(['sessions', '--workspace', f.localWorkspace], {}, true)
    expect(forbidden.exitStatus).toBe(69)
    const first = JSON.parse((await f.run(['sessions'])).stdout) as { nextCursor: string }
    f.entries.pop()
    expect((await f.run(['sessions', '--cursor', first.nextCursor])).exitStatus).toBe(69)
    expect(
      (await f.run(['sessions', '--cursor', first.nextCursor], {}, true)).exitStatus,
    ).toBe(69)
    expect(
      Buffer.byteLength(JSON.stringify(f.contexts.sessions({ id: 1, generation: 1 }))),
    ).toBeLessThanOrEqual(EXTENSION_LIMITS.contextBytes - 128)
  } finally {
    f.dispose()
  }
})

it('shrinks discovery pages to the complete encoded response bound without dropping long identities', async () => {
  const f = await fixture(true)
  try {
    const firstResponse = await f.run(['sessions'])
    expect(firstResponse.exitStatus).toBe(0)
    const first = JSON.parse(firstResponse.stdout) as {
      items: ExtensionSessionContext[]
      nextCursor?: string
    }
    expect(first.items.length).toBeGreaterThan(0)
    expect(first.items.length).toBeLessThan(AGENT_LIMITS.pageSize)
    expect(first.nextCursor).toBeTypeOf('string')
    const all = await pages(f, [])
    expect(all.map((entry) => entry.id)).toEqual(
      f.entries.map(({ info }) => f.contexts.launchTarget(info)!.session),
    )
    expect(all.at(-1)?.workspace.root).toEqual(f.remoteRoot)
    expect(all.at(-1)?.workspace.id).toBe(
      f.contexts.launchTarget(f.entries.at(-1)!.info)!.workspace,
    )
  } finally {
    f.dispose()
  }
})

async function pages(
  f: Awaited<ReturnType<typeof fixture>>,
  flags: string[],
  forwarded = false,
) {
  const collected: ExtensionSessionContext[] = []
  let cursor: string | undefined
  do {
    const response = await f.run(
      ['sessions', ...flags, ...(cursor ? ['--cursor', cursor] : [])],
      {},
      forwarded,
    )
    expect(response.exitStatus).toBe(0)
    expect(Buffer.byteLength(`${JSON.stringify(response)}\n`)).toBeLessThanOrEqual(
      AGENT_LIMITS.frameBytes,
    )
    const page = JSON.parse(response.stdout) as {
      items: ExtensionSessionContext[]
      nextCursor?: string
    }
    expect(page.items.length).toBeLessThanOrEqual(AGENT_LIMITS.pageSize)
    expect(page.nextCursor === undefined || page.items.length > 0).toBe(true)
    collected.push(...page.items)
    cursor = page.nextCursor
  } while (cursor)
  return collected
}

async function fixture(longRoots = false) {
  const original = contextFixture(),
    state = original.sources.projectState()
  // Legal path components with quoting exercise both JSON encoding layers of the wire reply.
  const path = longRoots
    ? '/' + Array.from({ length: 40 }, () => '"'.repeat(70)).join('/')
    : '/Users/example/Documents/repos/project'
  const localRoot = hostPath(asHostId('local'), path),
    remoteRoot = hostPath(asHostId('ssh'), path)
  const localWorkspace = `local:${path}`,
    remoteWorkspace = `ssh:${path}`
  const prototype = original.sources.ptys.observationSnapshot()[0]!
  const entries = Array.from({ length: longRoots ? 40 : 140 }, (_, index) => ({
    ...prototype,
    info: {
      ...prototype.info,
      id: `terminal-${index}`,
      instanceId: `spawn-${index}`,
      ownerId: 1,
      ownerGeneration: 1,
      workspaceRoot: index % 2 ? remoteRoot : localRoot,
    },
  }))
  const session = original.sources.sessions.observationSnapshot()[0]!
  const contexts = new ExtensionContextOwner({
    ...original.sources,
    projectState: () => ({
      ...state,
      projects: [localRoot, remoteRoot].map((root) => ({
        ...state.projects[0]!,
        id: root.hostId,
        registeredRoot: root,
        workspaces: [
          { ...state.projects[0]!.workspaces[0]!, id: `${root.hostId}:${path}`, root },
        ],
      })),
    }),
    ptys: { ...original.sources.ptys, observationSnapshot: () => entries },
    sessions: {
      ...original.sources.sessions,
      observationSnapshot: () =>
        entries.map(({ info }) => ({ ...session, id: info.id, title: info.id })),
    },
  })
  const access = new LocalAgentAccessOwner(
    () => undefined,
    () => Promise.resolve(),
  )
  await access.configure({ enabled: true, confirmDestructive: false })
  const reports = new AgentReportOwner(() => undefined)
  const scopes = new AgentForwardScopeOwner(() => undefined)
  scopes.register('ssh', 'connection')
  const owner = new AgentWorkbenchCommandOwner({
    contexts: () => contexts,
    access,
    reports,
    forwardScopes: scopes,
    activeInstallations: () => [],
    activeInstallation: () => undefined,
    openView: vi.fn(),
    invokeAction: vi.fn(),
    presentationOwner: () => ({ id: 1, generation: 1 }),
    assertOwner: () => undefined,
    host: () => undefined,
    openDocument: vi.fn(),
  })
  const lifetime = new AbortController()
  const run = (argv: string[], defaults: AgentTarget = {}, forwarded = false) =>
    owner.run(
      { contract: AGENT_CONTRACT, argv, stdin: '', defaults },
      {
        id: 'request',
        signal: lifetime.signal,
        ...(forwarded
          ? {
              origin: 'ssh-forward' as const,
              host: asHostId('ssh'),
              generation: 'connection',
              current: () => undefined,
            }
          : { origin: 'application-local' as const }),
      },
    )
  return {
    contexts,
    entries,
    localWorkspace,
    remoteWorkspace,
    remoteRoot,
    reports,
    run,
    dispose: () => {
      lifetime.abort()
      scopes.revokeAll()
      reports.dispose()
      access.dispose()
    },
  }
}
