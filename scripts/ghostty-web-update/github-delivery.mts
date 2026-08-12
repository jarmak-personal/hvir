import { execFile } from 'node:child_process'

import type { GhosttyWebDelivery, PreparedCandidate } from './coordinator.mts'
import { BoundedGitHubClient } from './github-client.mts'
import {
  compareCompatibilityTags,
  createGhosttyWebPullRequest,
  GHOSTTY_WEB_UPDATE_BRANCH,
  GHOSTTY_WEB_UPDATE_MARKER,
  parsePinnedArtifactUrl,
  releaseTagFromPullRequestBody,
  type PinnedGhosttyWebArtifact,
  type UpdateDeliveryState,
} from './policy.mts'
import {
  GHOSTTY_WEB_CANDIDATE_FILES,
  type CommandRunner,
} from './repository-candidate.mts'

interface PullRequestEvidence {
  readonly base: string
  readonly body: string
  readonly headRef: string
  readonly headRepository?: string
  readonly headSha: string
  readonly mergedAt: string | null
  readonly number: number
  readonly state: 'closed' | 'open'
}

export class GitHubGhosttyWebDelivery implements GhosttyWebDelivery {
  readonly #appSlug: string
  readonly #client: Pick<BoundedGitHubClient, 'json'>
  readonly #defaultBranch: string
  readonly #repository: string
  readonly #runUrl: string
  readonly #runner: CommandRunner

  constructor(options: {
    readonly appSlug: string
    readonly client: Pick<BoundedGitHubClient, 'json'>
    readonly defaultBranch: string
    readonly repository: string
    readonly root: string
    readonly runUrl: string
    readonly runner?: CommandRunner
  }) {
    if (!/^[A-Za-z0-9-]+$/.test(options.appSlug)) {
      throw new Error('Ghostty-web updater App slug is invalid.')
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new Error('Ghostty-web updater repository is invalid.')
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(options.defaultBranch)) {
      throw new Error('Ghostty-web updater default branch is invalid.')
    }
    this.#appSlug = options.appSlug
    this.#client = options.client
    this.#defaultBranch = options.defaultBranch
    this.#repository = options.repository
    this.#runUrl = options.runUrl
    this.#runner = options.runner ?? new GitCommandRunner(options.root)
  }

  async inspect(): Promise<UpdateDeliveryState> {
    const pullRequests = await this.#listPullRequests()
    const owned = pullRequests.filter(
      (pullRequest) =>
        pullRequest.headRef === GHOSTTY_WEB_UPDATE_BRANCH ||
        pullRequest.body.includes(GHOSTTY_WEB_UPDATE_MARKER),
    )
    const open = owned.filter((pullRequest) => pullRequest.state === 'open')
    if (open.length > 1) {
      throw new Error('Multiple open ghostty-web update pull requests require cleanup.')
    }
    for (const pullRequest of owned) this.#requireOwnedPullRequest(pullRequest)

    let openPullRequest: UpdateDeliveryState['openPullRequest']
    if (open[0]) {
      await this.#runner.run('git', [
        'fetch',
        'origin',
        `refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}:refs/remotes/origin/${GHOSTTY_WEB_UPDATE_BRANCH}`,
      ])
      const observed = (
        await this.#runner.run('git', [
          'rev-parse',
          `refs/remotes/origin/${GHOSTTY_WEB_UPDATE_BRANCH}`,
        ])
      ).stdout.trim()
      if (observed !== open[0].headSha) {
        throw new Error('Open ghostty-web update branch changed during inspection.')
      }
      const packageJsonText = (
        await this.#runner.run('git', ['show', `${observed}:package.json`])
      ).stdout
      const tag = pinFromPackageJson(packageJsonText).tag
      if (releaseTagFromPullRequestBody(open[0].body) !== tag) {
        throw new Error(
          'Open ghostty-web update pull request body does not match its branch.',
        )
      }
      openPullRequest = { headSha: observed, number: open[0].number, tag }
    }

    const closedUnmerged = owned.filter(
      (pullRequest) => pullRequest.state === 'closed' && pullRequest.mergedAt === null,
    )
    const merged = owned.filter((pullRequest) => pullRequest.mergedAt !== null)
    return {
      closedUnmergedTag: newestRecordedTag(closedUnmerged),
      mergedTag: newestRecordedTag(merged),
      openPullRequest,
    }
  }

  async publish(
    current: PinnedGhosttyWebArtifact,
    candidate: PreparedCandidate,
    delivery: UpdateDeliveryState,
  ): Promise<{ readonly pullRequestNumber: number; readonly url: string }> {
    const inspected = delivery
    const remoteHead = await this.#remoteBranchHead()
    if (inspected.openPullRequest && remoteHead !== inspected.openPullRequest.headSha) {
      throw new Error('Open ghostty-web update branch changed before publication.')
    }
    const bot = await this.#botIdentity()
    await this.#runner.run('git', ['config', 'user.name', bot.name])
    await this.#runner.run('git', ['config', 'user.email', bot.email])
    await this.#runner.run('git', ['switch', '-C', GHOSTTY_WEB_UPDATE_BRANCH])
    await this.#runner.run('git', ['add', ...candidate.changedFiles])
    const staged = await this.#runner.run('git', ['diff', '--cached', '--name-only'])
    const stagedFiles = staged.stdout.split('\n').filter(Boolean).sort()
    if (JSON.stringify(stagedFiles) !== JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)) {
      throw new Error('Ghostty-web update staged an unexpected file set.')
    }
    await this.#runner.run('git', [
      'commit',
      '-m',
      `deps: update ghostty-web to ${candidate.release.tag}`,
    ])
    const lease = `--force-with-lease=refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}:${remoteHead ?? ''}`
    await this.#runner.run('git', [
      'push',
      lease,
      'origin',
      `HEAD:refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}`,
    ])

    const pullRequest = createGhosttyWebPullRequest({
      currentTag: current.tag,
      release: candidate.release,
      runUrl: this.#runUrl,
    })
    if (inspected.openPullRequest) {
      const response = decodePullRequestMutation(
        await this.#client.json(
          `/repos/${this.#repository}/pulls/${inspected.openPullRequest.number}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: pullRequest.body, title: pullRequest.title }),
          },
        ),
      )
      return response
    }
    const response = decodePullRequestMutation(
      await this.#client.json(`/repos/${this.#repository}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: this.#defaultBranch,
          body: pullRequest.body,
          head: GHOSTTY_WEB_UPDATE_BRANCH,
          title: pullRequest.title,
        }),
      }),
    )
    return response
  }

  async #listPullRequests(): Promise<PullRequestEvidence[]> {
    const pullRequests: PullRequestEvidence[] = []
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.#client.json(
        `/repos/${this.#repository}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      )
      if (!Array.isArray(response))
        throw new Error('GitHub pull request listing is invalid.')
      pullRequests.push(...response.map(decodePullRequest))
      if (response.length < 100) return pullRequests
    }
    throw new Error('GitHub pull request listing exceeded its bounded pagination.')
  }

  #requireOwnedPullRequest(pullRequest: PullRequestEvidence): void {
    if (
      pullRequest.headRef !== GHOSTTY_WEB_UPDATE_BRANCH ||
      pullRequest.headRepository?.toLowerCase() !== this.#repository.toLowerCase() ||
      pullRequest.base !== this.#defaultBranch ||
      !pullRequest.body.includes(GHOSTTY_WEB_UPDATE_MARKER)
    ) {
      throw new Error(
        `Pull request #${pullRequest.number} conflicts with updater ownership.`,
      )
    }
  }

  async #remoteBranchHead(): Promise<string | undefined> {
    const output = await this.#runner.run('git', [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}`,
    ])
    const line = output.stdout.trim()
    if (line === '') return undefined
    const match = /^([0-9a-f]{40})\s+refs\/heads\/automation\/ghostty-web-update$/.exec(
      line,
    )
    if (!match) throw new Error('Remote ghostty-web update branch evidence is invalid.')
    return match[1]
  }

  async #botIdentity(): Promise<{ readonly email: string; readonly name: string }> {
    const login = `${this.#appSlug}[bot]`
    const response = record(
      await this.#client.json(`/users/${encodeURIComponent(login)}`),
      'GitHub App user',
    )
    const id = response.id
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      response.login !== login
    ) {
      throw new Error('GitHub App user identity is invalid.')
    }
    return {
      email: `${String(id)}+${login}@users.noreply.github.com`,
      name: login,
    }
  }
}

function decodePullRequest(value: unknown): PullRequestEvidence {
  const pullRequest = record(value, 'GitHub pull request')
  const base = record(pullRequest.base, 'GitHub pull request base')
  const head = record(pullRequest.head, 'GitHub pull request head')
  const headRepository =
    head.repo === null
      ? undefined
      : record(head.repo, 'GitHub pull request head repository')
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    (pullRequest.state !== 'open' && pullRequest.state !== 'closed') ||
    (pullRequest.body !== null && typeof pullRequest.body !== 'string') ||
    (pullRequest.merged_at !== null && typeof pullRequest.merged_at !== 'string') ||
    typeof base.ref !== 'string' ||
    typeof head.ref !== 'string' ||
    typeof head.sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(head.sha) ||
    (headRepository !== undefined && typeof headRepository.full_name !== 'string')
  ) {
    throw new Error('GitHub pull request evidence is incomplete.')
  }
  return {
    base: base.ref,
    body: pullRequest.body ?? '',
    headRef: head.ref,
    headRepository: headRepository?.full_name as string | undefined,
    headSha: head.sha,
    mergedAt: pullRequest.merged_at,
    number: pullRequest.number as number,
    state: pullRequest.state,
  }
}

function decodePullRequestMutation(value: unknown): {
  readonly pullRequestNumber: number
  readonly url: string
} {
  const pullRequest = record(value, 'GitHub pull request mutation')
  if (
    !Number.isSafeInteger(pullRequest.number) ||
    typeof pullRequest.html_url !== 'string'
  ) {
    throw new Error('GitHub pull request mutation response is incomplete.')
  }
  const url = new URL(pullRequest.html_url)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('GitHub pull request URL is invalid.')
  }
  return { pullRequestNumber: pullRequest.number as number, url: url.toString() }
}

function newestRecordedTag(
  pullRequests: readonly PullRequestEvidence[],
): string | undefined {
  const tags = pullRequests.map((pullRequest) =>
    releaseTagFromPullRequestBody(pullRequest.body),
  )
  tags.sort((first, second) => compareCompatibilityTags(second, first))
  return tags[0]
}

function pinFromPackageJson(source: string): PinnedGhosttyWebArtifact {
  let packageJson: unknown
  try {
    packageJson = JSON.parse(source)
  } catch {
    throw new Error('Open ghostty-web update package.json is invalid.')
  }
  const root = record(packageJson, 'Open ghostty-web update package.json')
  const dependencies = record(root.dependencies, 'Open ghostty-web update dependencies')
  if (typeof dependencies['ghostty-web'] !== 'string') {
    throw new Error('Open ghostty-web update pin is missing.')
  }
  return parsePinnedArtifactUrl(dependencies['ghostty-web'])
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`)
  }
  return value as Record<string, unknown>
}

class GitCommandRunner implements CommandRunner {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  run(
    command: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...arguments_],
        {
          cwd: this.#root,
          encoding: 'utf8',
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 2 * 60 * 1_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`${command} failed during ghostty-web delivery.`, {
                cause: stderr,
              }),
            )
            return
          }
          resolve({ stdout })
        },
      )
    })
  }
}
