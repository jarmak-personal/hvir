import {
  basenameHostPath,
  dirnameHostPath,
  hostPath,
  hostPathEquals,
  type DiffBase,
  type ExecResult,
  type GitDiffResponse,
  type GitBlameRun,
  type GitChangedFile,
  type GitChanges,
  type GitCommitSummary,
  type GitHistoryPage,
  type GitCommitDetail,
  type GitBranchModel,
  type GitBranchSync,
  type HostId,
  type HostPath,
  type WorktreeDiscovery,
} from '../../shared'
import type { ExecOptions, ProjectHost } from '../project-host'

export const GIT_FETCH_ARGS = ['fetch', '--prune', '--no-recurse-submodules'] as const
export const GIT_PULL_ARGS = [
  'pull',
  '--no-rebase',
  '--ff-only',
  '--no-recurse-submodules',
] as const

/**
 * Minimal, single-file git slice for ADR-007. Every command crosses the
 * ProjectHost seam, so the same implementation can be injected with SshHost
 * in Phase 4.
 */
export class GitEngine {
  constructor(
    private readonly host: ProjectHost,
    /**
     * Main's active project boundary. The repository itself may be above this
     * directory, but commands must never move the broker's `-C` outside it.
     */
    private readonly projectRoot?: HostPath,
  ) {}

  async worktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.assertHost(projectRoot)
    const result = await execReadOnlyGit(this.host, projectRoot, [
      'worktree',
      'list',
      '--porcelain',
      '-z',
    ])
    if (result.code !== 0) {
      // Git's usage exit is locale-independent; stderr wording is not. Null is
      // retained for transports that omit exit-status, and the legacy command
      // must still succeed before its less expressive output is accepted.
      if (result.code === 129 || result.code === null) {
        const legacy = await execReadOnlyGit(this.host, projectRoot, [
          'worktree',
          'list',
          '--porcelain',
        ])
        if (legacy.code !== 0) {
          throw gitError(['worktree', 'list', '--porcelain'], legacy.stderr, legacy.code)
        }
        const worktrees = parseLegacyWorktreeList(legacy.stdout, projectRoot.hostId)
        if (worktrees.length === 0) throw new Error('git reported no worktrees')
        return { repository: true, worktrees }
      }
      const context = await this.projectContext(projectRoot)
      if (context) {
        throw gitError(
          ['worktree', 'list', '--porcelain', '-z'],
          result.stderr,
          result.code,
        )
      }
      return {
        repository: false,
        worktrees: [
          {
            root: projectRoot,
            detached: false,
            bare: false,
          },
        ],
      }
    }
    const worktrees = parseWorktreeList(result.stdout, projectRoot.hostId)
    if (worktrees.length === 0) throw new Error('git reported no worktrees')
    return { repository: true, worktrees }
  }

  /**
   * Remove only stale worktree administrative records, then rediscover the
   * repository while the caller's explicit mutation authorization is active.
   */
  async pruneWorktrees(projectRoot: HostPath): Promise<WorktreeDiscovery> {
    this.assertHost(projectRoot)
    const result = await execGit(this.host, projectRoot, [
      'worktree',
      'prune',
      '--expire',
      'now',
      '--verbose',
    ])
    if (result.code !== 0) {
      throw gitError(
        ['worktree', 'prune', '--expire', 'now', '--verbose'],
        result.stderr,
        result.code,
      )
    }
    return this.worktrees(projectRoot)
  }

  async changedFileCount(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<number> {
    this.assertHost(workspaceRoot)
    const hasNestedWorktree = relatedWorktreeRoots.some((candidate) =>
      isNestedHostPath(candidate, workspaceRoot),
    )
    const repositoryPrefix = hasNestedWorktree
      ? (await this.projectContext(workspaceRoot))?.repositoryPrefix
      : ''
    if (repositoryPrefix === undefined) return 0
    return excludeNestedWorktrees(
      parseStatus(
        await this.run(workspaceRoot, [
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
          '--',
          '.',
        ]),
      ),
      workspaceRoot,
      repositoryPrefix,
      relatedWorktreeRoots,
    ).length
  }

  async branches(workspaceRoot: HostPath): Promise<GitBranchModel> {
    this.assertHost(workspaceRoot)
    const context = await this.projectContext(workspaceRoot)
    if (!context) {
      return {
        repositoryState: 'not-git',
        detached: false,
        remoteAvailable: false,
        branches: [],
      }
    }
    const { commandRoot } = context
    const [headOutput, currentOutput, refsOutput, discovery, statusOutput, remoteOutput] =
      await Promise.all([
        this.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD']),
        this.tryRun(commandRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        this.run(commandRoot, [
          'for-each-ref',
          '--format=%(refname:short)%00',
          'refs/heads',
        ]),
        this.worktrees(workspaceRoot),
        this.run(commandRoot, [
          'status',
          '--porcelain=v2',
          '--branch',
          '-z',
          '--untracked-files=no',
        ]),
        this.run(commandRoot, ['remote']),
      ])
    const head = headOutput?.trim() || undefined
    const current = currentOutput?.trim() || undefined
    const sync =
      head && current ? await this.branchSync(commandRoot, statusOutput) : undefined
    const occupied = new Map(
      discovery.worktrees.flatMap((worktree) =>
        worktree.branch ? [[worktree.branch, worktree.root] as const] : [],
      ),
    )
    return {
      repositoryState: head ? 'ready' : 'unborn',
      current,
      head,
      detached: Boolean(head && !current),
      remoteAvailable: remoteOutput.trim().length > 0,
      ...(sync ? { sync } : {}),
      branches: parseLocalBranches(refsOutput).map((name) => ({
        name,
        current: name === current,
        ...(occupied.get(name) ? { worktree: occupied.get(name) } : {}),
      })),
    }
  }

  async fetch(workspaceRoot: HostPath): Promise<void> {
    this.assertHost(workspaceRoot)
    const context = await this.projectContext(workspaceRoot)
    if (!context) throw new Error('Not a Git repository')
    const remotes = await this.run(context.commandRoot, ['remote'])
    if (!remotes.trim()) throw new Error('No Git remote is configured')
    const result = await execGit(this.host, context.commandRoot, GIT_FETCH_ARGS)
    if (result.code !== 0) {
      throw gitError(GIT_FETCH_ARGS, result.stderr, result.code)
    }
  }

  async pullFastForward(
    workspaceRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    this.assertHost(workspaceRoot)
    const model = await this.branches(workspaceRoot)
    if (model.repositoryState === 'not-git') throw new Error('Not a Git repository')
    if (!model.current) throw new Error('A detached HEAD cannot be pulled')
    if (!model.remoteAvailable) throw new Error('No Git remote is configured')
    const upstream = model.sync?.upstream
    if (!upstream) throw new Error('The current branch has no upstream')
    if (upstream.gone) throw new Error('The configured upstream no longer exists')
    if (upstream.ahead > 0 && upstream.behind > 0) {
      throw new Error('The branch has diverged; ask an agent to integrate it')
    }
    if (upstream.behind === 0) throw new Error('The branch is already up to date')

    const status = await this.run(workspaceRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    const context = await this.projectContext(workspaceRoot)
    if (!context) throw new Error('Not a Git repository')
    if (
      excludeNestedWorktrees(
        parseStatus(status),
        workspaceRoot,
        context.repositoryPrefix,
        relatedWorktreeRoots,
      ).length > 0
    ) {
      throw new Error('Working tree changed; ask an agent to commit or stash it')
    }

    const result = await execGit(this.host, context.commandRoot, GIT_PULL_ARGS)
    if (result.code !== 0) {
      throw gitError(GIT_PULL_ARGS, result.stderr, result.code)
    }
  }

  async switchBranch(
    workspaceRoot: HostPath,
    branch: string,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<void> {
    assertBranchName(branch)
    const model = await this.branches(workspaceRoot)
    if (model.repositoryState === 'not-git') throw new Error('Not a Git repository')
    const target = model.branches.find((candidate) => candidate.name === branch)
    if (!target) throw new Error('Branch no longer exists')
    if (target.current) throw new Error(`${branch} is already checked out`)
    if (target.worktree && !hostPathEquals(target.worktree, workspaceRoot)) {
      throw new Error(`${branch} is checked out in ${target.worktree.path}`)
    }
    const status = await this.run(workspaceRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    const context = await this.projectContext(workspaceRoot)
    if (!context) throw new Error('Not a Git repository')
    if (
      excludeNestedWorktrees(
        parseStatus(status),
        workspaceRoot,
        context.repositoryPrefix,
        relatedWorktreeRoots,
      ).length > 0
    ) {
      throw new Error('Working tree changed; commit or stash before switching')
    }
    const result = await execGit(this.host, workspaceRoot, [
      'switch',
      '--no-guess',
      branch,
    ])
    if (result.code !== 0) {
      throw gitError(['switch', '--no-guess', branch], result.stderr, result.code)
    }
  }

  async diffInputs(
    path: HostPath,
    base: DiffBase,
    revision?: string,
  ): Promise<GitDiffResponse> {
    this.assertHost(path)
    const { commandRoot, relativePath } = await this.repoContext(path)
    if (revision) {
      assertRevision(revision)
      return {
        path,
        base,
        revision,
        baseLabel: `${revision.slice(0, 8)}^`,
        currentLabel: revision.slice(0, 8),
        baseContent: await this.showOrEmpty(commandRoot, `${revision}^:${relativePath}`),
        currentContent: await this.showOrEmpty(
          commandRoot,
          `${revision}:${relativePath}`,
        ),
      }
    }
    const currentContent = await this.readWorkingTreeOrEmpty(
      path,
      commandRoot,
      relativePath,
    )

    let baseContent: string
    let baseLabel: string
    if (base === 'working-tree') {
      baseContent = await this.showOrEmpty(commandRoot, `:${relativePath}`)
      baseLabel = 'Index'
    } else if (base === 'head') {
      baseContent = await this.showOrEmpty(commandRoot, `HEAD:${relativePath}`)
      baseLabel = 'HEAD'
    } else {
      const defaultBranch = await this.defaultBranch(commandRoot)
      const mergeBase = await this.run(commandRoot, ['merge-base', 'HEAD', defaultBranch])
      const commit = mergeBase.trim()
      if (!commit)
        throw new Error(`git merge-base returned no commit for ${defaultBranch}`)
      baseContent = await this.showOrEmpty(commandRoot, `${commit}:${relativePath}`)
      baseLabel = `Branch point (${shortRef(defaultBranch)})`
      return {
        path,
        base,
        baseLabel,
        currentLabel: 'HEAD',
        baseContent,
        currentContent: await this.showOrEmpty(commandRoot, `HEAD:${relativePath}`),
      }
    }

    return {
      path,
      base,
      baseLabel,
      currentLabel: 'Working tree',
      baseContent,
      currentContent,
    }
  }

  async repoRoot(path: HostPath): Promise<HostPath> {
    return (await this.repoContext(path)).repositoryRoot
  }

  async changes(
    projectRoot: HostPath,
    relatedWorktreeRoots: readonly HostPath[] = [],
  ): Promise<GitChanges> {
    const context = await this.projectContext(projectRoot)
    if (!context) return emptyChanges('not-git', 'Not a Git repository')
    const { commandRoot, repositoryPrefix } = context
    const hasHead = Boolean(
      await this.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD']),
    )
    const status = await this.run(commandRoot, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ])
    const parsedStatus = excludeNestedWorktrees(
      parseStatus(status).filter((file) => isInsideProject(file.path, repositoryPrefix)),
      projectRoot,
      repositoryPrefix,
      relatedWorktreeRoots,
    )
    const headDiff = await this.tryRun(commandRoot, [
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
            await this.run(commandRoot, [
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
            await this.run(commandRoot, [
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
    await addUntrackedStats(commandRoot, repositoryPrefix, parsedStatus, stats, this.host)
    const workingTree = parsedStatus.map((file) =>
      changedFile(commandRoot, repositoryPrefix, file, stats),
    )
    let branchStats = new Map<string, { additions: number; deletions: number }>()
    let branchPointAvailable = false
    let branchPointUnavailableReason: string | undefined
    try {
      if (!hasHead) throw new Error('Repository has no commits yet')
      const defaultBranch = await this.defaultBranch(commandRoot)
      const mergeBase = (
        await this.run(commandRoot, ['merge-base', 'HEAD', defaultBranch])
      ).trim()
      if (mergeBase) {
        branchStats = parseNumstat(
          await this.run(commandRoot, [
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
      // Unborn repositories and repos without a conventional default branch
      // still have a useful working-tree Changes view.
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
    this.assertHost(projectRoot)
    this.assertHost(directory)
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
    const ignoredNames: string[] = []
    for (const batch of batches) {
      const result = await execReadOnlyGit(
        this.host,
        projectRoot,
        ['check-ignore', '-z', '--stdin'],
        { input: `${batch.join('\0')}\0` },
      )
      if (result.code === 1) continue
      if (/not a git repository/i.test(result.stderr)) return { ignoredNames: [] }
      if (result.code !== 0) {
        throw gitError(['check-ignore', '-z', '--stdin'], result.stderr, result.code)
      }
      ignoredNames.push(
        ...result.stdout
          .split('\0')
          .filter(Boolean)
          .map((path) => namesByPath.get(path.replace(/^\.\//, '')))
          .filter((name): name is string => Boolean(name)),
      )
    }
    return {
      ignoredNames,
    }
  }

  async history(
    projectRoot: HostPath,
    limit: number,
    cursor?: string,
    path?: HostPath,
    allRefs = false,
  ): Promise<GitHistoryPage> {
    const context = await this.projectContext(projectRoot)
    if (!context) return { repositoryState: 'not-git', commits: [], hasMore: false }
    const { commandRoot } = context
    const head = await this.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD'])
    if (!head?.trim()) {
      return { repositoryState: 'unborn', commits: [], hasMore: false }
    }
    const count = finiteInteger(limit, 50, 1, 200)
    const frontier = cursor
      ? decodeHistoryCursor(cursor)
      : allRefs
        ? await this.allRefTips(commandRoot, head.trim())
        : [head.trim()]
    const relativePath = path ? (await this.repoContext(path)).relativePath : '.'
    const candidates = path
      ? await this.pathHistoryCandidates(commandRoot, frontier, relativePath)
      : frontier
    const records = await this.historyRecords(commandRoot, frontier, count, relativePath)
    const commits = records.filter((record) => !record.boundary)
    const emitted = new Set(commits.map((commit) => commit.hash))
    const nextFrontier = new Set(
      records.filter((record) => record.boundary).map((record) => record.hash),
    )
    for (const candidate of candidates) {
      if (!emitted.has(candidate)) nextFrontier.add(candidate)
    }
    const hasMore = nextFrontier.size > 0
    return {
      repositoryState: 'ready',
      commits,
      hasMore,
      ...(hasMore ? { nextCursor: encodeHistoryCursor([...nextFrontier]) } : {}),
    }
  }

  private async allRefTips(
    commandRoot: HostPath,
    head: string,
  ): Promise<readonly string[]> {
    const output = await this.run(commandRoot, [
      'for-each-ref',
      '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
    ])
    const tips = [head]
    for (const record of output.split(/\r?\n/)) {
      const [objectName = '', objectType = '', peeledName = '', peeledType = ''] =
        record.split('\0')
      if (objectType === 'commit') tips.push(objectName)
      else if (peeledType === 'commit') tips.push(peeledName)
    }
    const unique = [...new Set(tips)]
    if (unique.length > MAX_HISTORY_FRONTIER) {
      throw new Error(
        `Repository graph has too many refs (${unique.length}; maximum ${MAX_HISTORY_FRONTIER})`,
      )
    }
    return unique
  }

  private async pathHistoryCandidates(
    commandRoot: HostPath,
    frontier: readonly string[],
    relativePath: string,
  ): Promise<readonly string[]> {
    const candidates: string[] = []
    for (let index = 0; index < frontier.length; index += 8) {
      const batch = await Promise.all(
        frontier.slice(index, index + 8).map(async (tip) => {
          const records = await this.historyRecords(commandRoot, [tip], 1, relativePath)
          return records.find((record) => !record.boundary)?.hash
        }),
      )
      for (const candidate of batch) {
        if (candidate) candidates.push(candidate)
      }
    }
    return [...new Set(candidates)]
  }

  private async historyRecords(
    commandRoot: HostPath,
    frontier: readonly string[],
    count: number,
    relativePath: string,
  ): Promise<readonly ParsedHistoryRecord[]> {
    const args = [
      'log',
      '--topo-order',
      '--parents',
      '--boundary',
      `-n${count}`,
      '--format=%m%x1f%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e',
      '--stdin',
      '--',
      relativePath,
    ]
    const result = await execReadOnlyGit(this.host, commandRoot, args, {
      input: `${frontier.join('\n')}\n`,
    })
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return result.stdout
      .split('\x1e')
      .map((record) => record.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
      .filter(Boolean)
      .map(parseHistoryRecord)
  }

  async blame(path: HostPath): Promise<readonly GitBlameRun[]> {
    const { commandRoot, relativePath } = await this.repoContext(path)
    const output = await this.run(
      commandRoot,
      ['blame', '--line-porcelain', '--', relativePath],
      64 * 1024 * 1024,
    )
    const runs: GitBlameRun[] = []
    let current:
      { hash: string; line: number; author: string; summary: string } | undefined
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
          runs[runs.length - 1] = {
            ...previous,
            lineCount: previous.lineCount + 1,
          }
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

  async commitDetail(projectRoot: HostPath, hash: string): Promise<GitCommitDetail> {
    assertRevision(hash)
    const context = await this.projectContext(projectRoot)
    if (!context) throw new Error('Not a Git repository')
    const { commandRoot, repositoryPrefix } = context
    const output = await this.run(commandRoot, [
      'show',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '--diff-merges=first-parent',
      '--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%B%x1e',
      '--numstat',
      '-z',
      hash,
      '--',
      '.',
    ])
    const separator = output.indexOf('\x1e')
    if (separator < 0) throw new Error('git show returned malformed commit detail')
    const [
      fullHash = '',
      shortHash = '',
      parentList = '',
      author = '',
      authoredAt = '',
      decorations = '',
      ...message
    ] = output.slice(0, separator).split('\x1f')
    const stats = parseNumstat(output.slice(separator + 1).replace(/^\r?\n/, ''))
    return {
      hash: fullHash,
      shortHash,
      parents: parentList.split(' ').filter(Boolean),
      refs: parseDecorations(decorations),
      author,
      authoredAt,
      subject: message.join('\x1f').trim().split('\n')[0] ?? '',
      message: message.join('\x1f').trim(),
      files: [...stats.entries()]
        .filter(([path]) => isInsideProject(path, repositoryPrefix))
        .map(([path, counts]) => ({
          path: projectFilePath(commandRoot, repositoryPrefix, path),
          ...counts,
        })),
    }
  }

  private async repoContext(path: HostPath): Promise<{
    readonly repositoryRoot: HostPath
    readonly commandRoot: HostPath
    readonly relativePath: string
  }> {
    this.assertHost(path)
    if (this.projectRoot) {
      const prefix = this.projectRoot.path === '/' ? '/' : `${this.projectRoot.path}/`
      if (!path.path.startsWith(prefix)) {
        throw new Error('Git path escapes the active project')
      }
      const context = await this.projectContext(this.projectRoot)
      if (!context) throw new Error('Not a Git repository')
      return {
        repositoryRoot: context.repositoryRoot,
        commandRoot: context.commandRoot,
        relativePath: `${context.repositoryPrefix}${path.path.slice(prefix.length)}`,
      }
    }
    const directory = dirnameHostPath(path)
    const root = (await this.run(directory, ['rev-parse', '--show-toplevel'])).trim()
    if (!root) throw new Error('git did not report a repository root')
    const prefix = await this.run(directory, ['rev-parse', '--show-prefix'])
    const normalizedPrefix = prefix.replace(/\r?\n$/, '')
    if (normalizedPrefix.startsWith('/') || normalizedPrefix.includes('../')) {
      throw new Error('git reported an invalid repository-relative prefix')
    }
    return {
      repositoryRoot: hostPath(path.hostId, root),
      commandRoot: this.projectRoot ?? hostPath(path.hostId, root),
      relativePath: `${normalizedPrefix}${basenameHostPath(path)}`,
    }
  }

  private async projectContext(projectRoot: HostPath): Promise<
    | {
        readonly repositoryRoot: HostPath
        readonly commandRoot: HostPath
        readonly repositoryPrefix: string
      }
    | undefined
  > {
    this.assertHost(projectRoot)
    const rootResult = await execReadOnlyGit(this.host, projectRoot, [
      'rev-parse',
      '--show-toplevel',
    ])
    if (rootResult.code !== 0) {
      if (/not a git repository/i.test(rootResult.stderr)) return undefined
      throw gitError(['rev-parse', '--show-toplevel'], rootResult.stderr, rootResult.code)
    }
    const root = rootResult.stdout.trim()
    if (!root) throw new Error('git did not report a repository root')
    const prefix = (await this.run(projectRoot, ['rev-parse', '--show-prefix'])).replace(
      /\r?\n$/,
      '',
    )
    if (prefix.startsWith('/') || prefix.split('/').includes('..')) {
      throw new Error('git reported an invalid repository-relative prefix')
    }
    return {
      repositoryRoot: hostPath(projectRoot.hostId, root),
      commandRoot: projectRoot,
      repositoryPrefix: prefix,
    }
  }

  private async defaultBranch(repoRoot: HostPath): Promise<string> {
    const symbolic = await this.tryRun(repoRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ])
    if (symbolic?.trim()) return symbolic.trim()

    for (const candidate of [
      'refs/remotes/origin/main',
      'refs/heads/main',
      'refs/remotes/origin/master',
      'refs/heads/master',
    ]) {
      const exists = await execReadOnlyGit(this.host, repoRoot, [
        'show-ref',
        '--verify',
        '--quiet',
        candidate,
      ])
      if (exists.code === 0) return candidate
    }

    throw new Error(
      'Cannot determine the default branch (no origin/HEAD, main, or master)',
    )
  }

  private async branchSync(
    repoRoot: HostPath,
    statusOutput: string,
  ): Promise<GitBranchSync> {
    const upstream = parseBranchTracking(statusOutput)
    let base: GitBranchSync['base']
    try {
      const defaultRef = await this.defaultBranch(repoRoot)
      const counts = await this.tryRun(repoRoot, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...${defaultRef}`,
      ])
      const parsed = counts ? parseAheadBehind(counts) : undefined
      if (parsed) {
        base = {
          name: shortRef(defaultRef),
          ahead: parsed.ahead,
          behind: parsed.behind,
        }
      }
    } catch {
      // Repositories without a conventional default branch still retain their
      // configured-upstream status. Base drift is additive information.
    }
    return {
      ...(upstream ? { upstream } : {}),
      ...(base ? { base } : {}),
    }
  }

  private async showOrEmpty(repoRoot: HostPath, revision: string): Promise<string> {
    const result = await execReadOnlyGit(this.host, repoRoot, ['show', revision])
    if (result.code === 0) return result.stdout
    // A path absent from the index/commit is an empty side of the diff, not a
    // fatal error (new and untracked files are common in agent worktrees).
    if (result.code === 128) return ''
    throw gitError(['show', revision], result.stderr, result.code)
  }

  private async readWorkingTreeOrEmpty(
    path: HostPath,
    commandRoot: HostPath,
    relativePath: string,
  ): Promise<string> {
    try {
      return await this.host.readTextFile(path)
    } catch (reason) {
      const trackedDeletion = await execReadOnlyGit(this.host, commandRoot, [
        'ls-files',
        '--deleted',
        '--error-unmatch',
        '--',
        relativePath,
      ])
      if (trackedDeletion.code === 0 && trackedDeletion.stdout.trim()) return ''
      throw reason
    }
  }

  private async run(
    repoRoot: HostPath,
    args: readonly string[],
    maxBuffer?: number,
  ): Promise<string> {
    const result = await execReadOnlyGit(this.host, repoRoot, args, {
      maxBuffer,
    })
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return result.stdout
  }

  private async tryRun(
    repoRoot: HostPath,
    args: readonly string[],
  ): Promise<string | undefined> {
    const result = await execReadOnlyGit(this.host, repoRoot, args)
    return result.code === 0 ? result.stdout : undefined
  }

  private assertHost(path: HostPath): void {
    if (path.hostId !== this.host.hostId) {
      throw new Error(`GitEngine received path for host '${path.hostId}'`)
    }
  }
}

/** Parse Git's NUL-delimited porcelain format without interpreting paths as text lines. */
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
      current = {
        root: hostPath(hostId, value),
        detached: false,
        bare: false,
      }
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

export function parseLocalBranches(output: string): readonly string[] {
  return output
    .split('\0')
    .map((branch) => branch.trim())
    .filter(Boolean)
}

function parseBranchTracking(output: string): GitBranchSync['upstream'] | undefined {
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

function parseAheadBehind(
  output: string,
): { readonly ahead: number; readonly behind: number } | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output)
  if (!match) return undefined
  return { ahead: Number(match[1]), behind: Number(match[2]) }
}

function assertBranchName(branch: string): void {
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
    hasForbiddenBranchCharacter(branch)
  ) {
    throw new Error('Invalid branch name')
  }
}

function hasForbiddenBranchCharacter(branch: string): boolean {
  return [...branch].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 32 || code === 127 || '~^:?*\\['.includes(character)
  })
}

/** Compatibility for Git versions predating `worktree list -z`. */
function parseLegacyWorktreeList(
  output: string,
  hostId: HostId,
): WorktreeDiscovery['worktrees'] {
  // Porcelain fields keep spaces after their key. Reject quoted paths rather
  // than misaddressing a workspace that legacy Git cannot represent safely.
  const fields = output.split(/\r?\n/).filter(Boolean).join('\0')
  return parseWorktreeList(fields, hostId)
}

function gitError(args: readonly string[], stderr: string, code: number | null): Error {
  const detail = stderr.trim() || `exit code ${String(code)}`
  return new Error(`git ${args.join(' ')} failed: ${detail}`)
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, '').replace(/^origin\//, '')
}

function assertRevision(revision: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(revision)) throw new Error('Invalid git revision')
}

interface ParsedStatus {
  readonly path: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly conflicted: boolean
}

function parseStatus(output: string): readonly ParsedStatus[] {
  const records = output.split('\0')
  const result: ParsedStatus[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? ''
    if (!record) continue
    if (record.startsWith('? ')) {
      result.push({
        path: record.slice(2),
        staged: false,
        unstaged: false,
        untracked: true,
        conflicted: false,
      })
      continue
    }
    if (record.startsWith('u ')) {
      const fields = record.split(' ')
      result.push({
        path: fields.slice(10).join(' '),
        staged: true,
        unstaged: true,
        untracked: false,
        conflicted: true,
      })
      continue
    }
    if (record.startsWith('1 ') || record.startsWith('2 ')) {
      const fields = record.split(' ')
      const xy = fields[1] ?? '..'
      const pathIndex = record.startsWith('2 ') ? 9 : 8
      result.push({
        path: fields.slice(pathIndex).join(' '),
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        untracked: false,
        conflicted: xy.includes('U'),
      })
      if (record.startsWith('2 ')) index += 1
    }
  }
  return result
}

function parseNumstat(
  output: string,
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
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
    result.set(path, {
      additions: added === '-' ? 0 : Number(added ?? 0),
      deletions: deleted === '-' ? 0 : Number(deleted ?? 0),
    })
  }
  return result
}

function mergeStats(
  ...sources: readonly Map<string, { additions: number; deletions: number }>[]
): Map<string, { additions: number; deletions: number }> {
  const merged = new Map<string, { additions: number; deletions: number }>()
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

function finiteInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback
}

type ParsedHistoryRecord = GitCommitSummary & { readonly boundary: boolean }

function parseHistoryRecord(record: string): ParsedHistoryRecord {
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

function parseDecorations(value: string): readonly string[] {
  // Git ref names cannot contain spaces, so `%D`'s ", " separator remains
  // unambiguous even though commas themselves are legal in a ref name.
  return value.split(', ').filter(Boolean)
}

const MAX_HISTORY_CURSOR_LENGTH = 128 * 1024
const MAX_HISTORY_FRONTIER = 2_048

function encodeHistoryCursor(frontier: readonly string[]): string {
  if (frontier.length === 0 || frontier.length > MAX_HISTORY_FRONTIER) {
    throw new Error('Git history continuation frontier is invalid')
  }
  return Buffer.from(JSON.stringify({ version: 1, frontier }), 'utf8').toString(
    'base64url',
  )
}

function decodeHistoryCursor(cursor: string): readonly string[] {
  if (!cursor || cursor.length > MAX_HISTORY_CURSOR_LENGTH) {
    throw new Error('Invalid Git history cursor')
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      version?: unknown
      frontier?: unknown
    }
    if (parsed.version !== 1 || !isHistoryFrontier(parsed.frontier)) {
      throw new Error('invalid payload')
    }
    return parsed.frontier
  } catch {
    throw new Error('Invalid Git history cursor')
  }
}

function isHistoryFrontier(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_HISTORY_FRONTIER &&
    value.every(
      (hash: unknown): hash is string =>
        typeof hash === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(hash),
    ) &&
    new Set(value).size === value.length
  )
}

function changedFile(
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

function emptyChanges(
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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function isInsideProject(repositoryPath: string, repositoryPrefix: string): boolean {
  return !repositoryPrefix || repositoryPath.startsWith(repositoryPrefix)
}

function excludeNestedWorktrees(
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

function isNestedHostPath(candidate: HostPath, parent: HostPath): boolean {
  const prefix = parent.path === '/' ? '/' : `${parent.path}/`
  return (
    candidate.hostId === parent.hostId &&
    candidate.path !== parent.path &&
    candidate.path.startsWith(prefix)
  )
}

function projectFilePath(
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

async function addUntrackedStats(
  projectRoot: HostPath,
  repositoryPrefix: string,
  files: readonly ParsedStatus[],
  stats: Map<string, { additions: number; deletions: number }>,
  host: ProjectHost,
): Promise<void> {
  const untracked = files.filter((file) => file.untracked && !stats.has(file.path))
  // Keep remote SFTP pressure bounded while still avoiding one-round-trip-at-a-time
  // latency for the common many-new-files agent workflow.
  for (let index = 0; index < untracked.length; index += 8) {
    await Promise.all(
      untracked.slice(index, index + 8).map(async (file) => {
        const relativePath = repositoryPrefix
          ? file.path.slice(repositoryPrefix.length)
          : file.path
        const result = await execReadOnlyGit(host, projectRoot, [
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
        stats.set(file.path, {
          additions: Number(added),
          deletions: Number(deleted),
        })
      }),
    )
  }
}

function execReadOnlyGit(
  host: ProjectHost,
  root: HostPath,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return host.exec('git', ['-C', root.path, ...args], {
    ...opts,
    // Background status/diff/history must never rewrite .git/index. Besides
    // being genuinely read-only, this prevents the index watcher from feeding
    // a Git refresh back into itself indefinitely.
    env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' },
  })
}

function execGit(
  host: ProjectHost,
  root: HostPath,
  args: readonly string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return host.exec('git', ['-C', root.path, ...args], opts)
}
