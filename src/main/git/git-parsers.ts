import {
  hostPath,
  GIT_CHANGE_DISPLAY_LIMIT,
  type GitBranchSync,
  type GitBlameRun,
  type GitChangedFile,
  type GitChanges,
  type GitCommitDetail,
  type GitCommitSummary,
  type HostId,
  type HostPath,
  type WorktreeDiscovery,
} from '../../shared'

/** Parse Git's NUL-delimited porcelain format without treating paths as lines. */
export function parseWorktreeList(
  output: string,
  hostId: HostId,
): WorktreeDiscovery['worktrees'] {
  const worktrees: WorktreeDiscovery['worktrees'][number][] = []
  let current:
    | {
        root: HostPath
        head?: string
        branch?: string
        detached: boolean
        bare: boolean
        prunable?: boolean
        prunableReason?: string
      }
    | undefined
  const finish = (): void => {
    if (!current) return
    worktrees.push(current)
    current = undefined
  }
  for (const field of output.split('\0')) {
    if (!field) {
      finish()
      continue
    }
    const separator = field.indexOf(' ')
    const key = separator < 0 ? field : field.slice(0, separator)
    const value = separator < 0 ? '' : field.slice(separator + 1)
    if (key === 'worktree') {
      finish()
      if (!value.startsWith('/')) throw new Error('git reported a non-absolute worktree')
      current = { root: hostPath(hostId, value), detached: false, bare: false }
    } else if (current && key === 'HEAD' && /^[0-9a-f]{40,64}$/i.test(value)) {
      current.head = value
    } else if (current && key === 'branch' && value.startsWith('refs/heads/')) {
      current.branch = value.slice('refs/heads/'.length)
    } else if (current && key === 'detached') {
      current.detached = true
    } else if (current && key === 'bare') {
      current.bare = true
    } else if (current && key === 'prunable') {
      current.prunable = true
      current.prunableReason =
        value.trim().slice(0, 1_024) || 'Git reported stale worktree metadata'
    }
  }
  finish()
  return worktrees
}

/** Compatibility for Git versions predating `worktree list -z`. */
export function parseLegacyWorktreeList(
  output: string,
  hostId: HostId,
): WorktreeDiscovery['worktrees'] {
  return parseWorktreeList(output.split(/\r?\n/).filter(Boolean).join('\0'), hostId)
}

export function parseLocalBranches(output: string): readonly string[] {
  return output
    .split('\0')
    .map((branch) => branch.trim())
    .filter(Boolean)
}

export function parseBranchTracking(
  output: string,
): GitBranchSync['upstream'] | undefined {
  let name: string | undefined
  let ahead = 0
  let behind = 0
  let hasAheadBehind = false
  for (const record of output.split(/\0|\r?\n/)) {
    if (record.startsWith('# branch.upstream ')) {
      name = record.slice('# branch.upstream '.length).trim() || undefined
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record.trim())
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
        hasAheadBehind = true
      }
    }
  }
  return name
    ? { name, ahead, behind, ...(!hasAheadBehind ? { gone: true } : {}) }
    : undefined
}

export function parseAheadBehind(
  output: string,
): { readonly ahead: number; readonly behind: number } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output)
  if (!match) return undefined
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

export function assertBranchName(branch: string): void {
  if (
    !branch ||
    branch.length > 1_024 ||
    branch.startsWith('-') ||
    branch.includes('\0') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.split('/').some((part) => !part || part.endsWith('.lock')) ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 32 || code === 127 || '~^:?*\\['.includes(character)
    })
  ) {
    throw new Error('Invalid branch name')
  }
}

export function assertRevision(revision: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) throw new Error('Invalid git revision')
}

export interface ParsedStatus {
  readonly path: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
}

export function parseStatus(output: string, limit?: number): readonly ParsedStatus[] {
  const records = output.split('\0')
  const result: ParsedStatus[] = []
  for (let index = 0; index < records.length; index += 1) {
    if (limit !== undefined && result.length >= limit) break
    const record = records[index] ?? ''
    if (!record) continue
    if (record.startsWith('? ')) {
      const path = record.slice(2)
      if (path) {
        result.push({
          path,
          staged: false,
          unstaged: false,
          untracked: true,
          conflicted: false,
        })
      }
      continue
    }
    if (record.startsWith('u ')) {
      const fields = record.split(' ')
      const path = fields.slice(10).join(' ')
      if (path) {
        result.push({
          path,
          staged: true,
          unstaged: true,
          untracked: false,
          conflicted: true,
        })
      }
      continue
    }
    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      const path = fields.slice(record.startsWith('2 ') ? 9 : 8).join(' ')
      if (path) {
        result.push({
          path,
          staged: xy[0] !== '.',
          unstaged: xy[1] !== '.',
          untracked: false,
          conflicted: xy.includes('U'),
        })
      }
      if (record.startsWith('2 ')) index += 1
    }
  }
  return result
}

export type GitFileStats = Map<
  string,
  { readonly additions: number; readonly deletions: number }
>

export function parseNumstat(output: string): GitFileStats {
  const result: GitFileStats = new Map()
  const records = output.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (!record) continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const added = record.slice(0, firstTab)
    const deleted = record.slice(firstTab + 1, secondTab)
    const inlinePath = record.slice(secondTab + 1)
    const path = inlinePath || records[index + 2]
    if (!path) continue
    if (!inlinePath) index += 2
    const additions = added === '-' ? 0 : Number(added)
    const deletions = deleted === '-' ? 0 : Number(deleted)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    result.set(path, { additions, deletions })
  }
  return result
}

export function mergeStats(...sources: readonly GitFileStats[]): GitFileStats {
  const merged: GitFileStats = new Map()
  for (const source of sources) {
    for (const [path, counts] of source) {
      const previous = merged.get(path)
      merged.set(path, {
        additions: (previous?.additions ?? 0) + counts.additions,
        deletions: (previous?.deletions ?? 0) + counts.deletions,
      })
    }
  }
  return merged
}

export type ParsedHistoryRecord = GitCommitSummary & { readonly boundary: boolean }

export function parseHistoryRecord(record: string): ParsedHistoryRecord {
  const [
    marker = '',
    hash = '',
    shortHash = '',
    parentList = '',
    author = '',
    authoredAt = '',
    subject = '',
    decorations = '',
  ] = record.split('\x1f')
  return {
    boundary: marker === '-',
    hash,
    shortHash,
    parents: parentList.split(' ').filter(Boolean),
    refs: parseDecorations(decorations),
    author,
    authoredAt,
    subject,
  }
}

export function parseDecorations(value: string): readonly string[] {
  return value.split(', ').filter(Boolean)
}

export function parseBlame(output: string): readonly GitBlameRun[] {
  const runs: GitBlameRun[] = []
  let current: { hash: string; line: number; author: string; summary: string } | undefined
  for (const line of output.split('\n')) {
    const header = /^([0-9a-f^]{40,64}) \d+ (\d+)/.exec(line)
    if (header) {
      current = {
        hash: header[1] ?? '',
        line: Number(header[2]),
        author: '',
        summary: '',
      }
    } else if (current && line.startsWith('author ')) current.author = line.slice(7)
    else if (current && line.startsWith('summary ')) current.summary = line.slice(8)
    else if (current && line.startsWith('\t')) {
      const previous = runs.at(-1)
      if (
        previous &&
        previous.startLine + previous.lineCount === current.line &&
        previous.hash === current.hash &&
        previous.author === current.author &&
        previous.summary === current.summary
      ) {
        runs[runs.length - 1] = { ...previous, lineCount: previous.lineCount + 1 }
      } else {
        runs.push({
          startLine: current.line,
          lineCount: 1,
          hash: current.hash,
          author: current.author,
          summary: current.summary,
        })
      }
      current = undefined
    }
  }
  return runs
}

export function parseCommitDetail(
  output: string,
  commandRoot: HostPath,
  repositoryPrefix: string,
): GitCommitDetail {
  const separator = output.indexOf('\x1e')
  if (separator < 0) throw new Error('git show returned malformed commit detail')
  const [
    hash = '',
    shortHash = '',
    parentList = '',
    author = '',
    authoredAt = '',
    decorations = '',
    ...message
  ] = output.slice(0, separator).split('\x1f')
  const stats = parseNumstat(output.slice(separator + 1).replace(/^\r?\n/, ''))
  const body = message.join('\x1f').trim()
  return {
    hash,
    shortHash,
    parents: parentList.split(' ').filter(Boolean),
    refs: parseDecorations(decorations),
    author,
    authoredAt,
    subject: body.split('\n')[0] ?? '',
    message: body,
    files: [...stats.entries()]
      .filter(([path]) => isInsideProject(path, repositoryPrefix))
      .map(([path, counts]) => ({
        path: projectFilePath(commandRoot, repositoryPrefix, path),
        ...counts,
      })),
  }
}

const MAX_HISTORY_CURSOR_LENGTH = 128 * 1024
export const MAX_HISTORY_FRONTIER = 2_048

export function encodeHistoryCursor(frontier: readonly string[]): string {
  if (frontier.length === 0 || frontier.length > MAX_HISTORY_FRONTIER) {
    throw new Error('Git history continuation frontier is invalid')
  }
  return Buffer.from(JSON.stringify({ version: 1, frontier }), 'utf8').toString(
    'base64url',
  )
}

export function decodeHistoryCursor(cursor: string): readonly string[] {
  if (!cursor || cursor.length > MAX_HISTORY_CURSOR_LENGTH) {
    throw new Error('Invalid Git history cursor')
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown
      frontier?: unknown
    }
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.frontier) ||
      parsed.frontier.length === 0 ||
      parsed.frontier.length > MAX_HISTORY_FRONTIER ||
      !parsed.frontier.every(
        (hash: unknown) =>
          typeof hash === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash),
      ) ||
      new Set(parsed.frontier).size !== parsed.frontier.length
    ) {
      throw new Error('invalid payload')
    }
    return parsed.frontier as string[]
  } catch {
    throw new Error('Invalid Git history cursor')
  }
}

export function finiteInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback
}

export function changedFile(
  root: HostPath,
  repositoryPrefix: string,
  file: ParsedStatus,
  stats: ReadonlyMap<string, { additions: number; deletions: number }>,
): GitChangedFile {
  const counts = stats.get(file.path) ?? { additions: 0, deletions: 0 }
  const base = {
    ...file,
    path: projectFilePath(root, repositoryPrefix, file.path),
  }
  if (!stats.has(file.path) && file.untracked) return base
  return { ...base, additions: counts.additions, deletions: counts.deletions }
}

export function emptyChanges(
  repositoryState: 'unborn' | 'not-git',
  branchPointUnavailableReason: string,
): GitChanges {
  return {
    repositoryState,
    workingTree: [],
    branchPoint: [],
    branchPointAvailable: false,
    branchPointUnavailableReason,
  }
}

export function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function isInsideProject(
  repositoryPath: string,
  repositoryPrefix: string,
): boolean {
  return !repositoryPrefix || repositoryPath.startsWith(repositoryPrefix)
}

export function excludeNestedWorktrees(
  files: readonly ParsedStatus[],
  workspaceRoot: HostPath,
  repositoryPrefix: string,
  relatedWorktreeRoots: readonly HostPath[],
): readonly ParsedStatus[] {
  const workspacePrefix = workspaceRoot.path === '/' ? '/' : `${workspaceRoot.path}/`
  const nestedRoots = relatedWorktreeRoots.flatMap((candidate) => {
    if (!isNestedHostPath(candidate, workspaceRoot)) return []
    const relative = candidate.path.slice(workspacePrefix.length).replace(/\/$/, '')
    return relative ? [`${repositoryPrefix}${relative}`] : []
  })
  if (nestedRoots.length === 0) return files
  return files.filter(
    (file) =>
      !nestedRoots.some(
        (nested) =>
          file.path === nested ||
          file.path === `${nested}/` ||
          file.path.startsWith(`${nested}/`),
      ),
  )
}

export function isNestedHostPath(candidate: HostPath, parent: HostPath): boolean {
  const prefix = parent.path === '/' ? '/' : `${parent.path}/`
  return (
    candidate.hostId === parent.hostId &&
    candidate.path !== parent.path &&
    candidate.path.startsWith(prefix)
  )
}

export function projectFilePath(
  projectRoot: HostPath,
  repositoryPrefix: string,
  repositoryPath: string,
): HostPath {
  if (!isInsideProject(repositoryPath, repositoryPrefix)) {
    throw new Error('Git returned a path outside the active project')
  }
  const relativePath = repositoryPrefix
    ? repositoryPath.slice(repositoryPrefix.length)
    : repositoryPath
  return hostPath(
    projectRoot.hostId,
    projectRoot.path === '/' ? `/${relativePath}` : `${projectRoot.path}/${relativePath}`,
  )
}

export { GIT_CHANGE_DISPLAY_LIMIT }
