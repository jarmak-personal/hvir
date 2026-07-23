#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { appendFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersionFiles = ['package-lock.json', 'package.json']
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

async function main() {
  const version = process.argv[2]
  if (!versionPattern.test(version ?? '')) {
    throw new Error(
      `Expected a release version like 1.2.3, received ${version ?? 'nothing'}.`,
    )
  }

  const repository = requiredEnvironment('GITHUB_REPOSITORY')
  const defaultBranch = requiredEnvironment('GITHUB_DEFAULT_BRANCH')
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const runUrl = `${serverUrl}/${repository}/actions/runs/${requiredEnvironment('GITHUB_RUN_ID')}`
  const tag = `v${version}`
  const branch = `release/${tag}`

  await assertVersionFiles(version)
  await assertOnlyVersionFilesChanged()

  const baseSha = await git('rev-parse', 'HEAD')
  const previousTag = await findPreviousTag(baseSha)
  const since = await findReleaseBoundary(previousTag)
  const closedIssues = await listClosedIssues(repository, since)

  await git('config', 'user.name', 'github-actions[bot]')
  await git(
    'config',
    'user.email',
    '41898282+github-actions[bot]@users.noreply.github.com',
  )
  await git('add', ...expectedVersionFiles)
  await git('commit', '-m', `Bump hvir to ${version} [skip ci]`)

  const localTree = await git('rev-parse', 'HEAD^{tree}')
  const remoteBranch = await run('git', [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`,
  ])

  if (remoteBranch.trim()) {
    await git('fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`)
    const remoteTree = await git('rev-parse', `refs/remotes/origin/${branch}^{tree}`)
    if (remoteTree !== localTree) {
      throw new Error(
        `Remote branch ${branch} already exists with different release contents.`,
      )
    }
  } else {
    await git('push', 'origin', `HEAD:refs/heads/${branch}`)
  }

  const existingPullRequest = await findOpenPullRequest(repository, branch)
  const pullRequestUrl =
    existingPullRequest ??
    (await createPullRequest({
      baseSha,
      branch,
      closedIssues,
      defaultBranch,
      previousTag,
      repository,
      runUrl,
      serverUrl,
      since,
      version,
    }))

  process.stdout.write(`Release PR: ${pullRequestUrl}\n`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    await appendFile(summaryPath, `\nRelease PR: ${pullRequestUrl}\n`)
  }
}

async function assertVersionFiles(version) {
  const rootPackage = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  )
  const lockfile = JSON.parse(
    await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8'),
  )
  const observed = [
    ['package.json', rootPackage.version],
    ['package-lock.json', lockfile.version],
    ['package-lock.json root package', lockfile.packages?.['']?.version],
  ]
  for (const [source, observedVersion] of observed) {
    if (observedVersion !== version) {
      throw new Error(`${source} contains ${observedVersion}, expected ${version}.`)
    }
  }
}

async function assertOnlyVersionFilesChanged() {
  const changedFiles = (await git('diff', '--name-only'))
    .split('\n')
    .filter(Boolean)
    .sort()
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedVersionFiles)) {
    throw new Error(
      `A release bump may change only ${expectedVersionFiles.join(', ')}; observed ${changedFiles.join(', ') || 'no changes'}.`,
    )
  }
}

async function findPreviousTag(baseSha) {
  const tag = await tryRun('git', ['describe', '--tags', '--abbrev=0', baseSha])
  return tag?.trim() || undefined
}

async function findReleaseBoundary(previousTag) {
  if (previousTag) {
    const publishedAt = await tryRun('gh', [
      'release',
      'view',
      previousTag,
      '--repo',
      requiredEnvironment('GITHUB_REPOSITORY'),
      '--json',
      'publishedAt',
      '--jq',
      '.publishedAt',
    ])
    if (publishedAt?.trim()) return publishedAt.trim()
    return git('show', '-s', '--format=%cI', previousTag)
  }

  const history = await git('log', '--reverse', '--format=%cI')
  const firstCommitDate = history.split('\n').find(Boolean)
  if (!firstCommitDate)
    throw new Error('Cannot determine the release changelog boundary.')
  return firstCommitDate
}

async function listClosedIssues(repository, since) {
  const output = await run('gh', [
    'issue',
    'list',
    '--repo',
    repository,
    '--state',
    'closed',
    '--search',
    `closed:>${since}`,
    '--limit',
    '1000',
    '--json',
    'number,title,url,closedAt',
  ])
  return JSON.parse(output).sort(
    (first, second) =>
      first.closedAt.localeCompare(second.closedAt) || first.number - second.number,
  )
}

async function findOpenPullRequest(repository, branch) {
  const output = await run('gh', [
    'pr',
    'list',
    '--repo',
    repository,
    '--head',
    branch,
    '--base',
    requiredEnvironment('GITHUB_DEFAULT_BRANCH'),
    '--state',
    'open',
    '--json',
    'url',
  ])
  return JSON.parse(output)[0]?.url
}

async function createPullRequest(input) {
  const issueLines = input.closedIssues.length
    ? input.closedIssues.map(
        (issue) => `- [#${issue.number}](${issue.url}) ${markdownText(issue.title)}`,
      )
    : ['- No issues were closed in this release window.']
  const boundaryDescription = input.previousTag
    ? `[${input.previousTag}](${input.serverUrl}/${input.repository}/releases/tag/${input.previousTag})`
    : `the first repository commit (${input.since})`
  const body = [
    `## hvir ${input.version}`,
    '',
    `Automated maintenance release from \`${input.baseSha}\`. This PR bumps the repository packages to \`${input.version}\`; its body is the release changelog and intentionally has no governing issue.`,
    '',
    `## Closed issues since ${boundaryDescription}`,
    '',
    ...issueLines,
    '',
    '## Release automation',
    '',
    `The [preparation run](${input.runUrl}) validated the bumped tree with \`npm run verify\` and the Electron smoke workflow before creating this commit. Merging this PR dispatches the existing Release workflow with \`current\` for the exact merged commit.`,
    '',
    `**Full changelog:** ${input.serverUrl}/${input.repository}/compare/${input.previousTag ?? input.baseSha}...${input.branch}`,
    '',
    '<!-- hvir-release-pr:v1 -->',
  ].join('\n')

  return (
    await run('gh', [
      'pr',
      'create',
      '--repo',
      input.repository,
      '--base',
      input.defaultBranch,
      '--head',
      input.branch,
      '--title',
      `Release hvir ${input.version}`,
      '--body',
      body,
    ])
  ).trim()
}

function markdownText(value) {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

async function git(...args) {
  return (await run('git', args)).trim()
}

async function run(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

async function tryRun(command, args) {
  try {
    return await run(command, args)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) return undefined
    throw error
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
