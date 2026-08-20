import { appendFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

import {
  FULL_COMMIT_SHA_PATTERN,
  ReleaseGitHubEvidenceReader,
  requireFullCommitSha,
  requireReleaseEnvironment,
} from './release-github-evidence.mts'

export const RELEASE_PR_AUTHOR = 'github-actions[bot]'
export const RELEASE_PR_MARKER = '<!-- hvir-release-pr:v1 -->'
export const RELEASE_VERSION_FILES = ['package-lock.json', 'package.json'] as const

export type ReleasePrMode = 'pre-merge' | 'merged'

export interface ReleasePrIntegrityEvidence {
  mode: ReleasePrMode
  repository: string
  defaultBranch: string
  workflowActor?: string
  pullRequestNumber: number
  pullRequestState: string
  merged: boolean
  author: string
  baseBranch: string
  headRepository: string
  headBranch: string
  headSha: string
  expectedHeadSha: string
  mergeCommitSha: string | null
  sourceSha: string
  title: string
  body: string
  changedFiles: readonly string[]
  basePackage: unknown
  headPackage: unknown
  baseLockfile: unknown
  headLockfile: unknown
  sourcePackage: unknown
  sourceLockfile: unknown
}

export type ReleasePrIntegrityRejection =
  | 'invalid-workflow-actor'
  | 'invalid-state'
  | 'invalid-author'
  | 'invalid-base-branch'
  | 'invalid-head-repository'
  | 'invalid-head-sha'
  | 'invalid-source-sha'
  | 'invalid-release-branch'
  | 'invalid-title'
  | 'missing-automation-marker'
  | 'invalid-changed-files'
  | 'invalid-json-shape'
  | 'inconsistent-base-version'
  | 'invalid-version-bump'
  | 'inconsistent-release-version'
  | 'package-content-changed'
  | 'lockfile-content-changed'
  | 'release-source-mismatch'

export type ReleasePrIntegrityDecision =
  | { accepted: true; version: string }
  | { accepted: false; rejection: ReleasePrIntegrityRejection }

interface JsonObject {
  [key: string]: unknown
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rootLockPackage(lockfile: JsonObject): JsonObject | null {
  const packages = lockfile.packages
  if (!isJsonObject(packages)) return null
  const root = packages['']
  return isJsonObject(root) ? root : null
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference < 0n) return -1
    if (difference > 0n) return 1
  }
  return 0
}

function withoutPackageVersion(value: JsonObject): JsonObject {
  const copy = structuredClone(value)
  delete copy.version
  return copy
}

function withoutLockfileVersions(value: JsonObject): JsonObject {
  const copy = structuredClone(value)
  delete copy.version
  const root = rootLockPackage(copy)
  if (root) delete root.version
  return copy
}

export function evaluateReleasePrIntegrity(
  evidence: ReleasePrIntegrityEvidence,
): ReleasePrIntegrityDecision {
  if (evidence.mode === 'pre-merge') {
    if (evidence.workflowActor !== RELEASE_PR_AUTHOR) {
      return { accepted: false, rejection: 'invalid-workflow-actor' }
    }
    if (evidence.pullRequestState !== 'open' || evidence.merged) {
      return { accepted: false, rejection: 'invalid-state' }
    }
  } else if (evidence.pullRequestState !== 'closed' || !evidence.merged) {
    return { accepted: false, rejection: 'invalid-state' }
  }

  if (evidence.author !== RELEASE_PR_AUTHOR) {
    return { accepted: false, rejection: 'invalid-author' }
  }
  if (evidence.baseBranch !== evidence.defaultBranch) {
    return { accepted: false, rejection: 'invalid-base-branch' }
  }
  if (evidence.headRepository !== evidence.repository) {
    return { accepted: false, rejection: 'invalid-head-repository' }
  }
  if (
    !FULL_COMMIT_SHA_PATTERN.test(evidence.headSha) ||
    evidence.headSha !== evidence.expectedHeadSha
  ) {
    return { accepted: false, rejection: 'invalid-head-sha' }
  }
  if (!FULL_COMMIT_SHA_PATTERN.test(evidence.sourceSha)) {
    return { accepted: false, rejection: 'invalid-source-sha' }
  }
  if (
    (evidence.mode === 'pre-merge' && evidence.sourceSha !== evidence.headSha) ||
    (evidence.mode === 'merged' && evidence.sourceSha !== evidence.mergeCommitSha)
  ) {
    return { accepted: false, rejection: 'invalid-source-sha' }
  }

  const branchMatch = /^release\/v(.+)$/.exec(evidence.headBranch)
  const version = branchMatch?.[1]
  if (!version || !versionPattern.test(version)) {
    return { accepted: false, rejection: 'invalid-release-branch' }
  }
  if (evidence.title !== `Release hvir ${version}`) {
    return { accepted: false, rejection: 'invalid-title' }
  }
  if (!evidence.body.includes(RELEASE_PR_MARKER)) {
    return { accepted: false, rejection: 'missing-automation-marker' }
  }

  const changedFiles = [...evidence.changedFiles].sort()
  if (!isDeepStrictEqual(changedFiles, [...RELEASE_VERSION_FILES])) {
    return { accepted: false, rejection: 'invalid-changed-files' }
  }

  if (
    !isJsonObject(evidence.basePackage) ||
    !isJsonObject(evidence.headPackage) ||
    !isJsonObject(evidence.baseLockfile) ||
    !isJsonObject(evidence.headLockfile) ||
    !isJsonObject(evidence.sourcePackage) ||
    !isJsonObject(evidence.sourceLockfile)
  ) {
    return { accepted: false, rejection: 'invalid-json-shape' }
  }

  const baseRootLockPackage = rootLockPackage(evidence.baseLockfile)
  const headRootLockPackage = rootLockPackage(evidence.headLockfile)
  if (!baseRootLockPackage || !headRootLockPackage) {
    return { accepted: false, rejection: 'invalid-json-shape' }
  }

  const baseVersion = evidence.basePackage.version
  if (
    typeof baseVersion !== 'string' ||
    !versionPattern.test(baseVersion) ||
    evidence.baseLockfile.version !== baseVersion ||
    baseRootLockPackage.version !== baseVersion
  ) {
    return { accepted: false, rejection: 'inconsistent-base-version' }
  }
  if (compareVersions(version, baseVersion) <= 0) {
    return { accepted: false, rejection: 'invalid-version-bump' }
  }
  if (
    evidence.headPackage.version !== version ||
    evidence.headLockfile.version !== version ||
    headRootLockPackage.version !== version
  ) {
    return { accepted: false, rejection: 'inconsistent-release-version' }
  }

  if (
    !isDeepStrictEqual(
      withoutPackageVersion(evidence.basePackage),
      withoutPackageVersion(evidence.headPackage),
    )
  ) {
    return { accepted: false, rejection: 'package-content-changed' }
  }
  if (
    !isDeepStrictEqual(
      withoutLockfileVersions(evidence.baseLockfile),
      withoutLockfileVersions(evidence.headLockfile),
    )
  ) {
    return { accepted: false, rejection: 'lockfile-content-changed' }
  }
  if (
    !isDeepStrictEqual(evidence.sourcePackage, evidence.headPackage) ||
    !isDeepStrictEqual(evidence.sourceLockfile, evidence.headLockfile)
  ) {
    return { accepted: false, rejection: 'release-source-mismatch' }
  }

  return { accepted: true, version }
}

interface GitHubPullRequestResponse {
  number?: unknown
  state?: unknown
  merged?: unknown
  merged_at?: unknown
  merge_commit_sha?: unknown
  user?: { login?: unknown }
  base?: { ref?: unknown; sha?: unknown }
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null }
  title?: unknown
  body?: unknown
  changed_files?: unknown
}

interface GitHubPullRequestFile {
  filename?: unknown
}

interface GitHubContentResponse {
  type?: unknown
  encoding?: unknown
  content?: unknown
}

export interface ReleasePrIntegrityRequest {
  repository: string
  defaultBranch: string
  workflowActor?: string
  token: string
  mode: ReleasePrMode
  pullRequestNumber: number
  expectedHeadSha: string
  sourceSha: string
}

const githubEvidence = new ReleaseGitHubEvidenceReader('GitHub release PR evidence')

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('GitHub release PR evidence response was incomplete')
  }
  return value
}

function requirePullRequestNumber(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('RELEASE_PR_NUMBER is invalid')
  return Number(value)
}

function requireMode(value: string): ReleasePrMode {
  if (value !== 'pre-merge' && value !== 'merged') {
    throw new Error('RELEASE_PR_MODE is invalid')
  }
  return value
}

async function loadJsonFile(
  repository: string,
  path: string,
  ref: string,
  token: string,
): Promise<unknown> {
  const url = new URL(`https://api.github.com/repos/${repository}/contents/${path}`)
  url.searchParams.set('ref', ref)
  const response = await githubEvidence.requestJson<GitHubContentResponse>(url, token)
  if (
    response.type !== 'file' ||
    response.encoding !== 'base64' ||
    typeof response.content !== 'string'
  ) {
    throw new Error('GitHub release PR file evidence was incomplete')
  }
  try {
    return JSON.parse(Buffer.from(response.content, 'base64').toString('utf8')) as unknown
  } catch {
    throw new Error('GitHub release PR file evidence was invalid')
  }
}

export async function loadReleasePrIntegrityDecision(
  request: ReleasePrIntegrityRequest,
): Promise<ReleasePrIntegrityDecision> {
  const {
    repository,
    defaultBranch,
    token,
    mode,
    pullRequestNumber,
    expectedHeadSha,
    sourceSha,
  } = request
  const pullRequestUrl = new URL(
    `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`,
  )
  const pullRequest = await githubEvidence.requestJson<GitHubPullRequestResponse>(
    pullRequestUrl,
    token,
  )
  if (githubEvidence.requiredNumber(pullRequest.number) !== pullRequestNumber) {
    githubEvidence.incomplete()
  }

  const filesUrl = new URL(
    `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/files`,
  )
  filesUrl.searchParams.set('per_page', '100')
  const files = await githubEvidence.requestJson<GitHubPullRequestFile[]>(filesUrl, token)
  if (
    !Array.isArray(files) ||
    githubEvidence.requiredNumber(pullRequest.changed_files) !== files.length
  ) {
    throw new Error('GitHub release PR file evidence was incomplete')
  }

  const baseSha = requireFullCommitSha(
    'release PR base SHA',
    githubEvidence.requiredString(pullRequest.base?.sha),
  )
  const headSha = requireFullCommitSha(
    'release PR head SHA',
    githubEvidence.requiredString(pullRequest.head?.sha),
  )
  const fileCache = new Map<string, Promise<unknown>>()
  const loadFile = (path: string, ref: string): Promise<unknown> => {
    const key = `${ref}:${path}`
    const pending = fileCache.get(key) ?? loadJsonFile(repository, path, ref, token)
    fileCache.set(key, pending)
    return pending
  }
  const [
    basePackage,
    headPackage,
    baseLockfile,
    headLockfile,
    sourcePackage,
    sourceLockfile,
  ] = await Promise.all([
    loadFile('package.json', baseSha),
    loadFile('package.json', headSha),
    loadFile('package-lock.json', baseSha),
    loadFile('package-lock.json', headSha),
    loadFile('package.json', sourceSha),
    loadFile('package-lock.json', sourceSha),
  ])

  return evaluateReleasePrIntegrity({
    mode,
    repository,
    defaultBranch,
    ...(mode === 'pre-merge' ? { workflowActor: request.workflowActor } : {}),
    pullRequestNumber,
    pullRequestState: githubEvidence.requiredString(pullRequest.state),
    merged: requiredBoolean(pullRequest.merged),
    author: githubEvidence.requiredString(pullRequest.user?.login),
    baseBranch: githubEvidence.requiredString(pullRequest.base?.ref),
    headRepository: githubEvidence.requiredString(pullRequest.head?.repo?.full_name),
    headBranch: githubEvidence.requiredString(pullRequest.head?.ref),
    headSha,
    expectedHeadSha,
    mergeCommitSha: githubEvidence.nullableString(pullRequest.merge_commit_sha),
    sourceSha,
    title: githubEvidence.requiredString(pullRequest.title),
    body:
      pullRequest.body === null ? '' : githubEvidence.requiredString(pullRequest.body),
    changedFiles: files.map((file) => githubEvidence.requiredString(file.filename)),
    basePackage,
    headPackage,
    baseLockfile,
    headLockfile,
    sourcePackage,
    sourceLockfile,
  })
}

export async function validateReleasePullRequest(): Promise<string> {
  const pullRequestNumber = requirePullRequestNumber(
    requireReleaseEnvironment('RELEASE_PR_NUMBER'),
  )
  const mode = requireMode(requireReleaseEnvironment('RELEASE_PR_MODE'))
  const decision = await loadReleasePrIntegrityDecision({
    repository: requireReleaseEnvironment('GITHUB_REPOSITORY'),
    defaultBranch: requireReleaseEnvironment('GITHUB_DEFAULT_BRANCH'),
    ...(mode === 'pre-merge'
      ? { workflowActor: requireReleaseEnvironment('GITHUB_ACTOR') }
      : {}),
    token: requireReleaseEnvironment('GITHUB_TOKEN'),
    mode,
    pullRequestNumber,
    expectedHeadSha: requireFullCommitSha(
      'RELEASE_PR_HEAD_SHA',
      requireReleaseEnvironment('RELEASE_PR_HEAD_SHA'),
    ),
    sourceSha: requireFullCommitSha(
      'RELEASE_SOURCE_SHA',
      requireReleaseEnvironment('RELEASE_SOURCE_SHA'),
    ),
  })
  if (!decision.accepted) {
    throw new Error(`Release PR integrity rejected: ${decision.rejection}`)
  }

  const outputPath = process.env.GITHUB_OUTPUT
  if (outputPath) await appendFile(outputPath, `version=${decision.version}\n`)
  process.stdout.write(
    `Release PR #${pullRequestNumber} version integrity accepted for ${decision.version}.\n`,
  )
  return decision.version
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await validateReleasePullRequest()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown integrity error'
    process.stderr.write(`::error::${message}\n`)
    process.exitCode = 1
  }
}
