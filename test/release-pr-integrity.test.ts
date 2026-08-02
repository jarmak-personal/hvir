import { describe, expect, it } from 'vitest'

import {
  evaluateReleasePrIntegrity,
  RELEASE_PR_AUTHOR,
  RELEASE_PR_MARKER,
  type ReleasePrIntegrityEvidence,
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

describe('release PR integrity', () => {
  it('accepts an exact version-only bot pull request', () => {
    expect(evaluateReleasePrIntegrity(evidence())).toEqual({
      accepted: true,
      version: '0.1.9',
    })
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
})
