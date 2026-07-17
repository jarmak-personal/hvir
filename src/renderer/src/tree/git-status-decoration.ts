import {
  dirnameHostPath,
  hostPathEquals,
  type GitChangedFile,
  type HostPath,
} from '../../../shared'

export type TreeGitTone = 'untracked' | 'modified' | 'conflict'

export interface TreeFileGitDecoration {
  readonly tone: TreeGitTone
  readonly marker: '?' | 'M' | 'S' | '±' | '!'
  readonly label: string
}

export interface TreeDirectoryGitDecoration {
  readonly tone: TreeGitTone
  readonly changedCount: number
  readonly label: string
}

export interface TreeGitDecorations {
  readonly files: ReadonlyMap<string, TreeFileGitDecoration>
  readonly directories: ReadonlyMap<string, TreeDirectoryGitDecoration>
}

interface MutableDirectorySummary {
  tone: TreeGitTone
  changedCount: number
  modifiedCount: number
  untrackedCount: number
  conflictCount: number
}

const tonePriority: Record<TreeGitTone, number> = {
  untracked: 1,
  modified: 2,
  conflict: 3,
}

export function buildTreeGitDecorations(
  root: HostPath,
  changedFiles: readonly GitChangedFile[],
  complete = true,
): TreeGitDecorations {
  const files = new Map<string, TreeFileGitDecoration>()
  const directorySummaries = new Map<string, MutableDirectorySummary>()
  if (!complete) return { files, directories: new Map() }

  for (const file of changedFiles) {
    if (!containsPath(root, file.path) || hostPathEquals(root, file.path)) continue
    const decoration = fileGitDecoration(file)
    files.set(treeGitPathKey(file.path), decoration)

    let directory = dirnameHostPath(file.path)
    while (containsPath(root, directory)) {
      addDirectoryChange(directorySummaries, directory, decoration.tone)
      if (hostPathEquals(directory, root)) break
      const parent = dirnameHostPath(directory)
      if (hostPathEquals(parent, directory)) break
      directory = parent
    }
  }

  return {
    files,
    directories: new Map(
      [...directorySummaries].map(([key, summary]) => [
        key,
        {
          tone: summary.tone,
          changedCount: summary.changedCount,
          label: directoryStatusLabel(summary),
        },
      ]),
    ),
  }
}

export function treeGitPathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}

function fileGitDecoration(file: GitChangedFile): TreeFileGitDecoration {
  if (file.conflicted) {
    return { tone: 'conflict', marker: '!', label: 'Git conflict' }
  }
  if (file.untracked) {
    return { tone: 'untracked', marker: '?', label: 'Git untracked' }
  }
  if (file.staged && file.unstaged) {
    return { tone: 'modified', marker: '±', label: 'Git staged and modified' }
  }
  if (file.staged) {
    return { tone: 'modified', marker: 'S', label: 'Git staged' }
  }
  return { tone: 'modified', marker: 'M', label: 'Git modified' }
}

function addDirectoryChange(
  summaries: Map<string, MutableDirectorySummary>,
  directory: HostPath,
  tone: TreeGitTone,
): void {
  const key = treeGitPathKey(directory)
  const summary = summaries.get(key) ?? {
    tone,
    changedCount: 0,
    modifiedCount: 0,
    untrackedCount: 0,
    conflictCount: 0,
  }
  summary.changedCount += 1
  if (tone === 'conflict') summary.conflictCount += 1
  else if (tone === 'untracked') summary.untrackedCount += 1
  else summary.modifiedCount += 1
  if (tonePriority[tone] > tonePriority[summary.tone]) summary.tone = tone
  summaries.set(key, summary)
}

function directoryStatusLabel(summary: MutableDirectorySummary): string {
  const details = [
    countLabel(summary.conflictCount, 'conflict', 'conflicts'),
    countLabel(summary.modifiedCount, 'modified'),
    countLabel(summary.untrackedCount, 'untracked'),
  ].filter((label): label is string => Boolean(label))
  return `${summary.changedCount} changed ${summary.changedCount === 1 ? 'file' : 'files'}: ${details.join(', ')}`
}

function countLabel(
  count: number,
  singular: string,
  plural = singular,
): string | undefined {
  return count > 0 ? `${count} ${count === 1 ? singular : plural}` : undefined
}

function containsPath(parent: HostPath, candidate: HostPath): boolean {
  if (parent.hostId !== candidate.hostId) return false
  if (parent.path === '/') return candidate.path.startsWith('/')
  return candidate.path === parent.path || candidate.path.startsWith(`${parent.path}/`)
}
