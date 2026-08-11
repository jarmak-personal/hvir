import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyCandidateBundle,
  assertDeliveryStateUnchanged,
  assertValidatedReleaseUnchanged,
  readCandidateBundle,
  writeCandidateBundle,
} from '../scripts/ghostty-web-update/candidate-bundle.mts'
import { parsePinnedArtifactUrl } from '../scripts/ghostty-web-update/policy.mts'
import type { ValidatedGhosttyWebRelease } from '../scripts/ghostty-web-update/policy.mts'
import {
  GHOSTTY_WEB_CANDIDATE_FILES,
  RepositoryGhosttyWebCandidate,
  type CommandRunner,
} from '../scripts/ghostty-web-update/repository-candidate.mts'

const BASE_SHA = '1'.repeat(40)
const CURRENT = release('hvir-v0.4.0-14', 'a')
const NEXT = release('hvir-v0.4.0-15', 'b')

describe('ghostty-web candidate bundle', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hvir-ghostty-bundle-'))
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('accepts only the fixed, hash-bound candidate file set', async () => {
    const candidateRoot = join(root, 'candidate')
    const bundleRoot = join(root, 'bundle')
    await writeRepository(candidateRoot, NEXT)
    await writeCandidateBundle(
      bundleRoot,
      candidateRoot,
      preparedResult(),
      runner(() => Promise.resolve({ stdout: `${BASE_SHA}\n` })),
    )

    await expect(readCandidateBundle(bundleRoot)).resolves.toMatchObject({
      baseSha: BASE_SHA,
      changedFiles: GHOSTTY_WEB_CANDIDATE_FILES,
      release: { tag: NEXT.tag },
      schemaVersion: 1,
    })

    await writeFile(
      join(bundleRoot, 'package.json'),
      `${await readFile(join(bundleRoot, 'package.json'), 'utf8')} `,
    )
    await expect(readCandidateBundle(bundleRoot)).rejects.toThrow(
      /bundle hash failed for package.json/,
    )
  })

  it('revalidates the base, delivery state, exact diff, and release after application', async () => {
    const candidateRoot = join(root, 'candidate')
    const publicationRoot = join(root, 'publication')
    const bundleRoot = join(root, 'bundle')
    await Promise.all([
      writeRepository(candidateRoot, NEXT),
      writeRepository(publicationRoot, CURRENT),
    ])
    await writeCandidateBundle(
      bundleRoot,
      candidateRoot,
      preparedResult(),
      runner(() => Promise.resolve({ stdout: `${BASE_SHA}\n` })),
    )
    const bundle = await readCandidateBundle(bundleRoot)
    const commandRunner = runner((_command, arguments_) => {
      if (arguments_[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${BASE_SHA}\n` })
      }
      if (arguments_[0] === 'diff' && arguments_[1] === '--name-only') {
        return Promise.resolve({
          stdout: `${GHOSTTY_WEB_CANDIDATE_FILES.join('\n')}\n`,
        })
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(
      applyCandidateBundle(bundleRoot, publicationRoot, bundle, commandRunner),
    ).resolves.toBeUndefined()
    await expect(
      new RepositoryGhosttyWebCandidate(publicationRoot, commandRunner).readCurrentPin(),
    ).resolves.toMatchObject({ tag: NEXT.tag, url: NEXT.url })
    expect(() => assertDeliveryStateUnchanged({}, {})).not.toThrow()
    expect(() =>
      assertDeliveryStateUnchanged({}, { closedUnmergedTag: 'hvir-v0.4.0-15' }),
    ).toThrow(/state changed/)
    expect(() => assertValidatedReleaseUnchanged(NEXT, NEXT)).not.toThrow()
    expect(() =>
      assertValidatedReleaseUnchanged(NEXT, { ...NEXT, sha256: 'f'.repeat(64) }),
    ).toThrow(/release evidence changed/)
  })

  it('rejects a hash-consistent bundle with edits beyond the dependency update', async () => {
    const candidateRoot = join(root, 'candidate')
    const publicationRoot = join(root, 'publication')
    const bundleRoot = join(root, 'bundle')
    await Promise.all([
      writeRepository(candidateRoot, NEXT),
      writeRepository(publicationRoot, CURRENT),
    ])
    const packageJsonPath = join(candidateRoot, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<
      string,
      unknown
    >
    packageJson.scripts = { postinstall: 'untrusted-command' }
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
    await writeCandidateBundle(
      bundleRoot,
      candidateRoot,
      preparedResult(),
      runner(() => Promise.resolve({ stdout: `${BASE_SHA}\n` })),
    )
    const bundle = await readCandidateBundle(bundleRoot)
    const commandRunner = runner((_command, arguments_) =>
      Promise.resolve({
        stdout:
          arguments_[0] === 'rev-parse'
            ? `${BASE_SHA}\n`
            : `${GHOSTTY_WEB_CANDIDATE_FILES.join('\n')}\n`,
      }),
    )

    await expect(
      applyCandidateBundle(bundleRoot, publicationRoot, bundle, commandRunner),
    ).rejects.toThrow(/package.json outside its fixed update/)
  })
})

function preparedResult() {
  return {
    outcome: 'prepared' as const,
    current: parsePinnedArtifactUrl(CURRENT.url),
    candidate: { changedFiles: GHOSTTY_WEB_CANDIDATE_FILES, release: NEXT },
    delivery: {},
  }
}

function runner(implementation: CommandRunner['run']): CommandRunner {
  return { run: vi.fn(implementation) }
}

async function writeRepository(
  repositoryRoot: string,
  artifact: ValidatedGhosttyWebRelease,
): Promise<void> {
  await mkdir(join(repositoryRoot, 'scripts'), { recursive: true })
  await writeFile(
    join(repositoryRoot, 'package.json'),
    `${JSON.stringify({ dependencies: { 'ghostty-web': artifact.url } }, null, 2)}\n`,
  )
  await writeFile(
    join(repositoryRoot, 'package-lock.json'),
    `${JSON.stringify(
      {
        packages: {
          '': { dependencies: { 'ghostty-web': artifact.url } },
          'node_modules/ghostty-web': {
            integrity: artifact.npmIntegrity,
            resolved: artifact.url,
            version: artifact.packageVersion,
          },
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(repositoryRoot, 'scripts/ghostty-terminal-capability-profile.mts'),
    `export const profile = {
  artifact: {
    url: '${artifact.url}',
    sha256: '${artifact.sha256}',
    npmIntegrity: '${artifact.npmIntegrity}',
    sourceCommit: '${artifact.sourceCommit}',
    ghosttyCommit: '${artifact.ghosttyCommit}',
    wasmBytes: ${artifact.wasmBytes.toLocaleString('en-US').replaceAll(',', '_')},
  },
}\n`,
  )
  await writeFile(
    join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
    `A [ghostty-web compatibility fork](https://github.com/jarmak-personal/ghostty-web/releases/tag/${artifact.tag}).\n`,
  )
}

function release(tag: string, commitCharacter: string): ValidatedGhosttyWebRelease {
  const sourceCommit = commitCharacter.repeat(40)
  const revision = Number(tag.match(/-([0-9]+)$/)?.[1])
  const artifactName = `ghostty-web-0.4.0-hvir-g${sourceCommit.slice(0, 12)}.tgz`
  return {
    artifactName,
    ghosttyCommit: 'c'.repeat(40),
    npmIntegrity: `sha512-${Buffer.from(tag).toString('base64')}`,
    packageVersion: '0.4.0',
    revision,
    sha256: 'd'.repeat(64),
    sourceCommit,
    tag,
    url: `https://github.com/jarmak-personal/ghostty-web/releases/download/${tag}/${artifactName}`,
    wasmBytes: 523_293,
  }
}
