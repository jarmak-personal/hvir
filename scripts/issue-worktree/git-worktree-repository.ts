import path from 'node:path'

import type { SystemRunner } from './system-runner.ts'
import {
  assertExactBaseRef,
  expectedBranchName,
  expectedBranchRef,
  expectedMarkerRef,
  expectedWorktreePath,
  parseWorktreeStatus,
  WORKFLOW_MARKER_PREFIX,
  WORKFLOW_VERSION,
  type WorktreeStatus,
} from './worktree-policy.ts'

const OWNED_CONFIG_SECTION = 'hvir-issue-worktree'

export interface OwnedWorktreeRecord {
  issueNumber: number
  markerRef: string
  markerOid: string
  version?: string
  branchRef?: string
  path?: string
  baseRef?: string
  baseOid?: string
}

export interface RegisteredWorktree {
  path: string
  headOid: string
  branchRef?: string
  detached: boolean
  lockedReason?: string
  prunableReason?: string
}

export interface UpstreamState {
  configuredForOrigin: boolean
  remoteRef: string
  remoteRefExists: boolean
}

export interface CreatedIssueWorktree {
  issueNumber: number
  branchRef: string
  path: string
  baseRef: string
  baseOid: string
}

export class GitWorktreeRepository {
  private readonly runner: SystemRunner
  readonly currentRoot: string
  readonly primaryRoot: string

  private constructor(runner: SystemRunner, currentRoot: string, primaryRoot: string) {
    this.runner = runner
    this.currentRoot = currentRoot
    this.primaryRoot = primaryRoot
  }

  static async open(runner: SystemRunner, cwd: string): Promise<GitWorktreeRepository> {
    const currentRoot = await gitValue(runner, cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
    ])
    const commonDirectory = await gitValue(runner, cwd, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
    const isBare = await gitValue(runner, cwd, ['rev-parse', '--is-bare-repository'])
    if (isBare !== 'false' || path.basename(commonDirectory) !== '.git') {
      throw new Error(
        'Issue worktrees require a non-bare repository with a .git common directory.',
      )
    }
    return new GitWorktreeRepository(runner, currentRoot, path.dirname(commonDirectory))
  }

  async fetchAndPrune(): Promise<void> {
    await this.git(['fetch', '--prune', 'origin'])
  }

  async resolveBase(baseRef: string): Promise<string> {
    assertExactBaseRef(baseRef)
    const shown = await this.git(['show-ref', '--verify', baseRef], [0, 1, 128])
    if (shown.exitCode !== 0) {
      throw new Error(`The exact base ref ${baseRef} does not exist after fetch/prune.`)
    }
    return gitValue(this.runner, this.currentRoot, [
      'rev-parse',
      '--verify',
      `${baseRef}^{commit}`,
    ])
  }

  async listOwnedRecords(): Promise<OwnedWorktreeRecord[]> {
    const result = await this.git([
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      WORKFLOW_MARKER_PREFIX,
    ])
    const records: OwnedWorktreeRecord[] = []
    for (const line of result.stdout.trim().split('\n')) {
      if (line === '') continue
      const separator = line.indexOf(' ')
      const markerRef = separator === -1 ? line : line.slice(0, separator)
      const markerOid = separator === -1 ? '' : line.slice(separator + 1)
      const match = /^refs\/hvir\/issue-worktrees\/([1-9]\d*)$/.exec(markerRef)
      if (match === null) continue
      const issueNumber = Number(match[1])
      const configPrefix = `${OWNED_CONFIG_SECTION}.${issueNumber}`
      records.push({
        issueNumber,
        markerRef,
        markerOid,
        ...optionalField('version', await this.config(`${configPrefix}.version`)),
        ...optionalField('branchRef', await this.config(`${configPrefix}.branch`)),
        ...optionalField('path', await this.config(`${configPrefix}.path`)),
        ...optionalField('baseRef', await this.config(`${configPrefix}.baseRef`)),
        ...optionalField('baseOid', await this.config(`${configPrefix}.baseOid`)),
      })
    }
    return records.sort((left, right) => left.issueNumber - right.issueNumber)
  }

  async hasOrphanedConfig(issueNumber: number): Promise<boolean> {
    return (
      (await this.config(`${OWNED_CONFIG_SECTION}.${issueNumber}.version`)) !== undefined
    )
  }

  async listWorktrees(): Promise<RegisteredWorktree[]> {
    const result = await this.git(['worktree', 'list', '--porcelain', '-z'])
    return parseWorktreeList(result.stdout)
  }

  async branchOid(branchRef: string): Promise<string | undefined> {
    const result = await this.git(
      ['show-ref', '--verify', '--hash', branchRef],
      [0, 1, 128],
    )
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  async upstreamState(issueNumber: number): Promise<UpstreamState> {
    const branchName = expectedBranchName(issueNumber)
    const remote = await this.config(`branch.${branchName}.remote`)
    const merge = await this.config(`branch.${branchName}.merge`)
    const remoteRef = `refs/remotes/origin/${branchName}`
    return {
      configuredForOrigin: remote === 'origin' && merge === `refs/heads/${branchName}`,
      remoteRef,
      remoteRefExists: (await this.branchOid(remoteRef)) !== undefined,
    }
  }

  async status(worktreePath: string): Promise<WorktreeStatus> {
    const result = await this.gitAt(worktreePath, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ])
    return parseWorktreeStatus(result.stdout)
  }

  pathExists(candidate: string): Promise<boolean> {
    return this.runner.pathExists(candidate)
  }

  expectedPath(issueNumber: number): string {
    return expectedWorktreePath(this.primaryRoot, issueNumber)
  }

  async create(
    issueNumber: number,
    baseRef: string,
    baseOid: string,
  ): Promise<CreatedIssueWorktree> {
    const branchRef = expectedBranchRef(issueNumber)
    const branchName = expectedBranchName(issueNumber)
    const worktreePath = this.expectedPath(issueNumber)
    await this.git(['worktree', 'add', '-b', branchName, worktreePath, baseRef])
    await this.setConfig(`branch.${branchName}.remote`, 'origin')
    await this.setConfig(`branch.${branchName}.merge`, branchRef)

    const configPrefix = `${OWNED_CONFIG_SECTION}.${issueNumber}`
    await this.setConfig(`${configPrefix}.version`, WORKFLOW_VERSION)
    await this.setConfig(`${configPrefix}.branch`, branchRef)
    await this.setConfig(`${configPrefix}.path`, worktreePath)
    await this.setConfig(`${configPrefix}.baseRef`, baseRef)
    await this.setConfig(`${configPrefix}.baseOid`, baseOid)
    await this.git(['update-ref', expectedMarkerRef(issueNumber), baseOid, ''])

    return { issueNumber, branchRef, path: worktreePath, baseRef, baseOid }
  }

  async remove(record: OwnedWorktreeRecord, headOid: string): Promise<void> {
    if (record.path === undefined) throw new Error('Owned worktree metadata has no path.')
    if (record.branchRef === undefined) {
      throw new Error('Owned worktree metadata has no branch ref.')
    }
    await this.git(['worktree', 'remove', record.path])
    await this.git(['update-ref', '-d', record.branchRef, headOid])
    await this.git(
      ['config', '--remove-section', `branch.${expectedBranchName(record.issueNumber)}`],
      [0, 5],
    )

    const configPrefix = `${OWNED_CONFIG_SECTION}.${record.issueNumber}`
    for (const name of ['version', 'branch', 'path', 'baseRef', 'baseOid']) {
      await this.git(['config', '--unset-all', `${configPrefix}.${name}`], [0, 5])
    }
    await this.git(['update-ref', '-d', record.markerRef, record.markerOid])
  }

  private git(args: readonly string[], acceptedExitCodes?: readonly number[]) {
    return this.gitAt(this.currentRoot, args, acceptedExitCodes)
  }

  private gitAt(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes?: readonly number[],
  ) {
    return this.runner.run('git', args, { cwd, acceptedExitCodes })
  }

  private async config(key: string): Promise<string | undefined> {
    const result = await this.git(['config', '--get', key], [0, 1])
    return result.exitCode === 0 ? result.stdout.trim() : undefined
  }

  private async setConfig(key: string, value: string): Promise<void> {
    await this.git(['config', key, value])
  }
}

function parseWorktreeList(output: string): RegisteredWorktree[] {
  const worktrees: RegisteredWorktree[] = []
  for (const block of output.split('\0\0')) {
    if (block === '') continue
    const fields = block.split('\0')
    const worktreePath = fieldValue(fields, 'worktree ')
    const headOid = fieldValue(fields, 'HEAD ')
    if (worktreePath === undefined || headOid === undefined) {
      throw new Error('Git returned an incomplete worktree record.')
    }
    const branchRef = fieldValue(fields, 'branch ')
    const lockedReason = fields.includes('locked') ? '' : fieldValue(fields, 'locked ')
    const prunableReason = fieldValue(fields, 'prunable ')
    worktrees.push({
      path: worktreePath,
      headOid,
      ...(branchRef === undefined ? {} : { branchRef }),
      detached: fields.includes('detached'),
      ...(lockedReason === undefined ? {} : { lockedReason }),
      ...(prunableReason === undefined ? {} : { prunableReason }),
    })
  }
  return worktrees
}

function fieldValue(fields: readonly string[], prefix: string): string | undefined {
  const field = fields.find((candidate) => candidate.startsWith(prefix))
  return field?.slice(prefix.length)
}

function optionalField<Key extends string>(
  key: Key,
  value: string | undefined,
): { [Property in Key]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [Property in Key]: string })
}

async function gitValue(
  runner: SystemRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run('git', args, { cwd })
  return result.stdout.trim()
}
