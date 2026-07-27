import {
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  hostPathEquals,
  type HostPath,
  type WorkspaceActivitySnapshot,
  type WorkspaceStatusActivity,
} from '../shared'

export function workspaceActivitySnapshot(
  root: HostPath,
  head: string | undefined,
  branch: string | undefined,
  status: WorkspaceStatusActivity | undefined,
): WorkspaceActivitySnapshot | undefined {
  if (!status || !validStatusActivity(status)) return undefined
  return {
    root,
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
    ...status,
  }
}

export function comparableWorkspaceActivity(
  left: WorkspaceActivitySnapshot,
  right: WorkspaceActivitySnapshot,
): boolean {
  return (
    validActivitySnapshot(left) &&
    validActivitySnapshot(right) &&
    !left.statusTruncated &&
    !right.statusTruncated &&
    hostPathEquals(left.root, right.root) &&
    left.schema === right.schema &&
    left.fields === right.fields &&
    left.statusLimit === right.statusLimit
  )
}

export function workspaceActivityChanged(
  baseline: WorkspaceActivitySnapshot,
  current: WorkspaceActivitySnapshot,
): boolean {
  return (
    comparableWorkspaceActivity(baseline, current) &&
    (baseline.head !== current.head ||
      baseline.branch !== current.branch ||
      baseline.statusEntryCount !== current.statusEntryCount ||
      baseline.statusDigest !== current.statusDigest)
  )
}

export function validActivitySnapshot(value: WorkspaceActivitySnapshot): boolean {
  return (
    Boolean(value.root) &&
    typeof value.root.hostId === 'string' &&
    typeof value.root.path === 'string' &&
    value.root.path.startsWith('/') &&
    (value.head === undefined || /^[0-9a-f]{40,64}$/i.test(value.head)) &&
    (value.branch === undefined ||
      (value.branch.length > 0 && value.branch.length <= 1_024)) &&
    validStatusActivity(value)
  )
}

function validStatusActivity(value: WorkspaceStatusActivity): boolean {
  return (
    value.schema === WORKSPACE_ACTIVITY_SCHEMA &&
    value.fields === WORKSPACE_ACTIVITY_FIELDS &&
    value.statusLimit === WORKSPACE_ACTIVITY_STATUS_LIMIT &&
    Number.isSafeInteger(value.statusEntryCount) &&
    value.statusEntryCount >= 0 &&
    value.statusEntryCount <= WORKSPACE_ACTIVITY_STATUS_LIMIT &&
    typeof value.statusTruncated === 'boolean' &&
    /^[0-9a-f]{64}$/.test(value.statusDigest)
  )
}
