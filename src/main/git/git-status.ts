import { createHash } from 'node:crypto'

import {
  GIT_CHANGE_DISPLAY_LIMIT,
  WORKSPACE_ACTIVITY_FIELDS,
  WORKSPACE_ACTIVITY_SCHEMA,
  WORKSPACE_ACTIVITY_STATUS_LIMIT,
  type GitChanges,
  type HostPath,
  type WorkspaceActivityResult,
} from '../../shared'
import { gitError, shortRef, type GitCommandContext } from './git-command-context'
import {
  changedFile,
  emptyChanges,
  errorMessage,
  excludeNestedWorktrees,
  isInsideProject,
  isNestedHostPath,
  mergeStats,
  parseNumstat,
  parseStatus,
  projectFilePath,
  type GitFileStats,
  type ParsedStatus,
} from './git-parsers'

export class GitStatusCapability {
  constructor(private readonly context: GitCommandContext) {}

  async workspaceActivity(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<WorkspaceActivityResult> {
    this.context.assertHost(workspaceRoot)
    const hasNestedWorktree = relatedWorktreeRoots.some((candidate) =>
      isNestedHostPath(candidate, workspaceRoot),
    )
    const repositoryPrefix = hasNestedWorktree
      ? (await this.context.project(workspaceRoot))?.repositoryPrefix
      : ''
    if (repositoryPrefix === undefined) return { changedFiles: 0 }
    const status = await this.context.boundedStatus(workspaceRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ])
    const entries = excludeNestedWorktrees(
      parseStatus(status.output),
      workspaceRoot,
      repositoryPrefix,
      relatedWorktreeRoots,
    )
    const statusTruncated =
      status.truncated || entries.length > WORKSPACE_ACTIVITY_STATUS_LIMIT
    const bounded = entries.slice(0, WORKSPACE_ACTIVITY_STATUS_LIMIT)
    return {
      changedFiles: statusTruncated
        ? GIT_CHANGE_DISPLAY_LIMIT + 1
        : Math.min(bounded.length, GIT_CHANGE_DISPLAY_LIMIT + 1),
      status: {
        schema: WORKSPACE_ACTIVITY_SCHEMA,
        fields: WORKSPACE_ACTIVITY_FIELDS,
        statusLimit: WORKSPACE_ACTIVITY_STATUS_LIMIT,
        statusEntryCount: bounded.length,
        statusTruncated,
        statusDigest: digestStatusEntries(bounded),
      },
    }
  }

  async changes(
    projectRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<GitChanges> {
    const context = await this.context.project(projectRoot)
    if (!context) return emptyChanges('not-git', 'Not a Git repository')
    const { commandRoot, repositoryPrefix } = context
    const hasHead = Boolean(
      await this.context.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD']),
    )
    const status = await this.context.boundedStatus(commandRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ])
    const hasNestedWorktree = relatedWorktreeRoots.some((candidate) =>
      isNestedHostPath(candidate, projectRoot),
    )
    const allParsedStatus = excludeNestedWorktrees(
      parseStatus(
        status.output,
        hasNestedWorktree ? undefined : GIT_CHANGE_DISPLAY_LIMIT + 1,
      ).filter((file) => isInsideProject(file.path, repositoryPrefix)),
      projectRoot,
      repositoryPrefix,
      relatedWorktreeRoots,
    )
    const workingTreeLimited =
      status.truncated || allParsedStatus.length > GIT_CHANGE_DISPLAY_LIMIT
    const parsedStatus = allParsedStatus.slice(0, GIT_CHANGE_DISPLAY_LIMIT)
    if (workingTreeLimited) {
      return {
        repositoryState: hasHead ? 'ready' : 'unborn',
        workingTree: parsedStatus.map((file) =>
          changedFile(commandRoot, repositoryPrefix, file, new Map()),
        ),
        branchPoint: [],
        branchPointAvailable: false,
        branchPointUnavailableReason:
          'Branch-point detail is paused while the working tree exceeds the change limit',
        workingTreeLimited: true,
        workingTreeLimit: GIT_CHANGE_DISPLAY_LIMIT,
      }
    }
    const headDiff = await this.context.tryRun(commandRoot, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--numstat',
      '-z',
      'HEAD',
      '--',
      '.',
    ])
    const stats = headDiff
      ? parseNumstat(headDiff)
      : mergeStats(
          parseNumstat(
            await this.context.run(commandRoot, [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--numstat',
              '-z',
              '--cached',
              '--',
              '.',
            ]),
          ),
          parseNumstat(
            await this.context.run(commandRoot, [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--numstat',
              '-z',
              '--',
              '.',
            ]),
          ),
        )
    await addUntrackedStats(
      commandRoot,
      repositoryPrefix,
      parsedStatus,
      stats,
      this.context,
    )
    const workingTree = parsedStatus.map((file) =>
      changedFile(commandRoot, repositoryPrefix, file, stats),
    )
    let branchStats: GitFileStats = new Map()
    let branchPointAvailable = false
    let branchPointUnavailableReason: string | undefined
    try {
      if (!hasHead) throw new Error('Repository has no commits yet')
      const defaultBranch = await this.context.defaultBranch(commandRoot)
      const mergeBase = (
        await this.context.run(commandRoot, ['merge-base', 'HEAD', defaultBranch])
      ).trim()
      if (mergeBase) {
        branchStats = parseNumstat(
          await this.context.run(commandRoot, [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--numstat',
            '-z',
            mergeBase,
            'HEAD',
            '--',
            '.',
          ]),
        )
        branchPointAvailable = true
      } else {
        branchPointUnavailableReason = `No merge base with ${shortRef(defaultBranch)}`
      }
    } catch (reason) {
      branchPointUnavailableReason = errorMessage(reason)
    }
    const branchPoint = [...branchStats.entries()]
      .filter(([path]) => isInsideProject(path, repositoryPrefix))
      .map(([path, counts]) => ({
        path: projectFilePath(commandRoot, repositoryPrefix, path),
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
        additions: counts.additions,
        deletions: counts.deletions,
      }))
    return {
      repositoryState: hasHead ? 'ready' : 'unborn',
      workingTree,
      branchPoint,
      branchPointAvailable,
      ...(branchPointUnavailableReason ? { branchPointUnavailableReason } : {}),
    }
  }

  async ignoredEntries(
    projectRoot: HostPath,
    directory: HostPath,
    names: readonly string[],
  ): Promise<{ readonly ignoredNames: readonly string[] }> {
    this.context.assertHost(projectRoot)
    this.context.assertHost(directory)
    if (names.length === 0) return { ignoredNames: [] }
    if (names.length > 512) throw new Error('Too many Git ignore entries')
    if (
      new Set(names).size !== names.length ||
      names.some(
        (name) =>
          typeof name !== 'string' ||
          name.length === 0 ||
          name.length > 4_096 ||
          name === '.' ||
          name === '..' ||
          name.includes('/') ||
          name.includes('\0'),
      )
    ) {
      throw new Error('Invalid Git ignore entry name')
    }
    const prefix = projectRoot.path === '/' ? '/' : `${projectRoot.path}/`
    if (directory.path !== projectRoot.path && !directory.path.startsWith(prefix)) {
      throw new Error('Git ignore directory escapes the active project')
    }
    const relativeDirectory =
      directory.path === projectRoot.path ? '' : directory.path.slice(prefix.length)
    const paths = names.map((name) =>
      relativeDirectory ? `${relativeDirectory}/${name}` : name,
    )
    const namesByPath = new Map(paths.map((path, index) => [path, names[index] ?? '']))
    const { ignoredPaths } = await this.ignoredPaths(projectRoot, paths)
    return {
      ignoredNames: ignoredPaths
        .map((path) => namesByPath.get(path))
        .filter((name): name is string => Boolean(name)),
    }
  }

  async ignoredPaths(
    projectRoot: HostPath,
    paths: readonly string[],
  ): Promise<{ readonly ignoredPaths: readonly string[] }> {
    this.context.assertHost(projectRoot)
    if (paths.length === 0) return { ignoredPaths: [] }
    if (paths.length > 512) throw new Error('Too many Git ignore paths')
    if (
      new Set(paths).size !== paths.length ||
      paths.some((path) => !validGitPath(path))
    ) {
      throw new Error('Invalid Git ignore path')
    }
    const batches: string[][] = []
    let batch: string[] = []
    let batchLength = 0
    for (const path of paths) {
      const length = path.length + 1
      if (batch.length > 0 && batchLength + length > 120 * 1024) {
        batches.push(batch)
        batch = []
        batchLength = 0
      }
      batch.push(path)
      batchLength += length
    }
    if (batch.length > 0) batches.push(batch)
    const ignoredPaths: string[] = []
    for (const batch of batches) {
      const result = await this.context.readOnly(
        projectRoot,
        ['check-ignore', '-z', '--stdin'],
        { input: `${batch.join('\0')}\0` },
      )
      if (result.code === 1) continue
      if (/not a git repository/i.test(result.stderr)) return { ignoredPaths: [] }
      if (result.code !== 0) {
        throw gitError(['check-ignore', '-z', '--stdin'], result.stderr, result.code)
      }
      ignoredPaths.push(
        ...result.stdout
          .split('\0')
          .filter(Boolean)
          .map((path) => path.replace(/^\.\//, '')),
      )
    }
    return { ignoredPaths }
  }
}

function validGitPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 4_096 &&
    !path.startsWith('/') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  )
}

function digestStatusEntries(entries: readonly ParsedStatus[]): string {
  const digest = createHash('sha256')
  const ordered = [...entries].sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    const leftOriginal = left.originalPath ?? ''
    const rightOriginal = right.originalPath ?? ''
    return leftOriginal === rightOriginal ? 0 : leftOriginal < rightOriginal ? -1 : 1
  })
  for (const entry of ordered) {
    digest.update(entry.statusCode)
    digest.update('\0')
    digest.update(entry.staged ? '1' : '0')
    digest.update(entry.unstaged ? '1' : '0')
    digest.update(entry.untracked ? '1' : '0')
    digest.update(entry.conflicted ? '1' : '0')
    digest.update('\0')
    digest.update(entry.path)
    digest.update('\0')
    digest.update(entry.originalPath ?? '')
    digest.update('\0')
  }
  return digest.digest('hex')
}

async function addUntrackedStats(
  projectRoot: HostPath,
  repositoryPrefix: string,
  files: readonly ParsedStatus[],
  stats: GitFileStats,
  context: GitCommandContext,
): Promise<void> {
  const untracked = files.filter((file) => file.untracked && !stats.has(file.path))
  for (let index = 0; index < untracked.length; index += 8) {
    await Promise.all(
      untracked.slice(index, index + 8).map(async (file) => {
        const relativePath = repositoryPrefix
          ? file.path.slice(repositoryPrefix.length)
          : file.path
        const result = await context.readOnly(projectRoot, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-index',
          '--numstat',
          '-z',
          '--',
          '/dev/null',
          relativePath,
        ])
        if (result.code !== 0 && result.code !== 1) return
        if (!result.stdout) {
          stats.set(file.path, { additions: 0, deletions: 0 })
          return
        }
        const firstTab = result.stdout.indexOf('\t')
        const secondTab = result.stdout.indexOf('\t', firstTab + 1)
        if (firstTab < 0 || secondTab < 0) return
        const added = result.stdout.slice(0, firstTab)
        const deleted = result.stdout.slice(firstTab + 1, secondTab)
        if (added === '-' || deleted === '-') return
        stats.set(file.path, { additions: Number(added), deletions: Number(deleted) })
      }),
    )
  }
}
