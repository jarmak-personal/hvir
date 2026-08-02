import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import {
  evaluateReleasePrIntegrity,
  RELEASE_PR_AUTHOR,
  RELEASE_PR_MARKER,
  type ReleasePrIntegrityEvidence,
  validateReleasePullRequest,
} from '../scripts/validate-release-pr.mts'

const baseSha = '1111111111111111111111111111111111111111'
const headSha = '2222222222222222222222222222222222222222'
const mergeSha = '3333333333333333333333333333333333333333'

function packageJson(version: string): Record<string, unknown> {
  return {
    name: 'hvir',
    version,
    private: true,
    scripts: { verify: 'npm test' },
    dependencies: { electron: '1.0.0' },
  }
}

function lockfile(version: string): Record<string, unknown> {
  return {
    name: 'hvir',
    version,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'hvir',
        version,
        dependencies: { electron: '1.0.0' },
      },
      'node_modules/electron': {
        version: '1.0.0',
        integrity: 'sha512-example',
      },
    },
  }
}

function evidence(
  overrides: Partial<ReleasePrIntegrityEvidence> = {},
): ReleasePrIntegrityEvidence {
  const headPackage = packageJson('0.1.9')
  const headLockfile = lockfile('0.1.9')
  return {
    mode: 'pre-merge',
    repository: 'jarmak-personal/hvir',
    defaultBranch: 'main',
    workflowActor: RELEASE_PR_AUTHOR,
    pullRequestNumber: 407,
    pullRequestState: 'open',
    merged: false,
    author: RELEASE_PR_AUTHOR,
    baseBranch: 'main',
    headRepository: 'jarmak-personal/hvir',
    headBranch: 'release/v0.1.9',
    headSha,
    expectedHeadSha: headSha,
    mergeCommitSha: null,
    sourceSha: headSha,
    title: 'Release hvir 0.1.9',
    body: `Automated release\n\n${RELEASE_PR_MARKER}`,
    changedFiles: ['package.json', 'package-lock.json'],
    basePackage: packageJson('0.1.8'),
    headPackage,
    baseLockfile: lockfile('0.1.8'),
    headLockfile,
    sourcePackage: structuredClone(headPackage),
    sourceLockfile: structuredClone(headLockfile),
    ...overrides,
  }
}

function githubJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function githubContent(value: unknown, encoding = 'base64'): Response {
  return githubJson({
    type: 'file',
    encoding,
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
  })
}

function releasePrFetch(
  options: {
    changedFileCount?: number
    files?: string[]
    contentEncoding?: string
  } = {},
): ReturnType<typeof vi.fn> {
  const files = options.files ?? ['package.json', 'package-lock.json']
  return vi.fn((input: string | URL | Request) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    if (url.pathname.endsWith('/pulls/407/files')) {
      return Promise.resolve(githubJson(files.map((filename) => ({ filename }))))
    }
    if (url.pathname.endsWith('/pulls/407')) {
      return Promise.resolve(
        githubJson({
          number: 407,
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          user: { login: RELEASE_PR_AUTHOR },
          base: { ref: 'main', sha: baseSha },
          head: {
            ref: 'release/v0.1.9',
            sha: headSha,
            repo: { full_name: 'jarmak-personal/hvir' },
          },
          title: 'Release hvir 0.1.9',
          body: RELEASE_PR_MARKER,
          changed_files: options.changedFileCount ?? files.length,
        }),
      )
    }

    const ref = url.searchParams.get('ref')
    const version = ref === baseSha ? '0.1.8' : '0.1.9'
    if (url.pathname.endsWith('/contents/package.json')) {
      return Promise.resolve(githubContent(packageJson(version), options.contentEncoding))
    }
    if (url.pathname.endsWith('/contents/package-lock.json')) {
      return Promise.resolve(githubContent(lockfile(version), options.contentEncoding))
    }
    return Promise.resolve(githubJson({ error: 'unexpected test URL' }, 404))
  })
}

function stubValidationEnvironment(outputPath = ''): void {
  for (const [name, value] of Object.entries({
    GITHUB_REPOSITORY: 'jarmak-personal/hvir',
    GITHUB_DEFAULT_BRANCH: 'main',
    GITHUB_ACTOR: RELEASE_PR_AUTHOR,
    GITHUB_TOKEN: 'test-token',
    GITHUB_OUTPUT: outputPath,
    RELEASE_PR_MODE: 'pre-merge',
    RELEASE_PR_NUMBER: '407',
    RELEASE_PR_HEAD_SHA: headSha,
    RELEASE_SOURCE_SHA: headSha,
  })) {
    vi.stubEnv(name, value)
  }
}

describe('release PR integrity', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('accepts an exact version-only bot pull request', () => {
    expect(evaluateReleasePrIntegrity(evidence())).toEqual({
      accepted: true,
      version: '0.1.9',
    })
  })

  it.each([
    'release-github-evidence.mts',
    'require-release-ci-evidence.mts',
    'validate-release-pr.mts',
  ])('uses Node strip-only syntax in %s', (name) => {
    const result = spawnSync(
      process.execPath,
      ['--check', fileURLToPath(new URL(`../scripts/${name}`, import.meta.url))],
      { encoding: 'utf8' },
    )

    expect(result.status, result.stderr).toBe(0)
  })

  it('accepts the exact merged source without requiring the merger to be the bot', () => {
    expect(
      evaluateReleasePrIntegrity(
        evidence({
          mode: 'merged',
          workflowActor: 'jarmak-personal',
          pullRequestState: 'closed',
          merged: true,
          mergeCommitSha: mergeSha,
          sourceSha: mergeSha,
        }),
      ),
    ).toEqual({ accepted: true, version: '0.1.9' })
  })

  it.each([
    ['a closed unmerged pull request', { pullRequestState: 'closed' }, 'invalid-state'],
    [
      'a non-bot workflow actor',
      { workflowActor: 'maintainer' },
      'invalid-workflow-actor',
    ],
    ['a non-bot author', { author: 'maintainer' }, 'invalid-author'],
    ['another base', { baseBranch: 'epic/385-release-trust' }, 'invalid-base-branch'],
    ['a fork head', { headRepository: 'someone/hvir' }, 'invalid-head-repository'],
    ['another head SHA', { expectedHeadSha: baseSha }, 'invalid-head-sha'],
    ['another source SHA', { sourceSha: baseSha }, 'invalid-source-sha'],
    [
      'a merged source SHA that differs from its merge commit',
      {
        mode: 'merged',
        workflowActor: 'maintainer',
        pullRequestState: 'closed',
        merged: true,
        mergeCommitSha: mergeSha,
        sourceSha: headSha,
      },
      'invalid-source-sha',
    ],
    ['a malformed branch', { headBranch: 'release/v01.9.0' }, 'invalid-release-branch'],
    ['another title', { title: 'Release hvir 0.2.0' }, 'invalid-title'],
    ['a missing marker', { body: 'Automated release' }, 'missing-automation-marker'],
    [
      'another file',
      { changedFiles: ['package.json', 'README.md'] },
      'invalid-changed-files',
    ],
  ] satisfies Array<[string, Partial<ReleasePrIntegrityEvidence>, string]>)(
    'rejects %s',
    (_description, overrides, rejection) => {
      expect(evaluateReleasePrIntegrity(evidence(overrides))).toEqual({
        accepted: false,
        rejection,
      })
    },
  )

  it('rejects malformed or internally inconsistent base package evidence', () => {
    expect(evaluateReleasePrIntegrity(evidence({ basePackage: [] }))).toEqual({
      accepted: false,
      rejection: 'invalid-json-shape',
    })
    expect(
      evaluateReleasePrIntegrity(
        evidence({
          baseLockfile: { ...lockfile('0.1.8'), version: '0.1.7' },
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'inconsistent-base-version' })
  })

  it.each([
    ['package.json', { headPackage: packageJson('0.1.10') }],
    ['the lockfile root', { headLockfile: { ...lockfile('0.1.9'), version: '0.1.10' } }],
    [
      'the lockfile root package',
      {
        headLockfile: {
          ...lockfile('0.1.9'),
          packages: {
            ...(lockfile('0.1.9').packages as Record<string, unknown>),
            '': { name: 'hvir', version: '0.1.10' },
          },
        },
      },
    ],
  ] satisfies Array<[string, Partial<ReleasePrIntegrityEvidence>]>)(
    'rejects an inconsistent version in %s',
    (_description, overrides) => {
      expect(evaluateReleasePrIntegrity(evidence(overrides))).toEqual({
        accepted: false,
        rejection: 'inconsistent-release-version',
      })
    },
  )

  it('rejects an unchanged or decreasing release version', () => {
    expect(
      evaluateReleasePrIntegrity(
        evidence({
          headBranch: 'release/v0.1.8',
          title: 'Release hvir 0.1.8',
          headPackage: packageJson('0.1.8'),
          headLockfile: lockfile('0.1.8'),
          sourcePackage: packageJson('0.1.8'),
          sourceLockfile: lockfile('0.1.8'),
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'invalid-version-bump' })
  })

  it('rejects package content changes hidden beside the version bump', () => {
    expect(
      evaluateReleasePrIntegrity(
        evidence({
          headPackage: {
            ...packageJson('0.1.9'),
            dependencies: { electron: '2.0.0' },
          },
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'package-content-changed' })
  })

  it('rejects duplicated lockfile version mutations outside the owned root fields', () => {
    const changedLockfile = lockfile('0.1.9')
    const packages = changedLockfile.packages as Record<string, Record<string, unknown>>
    packages['node_modules/electron']!.version = '0.1.9'
    expect(
      evaluateReleasePrIntegrity(evidence({ headLockfile: changedLockfile })),
    ).toEqual({ accepted: false, rejection: 'lockfile-content-changed' })
  })

  it('rejects a merged source whose package pair differs from the validated head', () => {
    expect(
      evaluateReleasePrIntegrity(
        evidence({
          mode: 'merged',
          workflowActor: 'jarmak-personal',
          pullRequestState: 'closed',
          merged: true,
          mergeCommitSha: mergeSha,
          sourceSha: mergeSha,
          sourcePackage: packageJson('0.1.10'),
        }),
      ),
    ).toEqual({ accepted: false, rejection: 'release-source-mismatch' })
  })

  it('loads fail-closed API evidence and writes the validated workflow output', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'hvir-release-pr-'))
    onTestFinished(() => rm(temporaryDirectory, { recursive: true, force: true }))
    const outputPath = join(temporaryDirectory, 'output')
    stubValidationEnvironment(outputPath)
    const fetchMock = releasePrFetch()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await expect(validateReleasePullRequest()).resolves.toBe('0.1.9')

    await expect(readFile(outputPath, 'utf8')).resolves.toBe('version=0.1.9\n')
    expect(fetchMock).toHaveBeenCalledTimes(6)
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit | undefined)?.method).toBeUndefined()
    }
  })

  it('rejects a truncated changed-file response before loading contents', async () => {
    stubValidationEnvironment()
    const fetchMock = releasePrFetch({
      changedFileCount: 2,
      files: ['package.json'],
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(validateReleasePullRequest()).rejects.toThrow(
      'GitHub release PR file evidence was incomplete',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed content evidence', async () => {
    stubValidationEnvironment()
    vi.stubGlobal('fetch', releasePrFetch({ contentEncoding: 'utf-8' }))

    await expect(validateReleasePullRequest()).rejects.toThrow(
      'GitHub release PR file evidence was incomplete',
    )
  })

  it('reports only an API status when an evidence request fails', async () => {
    stubValidationEnvironment()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('sensitive response body', { status: 500 })),
      ),
    )

    const failure = validateReleasePullRequest()
    await expect(failure).rejects.toThrow(
      'GitHub release PR evidence request failed (500)',
    )
    await expect(failure).rejects.not.toThrow('sensitive response body')
  })
})
