import type { captureContributorUsage } from '../capture-contributor-usage.mts'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GitHubCanonicalProject } from './canonical-project.ts'
import { GitHubClient } from './github-client.ts'
import { GitHubIssueRepository } from './github-issues.ts'
import { GitHubPullRequestRepository } from './github-pull-requests.ts'
import { GitHubSessionTokens } from './github-session-tokens.ts'
import { readGitHubAcceptance } from './github-contributor-acceptance.ts'
import {
  formatContributorStatus,
  contributorPullRequestRelationship,
  readContributorStatus,
  type ContributorStatusPorts,
} from './contributor-status.ts'
import {
  CONTRIBUTOR_STATUS_HELP,
  parseContributorStatusOptions,
} from './contributor-status-cli.ts'
import { assignSession } from '../agent-work-checkpoint-store.mts'
import { reconcilePlanningRecord } from './planning-record.ts'
import { parseProjectNumber, parseProjectRepository } from './project-config.ts'
import { captureSessionTokens } from './session-token-capture.ts'

async function main(): Promise<void> {
  const options = parseContributorStatusOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(CONTRIBUTOR_STATUS_HELP)
    return
  }
  const issueNumber = options.issue!
  const repository = process.env.HVIR_REPOSITORY ?? 'jarmak-personal/hvir'
  const [owner, name] = parseProjectRepository(repository)
  const repositoryClient = new GitHubClient({
    token: process.env.HVIR_REPO_TOKEN ?? '',
    purpose: 'repository',
  })
  const issues = new GitHubIssueRepository({ owner, name, client: repositoryClient })
  const prs = new GitHubPullRequestRepository({ owner, name, client: repositoryClient })
  // Missing Project credentials must not suppress repository or token facts.
  const project = process.env.HVIR_PROJECT_TOKEN
    ? new GitHubCanonicalProject({
        owner: process.env.HVIR_PROJECT_OWNER ?? 'jarmak-personal',
        number: parseProjectNumber(process.env.HVIR_PROJECT_NUMBER ?? '1'),
        repositoryOwner: owner,
        repositoryName: name,
        client: new GitHubClient({
          token: process.env.HVIR_PROJECT_TOKEN,
          purpose: 'Project',
        }),
      })
    : undefined
  const cache = new Map<number, ReturnType<typeof issues.getPlanningIssue>>()
  const readIssue = (number: number) => {
    let pending = cache.get(number)
    if (!pending) {
      pending = issues.getPlanningIssue(number)
      cache.set(number, pending)
    }
    return pending
  }
  const ports: ContributorStatusPorts = {
    issue: readIssue,
    project: async (number) => {
      if (!project) throw new Error('Project unavailable.')
      return (
        await reconcilePlanningRecord({ getPlanningIssue: readIssue }, project, {
          issueNumber: number,
          ensureProject: false,
          apply: false,
        })
      ).record.project
    },
    tokens: new GitHubSessionTokens(repositoryClient, owner, name),
    pullRequest: (number) => readGitHubAcceptance(repositoryClient, owner, name, number),
    relatedPullRequest: (number, selected) =>
      contributorPullRequestRelationship(
        {
          issue: readIssue,
          pullRequest: (pr) => prs.getPullRequest(pr),
          listEpicBranches: (parent) => prs.listEpicBranches(parent),
        },
        number,
        selected,
      ),
  }
  let captured: Awaited<ReturnType<typeof captureSessionTokens>> | undefined
  if (options.capture) {
    const provider = options.capture
    const session =
      provider === 'codex'
        ? process.env.CODEX_THREAD_ID
        : process.env.HVIR_USAGE_SESSION_ID
    if (!session)
      captured = { capture: 'unavailable (run-identity-unproven)', diagnostics: [] }
    else
      captured = await captureSessionTokens(
        {
          ...ports,
          assign: (apply) =>
            assignSession({
              root: join(homedir(), '.local', 'state', 'hvir', 'contributor-tokens'),
              repository,
              provider,
              session,
              issue: issueNumber,
              apply,
            }),
          observe: async () => {
            const { createServer } = await import('vite')
            const server = await createServer({
              appType: 'custom',
              configFile: false,
              server: { middlewareMode: true },
            })
            try {
              const runner = (await server.ssrLoadModule(
                '/scripts/capture-contributor-usage.mts',
              )) as { captureContributorUsage: typeof captureContributorUsage }
              const envName = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
              const value = process.env[envName]
              return await runner.captureContributorUsage({
                provider,
                session,
                cwd: process.env.HVIR_USAGE_CWD || process.cwd(),
                artifactEnvironment: value ? { [envName]: value } : {},
              })
            } finally {
              await server.close()
            }
          },
          project: async (number, tokens) => {
            if (!project) throw new Error('Project unavailable.')
            await project.setRecordedTokens(number, tokens)
          },
        },
        { issue: issueNumber, provider, apply: options.apply },
      )
  }
  const report = await readContributorStatus(ports, issueNumber, options.pr)
  if (captured) {
    report.capture = `${captured.capture}${captured.observedTokens === undefined ? '' : `; ${captured.observedTokens.toLocaleString('en-US')} observed session tokens`}`
    report.diagnostics.push(...captured.diagnostics)
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatContributorStatus(report),
  )
}

main().catch(() => {
  process.stderr.write(
    'Contributor status unavailable: check arguments and repository access.\n',
  )
  process.exitCode = 1
})
