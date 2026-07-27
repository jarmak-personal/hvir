import { describe, expect, it } from 'vitest'

import {
  comparableWorkspaceActivity,
  workspaceActivityChanged,
  workspaceActivitySnapshot,
} from '../src/main/workspace-activity'
import {
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  asHostId,
  hostPath,
  localPath,
  type WorkspaceActivitySnapshot,
  type WorkspaceStatusActivity,
} from '../src/shared'

const cleanStatus: WorkspaceStatusActivity = {
  schema: WORKSPACE_ACTIVITY_SCHEMA,
  fields: WORKSPACE_ACTIVITY_FIELDS,
  statusLimit: WORKSPACE_ACTIVITY_STATUS_LIMIT,
  statusEntryCount: 1,
  statusTruncated: false,
  statusDigest: 'a'.repeat(64),
}

function activity(
  update: Partial<WorkspaceActivitySnapshot> = {},
): WorkspaceActivitySnapshot {
  return {
    root: localPath('/repo-worktree'),
    head: '1'.repeat(40),
    branch: 'feature',
    ...cleanStatus,
    ...update,
  }
}

describe('workspace activity policy', () => {
  it('compares only matching host-qualified bounded snapshots', () => {
    expect(comparableWorkspaceActivity(activity(), activity())).toBe(true)
    expect(
      comparableWorkspaceActivity(
        activity(),
        activity({ root: localPath('/other-worktree') }),
      ),
    ).toBe(false)
    expect(
      comparableWorkspaceActivity(
        activity(),
        activity({ root: hostPath(asHostId('dev'), '/repo-worktree') }),
      ),
    ).toBe(false)
    expect(
      comparableWorkspaceActivity(activity(), activity({ statusTruncated: true })),
    ).toBe(false)
  })

  it('detects HEAD, branch, count, and digest changes without using file metadata', () => {
    const baseline = activity()
    expect(workspaceActivityChanged(baseline, activity())).toBe(false)
    expect(workspaceActivityChanged(baseline, activity({ head: '2'.repeat(40) }))).toBe(
      true,
    )
    expect(workspaceActivityChanged(baseline, activity({ branch: 'renamed' }))).toBe(true)
    expect(workspaceActivityChanged(baseline, activity({ statusEntryCount: 2 }))).toBe(
      true,
    )
    expect(
      workspaceActivityChanged(baseline, activity({ statusDigest: 'b'.repeat(64) })),
    ).toBe(true)
  })

  it('rejects malformed worker summaries before they become baselines', () => {
    expect(
      workspaceActivitySnapshot(localPath('/repo-worktree'), '1'.repeat(40), 'feature', {
        ...cleanStatus,
        statusDigest: '/repo/secret.txt',
      }),
    ).toBeUndefined()
  })
})
