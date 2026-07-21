import path from 'node:path'

export const WORKFLOW_VERSION = '1'
export const WORKFLOW_BRANCH_PREFIX = 'agent/issue-'
export const WORKFLOW_MARKER_PREFIX = 'refs/hvir/issue-worktrees/'

const DISPOSABLE_IGNORED_ROOTS = [
  '.cache',
  '.vite',
  '.vitest',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
] as const

export interface WorktreeStatus {
  trackedOrUntrackedPaths: string[]
  ignoredPaths: string[]
  unsafeIgnoredPaths: string[]
}

export function expectedBranchName(issueNumber: number): string {
  return `${WORKFLOW_BRANCH_PREFIX}${issueNumber}`
}

export function expectedBranchRef(issueNumber: number): string {
  return `refs/heads/${expectedBranchName(issueNumber)}`
}

export function expectedMarkerRef(issueNumber: number): string {
  return `${WORKFLOW_MARKER_PREFIX}${issueNumber}`
}

export function expectedWorktreePath(primaryRoot: string, issueNumber: number): string {
  return path.join(
    path.dirname(primaryRoot),
    `${path.basename(primaryRoot)}-worktrees`,
    `issue-${issueNumber}`,
  )
}

export function assertExactBaseRef(baseRef: string): void {
  const validPrefix =
    baseRef.startsWith('refs/heads/') || baseRef.startsWith('refs/remotes/origin/')
  const branchName = baseRef
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
  if (
    !validPrefix ||
    branchName === '' ||
    hasInvalidRefCharacter(branchName) ||
    baseRef.includes('..') ||
    baseRef.includes('@{') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock') ||
    branchName.includes('//')
  ) {
    throw new Error(
      '--base must be a full refs/heads/* or refs/remotes/origin/* ref without revision syntax.',
    )
  }
}

function hasInvalidRefCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 32 || codePoint === 127 || '~^:?*[\\'.includes(character)
  })
}

export function baseBranchName(baseRef: string): string {
  if (baseRef.startsWith('refs/heads/')) {
    return baseRef.slice('refs/heads/'.length)
  }
  if (baseRef.startsWith('refs/remotes/origin/')) {
    return baseRef.slice('refs/remotes/origin/'.length)
  }
  throw new Error(`Unsupported base ref: ${baseRef}`)
}

export function parseWorktreeStatus(output: string): WorktreeStatus {
  const trackedOrUntrackedPaths: string[] = []
  const ignoredPaths: string[] = []

  for (const entry of output.split('\0')) {
    if (entry === '') continue
    if (entry.startsWith('! ')) {
      ignoredPaths.push(entry.slice(2))
      continue
    }
    trackedOrUntrackedPaths.push(statusPath(entry))
  }

  return {
    trackedOrUntrackedPaths,
    ignoredPaths,
    unsafeIgnoredPaths: ignoredPaths.filter(
      (candidate) => !isDisposableIgnored(candidate),
    ),
  }
}

export function isDisposableIgnored(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/')
  if (
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return false
  }
  return DISPOSABLE_IGNORED_ROOTS.some(
    (root) =>
      normalized === root ||
      normalized === `${root}/` ||
      normalized.startsWith(`${root}/`),
  )
}

function statusPath(entry: string): string {
  if (entry.startsWith('? ')) return entry.slice(2)
  const fields = entry.split(' ')
  return fields.at(-1) ?? entry
}
