import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { GhosttyWebCandidateWorkspace, PreparedCandidate } from './coordinator.mts'
import {
  parsePinnedArtifactUrl,
  type PinnedGhosttyWebArtifact,
  type ValidatedGhosttyWebRelease,
} from './policy.mts'

export const GHOSTTY_WEB_CANDIDATE_FILES = [
  'THIRD_PARTY_NOTICES.md',
  'package-lock.json',
  'package.json',
  'scripts/ghostty-terminal-capability-profile.mts',
] as const

export interface CommandRunner {
  run(
    command: string,
    arguments_: readonly string[],
  ): Promise<{ readonly stdout: string }>
}

export class RepositoryGhosttyWebCandidate implements GhosttyWebCandidateWorkspace {
  readonly #root: string
  readonly #runner: CommandRunner

  constructor(root: string, runner: CommandRunner = new LocalCommandRunner(root)) {
    this.#root = root
    this.#runner = runner
  }

  async readCurrentPin(): Promise<PinnedGhosttyWebArtifact> {
    const [packageJsonText, packageLockText, profile, notices] = await Promise.all([
      this.#read('package.json'),
      this.#read('package-lock.json'),
      this.#read('scripts/ghostty-terminal-capability-profile.mts'),
      this.#read('THIRD_PARTY_NOTICES.md'),
    ])
    const packageJson = parseJsonRecord(packageJsonText, 'package.json')
    const dependencies = record(packageJson.dependencies, 'package.json dependencies')
    const url = requiredString(
      dependencies['ghostty-web'],
      'package.json ghostty-web pin',
    )
    const pin = parsePinnedArtifactUrl(url)

    const packageLock = parseJsonRecord(packageLockText, 'package-lock.json')
    const packages = record(packageLock.packages, 'package-lock packages')
    const rootPackage = record(packages[''], 'package-lock root package')
    const rootDependencies = record(
      rootPackage.dependencies,
      'package-lock root dependencies',
    )
    const lockedPackage = record(
      packages['node_modules/ghostty-web'],
      'ghostty-web lock entry',
    )
    if (
      rootDependencies['ghostty-web'] !== url ||
      lockedPackage.resolved !== url ||
      lockedPackage.version !== pin.packageVersion
    ) {
      throw new Error('The ghostty-web package and lockfile pins are inconsistent.')
    }
    const profileArtifact = extractProfileArtifact(profile)
    if (
      profileArtifact.url !== url ||
      profileArtifact.npmIntegrity !== lockedPackage.integrity
    ) {
      throw new Error('The ghostty-web capability evidence does not match the lockfile.')
    }
    const noticeTag = extractNoticeTag(notices)
    if (noticeTag !== pin.tag) {
      throw new Error(
        'The ghostty-web third-party notice does not match the current pin.',
      )
    }
    return pin
  }

  async prepareCandidate(
    release: ValidatedGhosttyWebRelease,
  ): Promise<PreparedCandidate> {
    const status = await this.#runner.run('git', [
      'status',
      '--porcelain',
      '--untracked-files=all',
    ])
    if (status.stdout.trim() !== '') {
      throw new Error('The ghostty-web update checkout must start clean.')
    }

    const [packageJsonSource, packageLockSource, profileSource, noticesSource] =
      await Promise.all([
        this.#read('package.json'),
        this.#read('package-lock.json'),
        this.#read('scripts/ghostty-terminal-capability-profile.mts'),
        this.#read('THIRD_PARTY_NOTICES.md'),
      ])
    const expectedPackageJson = updatePackageJson(packageJsonSource, release)
    const expectedProfile = updateCapabilityProfile(profileSource, release)
    const expectedNotices = updateThirdPartyNotice(noticesSource, release.tag)

    const packageJsonPath = join(this.#root, 'package.json')
    await writeFile(packageJsonPath, expectedPackageJson)

    const profilePath = join(
      this.#root,
      'scripts/ghostty-terminal-capability-profile.mts',
    )
    await writeFile(profilePath, expectedProfile)

    const noticesPath = join(this.#root, 'THIRD_PARTY_NOTICES.md')
    await writeFile(noticesPath, expectedNotices)

    await this.#runner.run('npm', [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ])
    const expectedLock = updatePackageLock(packageLockSource, release)
    await this.#assertFile('package-lock.json', expectedLock)
    await this.#assertGeneratedLockfile(release)
    await this.assertPreparedRelease(release)
    await this.#runner.run('npm', ['ci'])
    await this.#runner.run(process.execPath, ['scripts/check-terminal-runtime.mts'])
    await Promise.all([
      this.#assertFile('package.json', expectedPackageJson),
      this.#assertFile('package-lock.json', expectedLock),
      this.#assertFile(
        'scripts/ghostty-terminal-capability-profile.mts',
        expectedProfile,
      ),
      this.#assertFile('THIRD_PARTY_NOTICES.md', expectedNotices),
    ])
    await this.assertPreparedRelease(release)
    await this.#runner.run('git', ['diff', '--check'])

    const changed = await this.#runner.run('git', ['diff', '--name-only'])
    const changedFiles = changed.stdout.split('\n').filter(Boolean).sort()
    if (JSON.stringify(changedFiles) !== JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)) {
      throw new Error(
        `Ghostty-web update changed an unexpected file set: ${changedFiles.join(', ') || 'none'}.`,
      )
    }
    return { changedFiles, release }
  }

  async assertPreparedRelease(release: ValidatedGhosttyWebRelease): Promise<void> {
    const [pin, profile] = await Promise.all([
      this.readCurrentPin(),
      this.#read('scripts/ghostty-terminal-capability-profile.mts').then(
        extractProfileArtifact,
      ),
    ])
    if (
      pin.url !== release.url ||
      pin.tag !== release.tag ||
      pin.artifactName !== release.artifactName ||
      pin.packageVersion !== release.packageVersion ||
      pin.revision !== release.revision ||
      profile.url !== release.url ||
      profile.sha256 !== release.sha256 ||
      profile.npmIntegrity !== release.npmIntegrity ||
      profile.sourceCommit !== release.sourceCommit ||
      profile.ghosttyCommit !== release.ghosttyCommit ||
      profile.wasmBytes !== release.wasmBytes
    ) {
      throw new Error(
        'The prepared ghostty-web candidate does not match its release evidence.',
      )
    }
  }

  async #assertGeneratedLockfile(release: ValidatedGhosttyWebRelease): Promise<void> {
    const packageLock = parseJsonRecord(
      await this.#read('package-lock.json'),
      'package-lock.json',
    )
    const packages = record(packageLock.packages, 'package-lock packages')
    const rootPackage = record(packages[''], 'package-lock root package')
    const rootDependencies = record(
      rootPackage.dependencies,
      'package-lock root dependencies',
    )
    const lockedPackage = record(
      packages['node_modules/ghostty-web'],
      'ghostty-web lock entry',
    )
    if (
      rootDependencies['ghostty-web'] !== release.url ||
      lockedPackage.resolved !== release.url ||
      lockedPackage.integrity !== release.npmIntegrity ||
      lockedPackage.version !== release.packageVersion
    ) {
      throw new Error('npm did not generate the exact validated ghostty-web lock entry.')
    }
  }

  #read(path: string): Promise<string> {
    return readFile(join(this.#root, path), 'utf8')
  }

  async #assertFile(path: string, expected: string): Promise<void> {
    if ((await this.#read(path)) !== expected) {
      throw new Error(`Ghostty-web candidate changed ${path} outside its fixed update.`)
    }
  }
}

export function updatePackageJson(
  source: string,
  release: ValidatedGhosttyWebRelease,
): string {
  const packageJson = parseJsonRecord(source, 'package.json')
  const dependencies = record(packageJson.dependencies, 'package.json dependencies')
  dependencies['ghostty-web'] = release.url
  return `${JSON.stringify(packageJson, null, 2)}\n`
}

export function updatePackageLock(
  source: string,
  release: ValidatedGhosttyWebRelease,
): string {
  const packageLock = parseJsonRecord(source, 'package-lock.json')
  const packages = record(packageLock.packages, 'package-lock packages')
  const rootPackage = record(packages[''], 'package-lock root package')
  const rootDependencies = record(
    rootPackage.dependencies,
    'package-lock root dependencies',
  )
  const lockedPackage = record(
    packages['node_modules/ghostty-web'],
    'ghostty-web lock entry',
  )
  rootDependencies['ghostty-web'] = release.url
  lockedPackage.version = release.packageVersion
  lockedPackage.resolved = release.url
  lockedPackage.integrity = release.npmIntegrity
  return `${JSON.stringify(packageLock, null, 2)}\n`
}

export function updateCapabilityProfile(
  source: string,
  release: ValidatedGhosttyWebRelease,
): string {
  let updated = source
  updated = replaceUnique(updated, /(?<=\n {4}url: ')[^']+(?=',)/g, release.url, 'URL')
  updated = replaceUnique(
    updated,
    /(?<=\n {4}sha256: ')[0-9a-f]+(?=',)/g,
    release.sha256,
    'SHA-256',
  )
  updated = replaceUnique(
    updated,
    /(\n {4}npmIntegrity:\s*(?:\n\s*)?')[^']+(',)/g,
    `$1${release.npmIntegrity}$2`,
    'npm integrity',
  )
  updated = replaceUnique(
    updated,
    /(?<=\n {4}sourceCommit: ')[0-9a-f]+(?=',)/g,
    release.sourceCommit,
    'source commit',
  )
  updated = replaceUnique(
    updated,
    /(?<=\n {4}ghosttyCommit: ')[0-9a-f]+(?=',)/g,
    release.ghosttyCommit,
    'Ghostty commit',
  )
  updated = replaceUnique(
    updated,
    /(?<=\n {4}wasmBytes: )[0-9_]+(?=,)/g,
    formatInteger(release.wasmBytes),
    'WASM size',
  )
  return updated
}

export function updateThirdPartyNotice(source: string, tag: string): string {
  const pattern =
    /(?<=\[ghostty-web compatibility fork\]\(https:\/\/github\.com\/jarmak-personal\/ghostty-web\/releases\/tag\/)hvir-v[^)]+(?=\)\.)/g
  return replaceUnique(source, pattern, tag, 'third-party release reference')
}

function extractProfileArtifact(source: string): {
  readonly ghosttyCommit: string
  readonly npmIntegrity: string
  readonly sha256: string
  readonly sourceCommit: string
  readonly url: string
  readonly wasmBytes: number
} {
  const url = extractUnique(source, /(?<=\n {4}url: ')[^']+(?=',)/g, 'profile URL')
  const sha256 = extractUnique(
    source,
    /(?<=\n {4}sha256: ')[0-9a-f]+(?=',)/g,
    'profile SHA-256',
  )
  const integrityMatches = [
    ...source.matchAll(/\n {4}npmIntegrity:\s*(?:\n\s*)?'([^']+)',/g),
  ]
  const npmIntegrity = integrityMatches[0]?.[1]
  if (integrityMatches.length !== 1 || !npmIntegrity) {
    throw new Error('Expected one ghostty-web profile npm integrity.')
  }
  const sourceCommit = extractUnique(
    source,
    /(?<=\n {4}sourceCommit: ')[0-9a-f]+(?=',)/g,
    'profile source commit',
  )
  const ghosttyCommit = extractUnique(
    source,
    /(?<=\n {4}ghosttyCommit: ')[0-9a-f]+(?=',)/g,
    'profile Ghostty commit',
  )
  const wasmText = extractUnique(
    source,
    /(?<=\n {4}wasmBytes: )[0-9_]+(?=,)/g,
    'profile WASM size',
  )
  const wasmBytes = Number(wasmText.replaceAll('_', ''))
  if (!Number.isSafeInteger(wasmBytes) || wasmBytes <= 0) {
    throw new Error('The ghostty-web profile WASM size is invalid.')
  }
  return {
    ghosttyCommit,
    npmIntegrity,
    sha256,
    sourceCommit,
    url,
    wasmBytes,
  }
}

function extractNoticeTag(source: string): string {
  return extractUnique(
    source,
    /(?<=\[ghostty-web compatibility fork\]\(https:\/\/github\.com\/jarmak-personal\/ghostty-web\/releases\/tag\/)hvir-v[^)]+(?=\)\.)/g,
    'third-party release reference',
  )
}

function replaceUnique(
  source: string,
  pattern: RegExp,
  replacement: string,
  name: string,
): string {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`Expected one ghostty-web ${name}.`)
  return source.replace(pattern, replacement)
}

function extractUnique(source: string, pattern: RegExp, name: string): string {
  const matches = [...source.matchAll(pattern)]
  const match = matches[0]?.[0]
  if (matches.length !== 1 || !match) {
    throw new Error(`Expected one ghostty-web ${name}.`)
  }
  return match
}

function formatInteger(value: number): string {
  return value.toLocaleString('en-US').replaceAll(',', '_')
}

function parseJsonRecord(source: string, name: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${name} is invalid JSON.`)
  }
  return record(value, name)
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is invalid.`)
  return value
}

export class LocalCommandRunner implements CommandRunner {
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
          env: candidateEnvironment(),
          maxBuffer: 10 * 1024 * 1024,
          timeout: 15 * 60 * 1_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(`${command} failed during ghostty-web candidate preparation.`, {
                cause: stderr || error,
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

function candidateEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const name of [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'GH_TOKEN',
    'GITHUB_ENV',
    'GITHUB_OUTPUT',
    'GITHUB_PATH',
    'GITHUB_TOKEN',
    'HVIR_GITHUB_TOKEN',
  ]) {
    delete environment[name]
  }
  return environment
}
