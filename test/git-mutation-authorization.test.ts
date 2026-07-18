import { describe, expect, it } from 'vitest'

import { GIT_FETCH_ARGS, GIT_PULL_ARGS } from '../src/main/git/git-engine'
import {
  GitMutationAuthorization,
  type GitMutationAuthority,
  type GitMutationGrantRequest,
} from '../src/main/git/mutation-authorization'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type HostPath, type WorkerHostCall } from '../src/shared'

type ExecHostCall = Extract<WorkerHostCall, { readonly operation: 'exec' }>

const root = hostPath(asHostId('dev'), '/repo')
const otherRoot = hostPath(asHostId('dev'), '/other')
const otherHostRoot = hostPath(asHostId('other'), '/repo')
const host = {
  hostId: root.hostId,
  connectionState: 'connected',
  watchTier: 'polling',
} as unknown as ProjectHost
const otherHost = {
  hostId: otherHostRoot.hostId,
  connectionState: 'connected',
  watchTier: 'polling',
} as unknown as ProjectHost

function authority(
  projectId = 'project-1',
  workspaceRoot: HostPath = root,
  projectHost: ProjectHost = host,
): GitMutationAuthority {
  return { projectId, root: workspaceRoot, host: projectHost }
}

function mutationCall(
  kind: GitMutationGrantRequest['kind'],
  workspaceRoot = root,
  target = 'feature/one',
): ExecHostCall {
  const command =
    kind === 'worktree-prune'
      ? ['worktree', 'prune', '--expire', 'now', '--verbose']
      : kind === 'branch-switch'
        ? ['switch', '--no-guess', target]
        : kind === 'fetch'
          ? [...GIT_FETCH_ARGS]
          : [...GIT_PULL_ARGS]
  return {
    kind: 'host-call',
    callId: 1,
    hostId: workspaceRoot.hostId,
    operation: 'exec',
    command: 'git',
    args: ['-C', workspaceRoot.path, ...command],
  }
}

function grantRequest(kind: GitMutationGrantRequest['kind']): GitMutationGrantRequest {
  return kind === 'branch-switch'
    ? { kind, projectId: 'project-1', root, target: 'feature/one' }
    : { kind, projectId: 'project-1', root }
}

describe('GitMutationAuthorization', () => {
  it('rejects malformed grant creation inputs', () => {
    const authorizations = new GitMutationAuthorization()

    expect(() => authorizations.grant({ kind: 'fetch', projectId: '', root })).toThrow(
      'Invalid Git mutation project',
    )
    expect(() =>
      authorizations.grant({
        kind: 'fetch',
        projectId: 'project-1',
        root: hostPath(root.hostId, 'relative'),
      }),
    ).toThrow('Invalid Git mutation root')
    expect(() =>
      authorizations.grant({
        kind: 'branch-switch',
        projectId: 'project-1',
        root,
        target: '',
      }),
    ).toThrow('Invalid Git mutation target')
  })

  it.each([
    ['worktree-prune', { allowWorktreePrune: true }],
    ['branch-switch', { allowBranchSwitch: 'feature/one' }],
    ['fetch', { allowFetch: true }],
    ['pull', { allowPull: true }],
  ] as const)('consumes one exact %s grant', (kind, expected) => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest(kind))

    expect(authorizations.permissionsFor(mutationCall(kind), authority())).toEqual(
      expected,
    )
    expect(() => authorizations.permissionsFor(mutationCall(kind), authority())).toThrow(
      'already consumed',
    )
  })

  it('rejects wrong project, host, root, and branch target without consuming the grant', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest('branch-switch'))

    expect(() =>
      authorizations.permissionsFor(
        mutationCall('branch-switch'),
        authority('project-2'),
      ),
    ).toThrow('no exact grant')
    expect(() =>
      authorizations.permissionsFor(
        mutationCall('branch-switch', otherHostRoot),
        authority('project-1', otherHostRoot, otherHost),
      ),
    ).toThrow('no exact grant')
    expect(() =>
      authorizations.permissionsFor(
        mutationCall('branch-switch', otherRoot),
        authority('project-1', otherRoot),
      ),
    ).toThrow('no exact grant')
    expect(() =>
      authorizations.permissionsFor(
        mutationCall('branch-switch', root, 'feature/two'),
        authority(),
      ),
    ).toThrow('no exact grant')

    expect(
      authorizations.permissionsFor(mutationCall('branch-switch'), authority()),
    ).toEqual({ allowBranchSwitch: 'feature/one' })
  })

  it('never treats a registered-root prefix as exact mutation authority', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest('fetch'))
    const nested = hostPath(root.hostId, '/repo/nested')

    expect(() =>
      authorizations.permissionsFor(mutationCall('fetch', nested), authority()),
    ).toThrow('not an exact workspace')
    expect(authorizations.permissionsFor(mutationCall('fetch'), authority())).toEqual({
      allowFetch: true,
    })
  })

  it('reports expired and explicitly revoked grants', () => {
    let now = 100
    const authorizations = new GitMutationAuthorization({
      now: () => now,
      grantTtlMs: 10,
    })
    authorizations.grant(grantRequest('fetch'))
    now = 110

    expect(() =>
      authorizations.permissionsFor(mutationCall('fetch'), authority()),
    ).toThrow('already expired')

    const grant = authorizations.grant(grantRequest('fetch'))
    grant.revoke()
    expect(() =>
      authorizations.permissionsFor(mutationCall('fetch'), authority()),
    ).toThrow('already revoked')
  })

  it('allows only one concurrent consumer and rejects duplicate active grants', async () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest('pull'))
    expect(() => authorizations.grant(grantRequest('pull'))).toThrow('already active')

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        authorizations.permissionsFor(mutationCall('pull'), authority()),
      ),
      Promise.resolve().then(() =>
        authorizations.permissionsFor(mutationCall('pull'), authority()),
      ),
    ])

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('consumes before dispatch failure and revokes unused cancellation grants', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest('fetch'))
    authorizations.permissionsFor(mutationCall('fetch'), authority())
    // The broker or Git may now fail, but this exact authority cannot be replayed.
    expect(() =>
      authorizations.permissionsFor(mutationCall('fetch'), authority()),
    ).toThrow('already consumed')

    const unused = authorizations.grant(grantRequest('pull'))
    unused.revoke()
    expect(() =>
      authorizations.permissionsFor(mutationCall('pull'), authority()),
    ).toThrow('already revoked')
  })

  it('does not let worker messages broaden or retarget a pending grant', () => {
    const authorizations = new GitMutationAuthorization()
    authorizations.grant(grantRequest('fetch'))
    const fetch = mutationCall('fetch')

    expect(
      authorizations.permissionsFor({ ...fetch, command: 'sh' }, authority()),
    ).toEqual({})
    expect(authorizations.permissionsFor({ ...fetch, cwd: root }, authority())).toEqual(
      {},
    )
    expect(() =>
      authorizations.permissionsFor(mutationCall('pull'), authority()),
    ).toThrow('no exact grant')

    expect(authorizations.permissionsFor(fetch, authority())).toEqual({
      allowFetch: true,
    })
  })
})
