import type { GitCommitFile, HostPath } from '../../../shared'

export interface CommitChangeTotals {
  readonly additions: number
  readonly deletions: number
}

export type CommitTreeEntry =
  | {
      readonly kind: 'directory'
      readonly path: string
      readonly name: string
      readonly depth: number
      readonly expanded: boolean
    }
  | {
      readonly kind: 'file'
      readonly file: GitCommitFile
      readonly name: string
      readonly depth: number
    }

const DIRECTORY_ROW_HEIGHT = 18
const FILE_ROW_HEIGHT = 22

export function commitTreeEntryHeight(entry: CommitTreeEntry): number {
  return entry.kind === 'directory' ? DIRECTORY_ROW_HEIGHT : FILE_ROW_HEIGHT
}

export function sumCommitFileChanges(
  files: readonly GitCommitFile[],
): CommitChangeTotals {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
}

interface CommitTreeNode {
  readonly directories: Map<string, CommitTreeNode>
  readonly files: GitCommitFile[]
}

export function flattenCommitFiles(
  files: readonly GitCommitFile[],
  root: HostPath,
  collapsed: ReadonlySet<string>,
): readonly CommitTreeEntry[] {
  const tree: CommitTreeNode = { directories: new Map(), files: [] }
  for (const file of files) {
    const path = displayGitPath(file.path, root)
    const parts = path.split('/').filter(Boolean)
    let node = tree
    for (const directory of parts.slice(0, -1)) {
      let child = node.directories.get(directory)
      if (!child) {
        child = { directories: new Map(), files: [] }
        node.directories.set(directory, child)
      }
      node = child
    }
    node.files.push(file)
  }

  const entries: CommitTreeEntry[] = []
  const walk = (node: CommitTreeNode, depth: number, parentPath: string): void => {
    const directories = [...node.directories.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )
    for (const [name, child] of directories) {
      const path = parentPath ? `${parentPath}/${name}` : name
      const expanded = !collapsed.has(path)
      entries.push({ kind: 'directory', path, name, depth, expanded })
      if (expanded) walk(child, depth + 1, path)
    }
    for (const file of [...node.files].sort((a, b) =>
      a.path.path.localeCompare(b.path.path),
    )) {
      entries.push({
        kind: 'file',
        file,
        name: displayGitPath(file.path, root).split('/').at(-1) ?? file.path.path,
        depth,
      })
    }
  }
  walk(tree, 0, '')
  return entries
}

export function displayGitPath(path: HostPath, root: HostPath): string {
  if (path.hostId !== root.hostId) return path.path
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  return path.path.startsWith(prefix) ? path.path.slice(prefix.length) : path.path
}

export function displayGitParentPath(path: HostPath, root: HostPath): string {
  const displayPath = displayGitPath(path, root)
  const separator = displayPath.lastIndexOf('/')
  return separator < 0 ? '' : displayPath.slice(0, separator)
}
