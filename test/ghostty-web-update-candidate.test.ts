import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GHOSTTY_WEB_CANDIDATE_FILES,
  RepositoryGhosttyWebCandidate,
  type CommandRunner,
} from '../scripts/ghostty-web-update/repository-candidate.mts'
import type { ValidatedGhosttyWebRelease } from '../scripts/ghostty-web-update/policy.mts'

const CURRENT_URL =
  'https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-14/ghostty-web-0.4.0-hvir-gaaaaaaaaaaaa.tgz'
const CURRENT_INTEGRITY = 'sha512-Y3VycmVudA=='

describe('ghostty-web repository candidate', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hvir-ghostty-candidate-'))
    await mkdir(join(root, 'scripts'))
    await writeFixture(root)
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('reads one consistent exact pin across package, lock, capability, and notice owners', async () => {
    const candidate = new RepositoryGhosttyWebCandidate(root, runner())

    await expect(candidate.readCurrentPin()).resolves.toMatchObject({
      packageVersion: '0.4.0',
      revision: 14,
      tag: 'hvir-v0.4.0-14',
      url: CURRENT_URL,
    })
  })

  it('updates only exact artifact evidence and validates the generated lock and runtime', async () => {
    const release = validatedRelease()
    const commands: Array<readonly [string, readonly string[]]> = []
    const commandRunner = runner(async (command, arguments_) => {
      commands.push([command, arguments_])
      if (command === 'npm' && arguments_[0] === 'install') {
        await writeLockfile(
          root,
          release.url,
          release.packageVersion,
          release.npmIntegrity,
        )
      }
      if (
        command === 'git' &&
        arguments_[0] === 'diff' &&
        arguments_[1] === '--name-only'
      ) {
        return { stdout: `${GHOSTTY_WEB_CANDIDATE_FILES.join('\n')}\n` }
      }
      return { stdout: '' }
    })
    const candidate = new RepositoryGhosttyWebCandidate(root, commandRunner)

    await expect(candidate.prepareCandidate(release)).resolves.toEqual({
      changedFiles: GHOSTTY_WEB_CANDIDATE_FILES,
      release,
    })
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>
    }
    expect(packageJson.dependencies['ghostty-web']).toBe(release.url)
    const profile = await readFile(
      join(root, 'scripts/ghostty-terminal-capability-profile.mts'),
      'utf8',
    )
    expect(profile).toContain(`url: '${release.url}'`)
    expect(profile).toContain(`sha256: '${release.sha256}'`)
    expect(profile).toContain(`npmIntegrity: '${release.npmIntegrity}'`)
    expect(profile).toContain(`sourceCommit: '${release.sourceCommit}'`)
    expect(profile).toContain(`ghosttyCommit: '${release.ghosttyCommit}'`)
    expect(profile).toContain('wasmBytes: 654_321')
    expect(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain(
      `/releases/tag/${release.tag})`,
    )
    expect(commands).toContainEqual([
      'npm',
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    ])
    expect(commands).toContainEqual(['npm', ['ci']])
    expect(commands).toContainEqual([
      process.execPath,
      ['scripts/check-terminal-runtime.mts'],
    ])
  })

  it('fails before changing files when the checkout is not clean', async () => {
    const commandRunner = runner(() => Promise.resolve({ stdout: '?? unrelated-file\n' }))
    const candidate = new RepositoryGhosttyWebCandidate(root, commandRunner)

    await expect(candidate.prepareCandidate(validatedRelease())).rejects.toThrow(
      /must start clean/,
    )
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>
    }
    expect(packageJson.dependencies['ghostty-web']).toBe(CURRENT_URL)
  })

  it('rejects candidate-time changes outside the fixed dependency transformation', async () => {
    const release = validatedRelease()
    const commandRunner = runner(async (command, arguments_) => {
      if (command === 'npm' && arguments_[0] === 'install') {
        await writeLockfile(
          root,
          release.url,
          release.packageVersion,
          release.npmIntegrity,
        )
      }
      if (command === 'npm' && arguments_[0] === 'ci') {
        const packageJsonPath = join(root, 'package.json')
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<
          string,
          unknown
        >
        packageJson.scripts = { postinstall: 'untrusted-command' }
        await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
      }
      return { stdout: '' }
    })

    await expect(
      new RepositoryGhosttyWebCandidate(root, commandRunner).prepareCandidate(release),
    ).rejects.toThrow(/package.json outside its fixed update/)
  })
})

function runner(
  implementation: CommandRunner['run'] = () => Promise.resolve({ stdout: '' }),
): CommandRunner {
  return { run: vi.fn(implementation) }
}

async function writeFixture(root: string): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ dependencies: { 'ghostty-web': CURRENT_URL } }, null, 2)}\n`,
  )
  await writeLockfile(root, CURRENT_URL, '0.4.0', CURRENT_INTEGRITY)
  await writeFile(
    join(root, 'scripts/ghostty-terminal-capability-profile.mts'),
    `export const profile = {
  artifact: {
    url: '${CURRENT_URL}',
    sha256: '${'1'.repeat(64)}',
    npmIntegrity: '${CURRENT_INTEGRITY}',
    sourceCommit: '${'a'.repeat(40)}',
    ghosttyCommit: '${'b'.repeat(40)}',
    wasmBytes: 523_293,
  },
}\n`,
  )
  await writeFile(
    join(root, 'THIRD_PARTY_NOTICES.md'),
    'A [ghostty-web compatibility fork](https://github.com/jarmak-personal/ghostty-web/releases/tag/hvir-v0.4.0-14).\n',
  )
}

async function writeLockfile(
  root: string,
  url: string,
  version: string,
  integrity: string,
): Promise<void> {
  await writeFile(
    join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        packages: {
          '': { dependencies: { 'ghostty-web': url } },
          'node_modules/ghostty-web': { version, resolved: url, integrity },
        },
      },
      null,
      2,
    )}\n`,
  )
}

function validatedRelease(): ValidatedGhosttyWebRelease {
  const sourceCommit = 'c'.repeat(40)
  const tag = 'hvir-v0.4.0-15'
  const artifactName = `ghostty-web-0.4.0-hvir-g${sourceCommit.slice(0, 12)}.tgz`
  return {
    artifactName,
    ghosttyCommit: 'd'.repeat(40),
    npmIntegrity: 'sha512-dXBkYXRlZA==',
    packageVersion: '0.4.0',
    revision: 15,
    sha256: 'e'.repeat(64),
    sourceCommit,
    tag,
    url: `https://github.com/jarmak-personal/ghostty-web/releases/download/${tag}/${artifactName}`,
    wasmBytes: 654_321,
  }
}
