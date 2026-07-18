import type { GitHistoryPage, HostPath } from '../../shared'
import { gitError, type GitCommandContext } from './git-command-context'
import {
  MAX_HISTORY_FRONTIER,
  decodeHistoryCursor,
  encodeHistoryCursor,
  finiteInteger,
  parseHistoryRecord,
  type ParsedHistoryRecord,
} from './git-parsers'

export class GitHistoryCapability {
  constructor(private readonly context: GitCommandContext) {}

  async history(
    projectRoot: HostPath,
    limit: number,
    cursor?: string,
    path?: HostPath,
    allRefs = false,
  ): Promise<GitHistoryPage> {
    const context = await this.context.project(projectRoot)
    if (!context) return { repositoryState: 'not-git', commits: [], hasMore: false }
    const { commandRoot } = context
    const head = await this.context.tryRun(commandRoot, ['rev-parse', '--verify', 'HEAD'])
    if (!head?.trim()) {
      return { repositoryState: 'unborn', commits: [], hasMore: false }
    }
    const count = finiteInteger(limit, 50, 1, 200)
    const frontier = cursor
      ? decodeHistoryCursor(cursor)
      : allRefs
        ? await this.allRefTips(commandRoot, head.trim())
        : [head.trim()]
    const relativePath = path ? (await this.context.repository(path)).relativePath : '.'
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
    const output = await this.context.run(commandRoot, [
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
      for (const candidate of batch) if (candidate) candidates.push(candidate)
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
    const result = await this.context.readOnly(commandRoot, args, {
      input: `${frontier.join('\n')}\n`,
    })
    if (result.code !== 0) throw gitError(args, result.stderr, result.code)
    return result.stdout
      .split('\x1e')
      .map((record) => record.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
      .filter(Boolean)
      .map(parseHistoryRecord)
  }
}
