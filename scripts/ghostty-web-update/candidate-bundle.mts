import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PreparedGhosttyWebUpdateResult } from './coordinator.mts'
import {
  compareCompatibilityTags,
  parseCompatibilityTag,
  parsePinnedArtifactUrl,
  type PinnedGhosttyWebArtifact,
  type UpdateDeliveryState,
  type ValidatedGhosttyWebRelease,
} from './policy.mts'
import {
  GHOSTTY_WEB_CANDIDATE_FILES,
  LocalCommandRunner,
  RepositoryGhosttyWebCandidate,
  updateCapabilityProfile,
  updatePackageJson,
  updatePackageLock,
  updateThirdPartyNotice,
  type CommandRunner,
} from './repository-candidate.mts'

const MANIFEST_FILE = 'manifest.json'
const FILE_SIZE_LIMITS: Readonly<
  Record<(typeof GHOSTTY_WEB_CANDIDATE_FILES)[number], number>
> = {
  'THIRD_PARTY_NOTICES.md': 512 * 1024,
  'package-lock.json': 2 * 1024 * 1024,
  'package.json': 256 * 1024,
  'scripts/ghostty-terminal-capability-profile.mts': 128 * 1024,
}

export interface GhosttyWebCandidateBundle {
  readonly baseSha: string
  readonly changedFiles: readonly string[]
  readonly current: PinnedGhosttyWebArtifact
  readonly delivery: UpdateDeliveryState
  readonly fileHashes: Readonly<Record<string, string>>
  readonly release: ValidatedGhosttyWebRelease
  readonly schemaVersion: 1
}

export async function writeCandidateBundle(
  bundleRoot: string,
  repositoryRoot: string,
  prepared: Extract<PreparedGhosttyWebUpdateResult, { readonly outcome: 'prepared' }>,
  runner: CommandRunner = new LocalCommandRunner(repositoryRoot),
): Promise<GhosttyWebCandidateBundle> {
  if (
    JSON.stringify([...prepared.candidate.changedFiles].sort()) !==
    JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)
  ) {
    throw new Error('Prepared ghostty-web candidate has an unexpected file set.')
  }
  const baseSha = (await runner.run('git', ['rev-parse', 'HEAD'])).stdout.trim()
  requireCommit(baseSha, 'candidate base')
  await mkdir(bundleRoot)
  const fileHashes: Record<string, string> = {}
  for (const path of GHOSTTY_WEB_CANDIDATE_FILES) {
    const target = join(bundleRoot, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(repositoryRoot, path), target)
    fileHashes[path] = await hashFile(target)
  }
  const bundle: GhosttyWebCandidateBundle = {
    baseSha,
    changedFiles: GHOSTTY_WEB_CANDIDATE_FILES,
    current: prepared.current,
    delivery: prepared.delivery,
    fileHashes,
    release: prepared.candidate.release,
    schemaVersion: 1,
  }
  await writeFile(join(bundleRoot, MANIFEST_FILE), `${JSON.stringify(bundle, null, 2)}\n`)
  return bundle
}

export async function readCandidateBundle(
  bundleRoot: string,
): Promise<GhosttyWebCandidateBundle> {
  const manifestPath = join(bundleRoot, MANIFEST_FILE)
  const manifestStat = await stat(manifestPath)
  if (!manifestStat.isFile() || manifestStat.size > 32 * 1024) {
    throw new Error('Ghostty-web candidate manifest exceeds its fixed boundary.')
  }
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  } catch {
    throw new Error('Ghostty-web candidate manifest is not valid JSON.')
  }
  const manifest = decodeBundle(manifestJson)
  const observedFiles = await enumerateFiles(bundleRoot)
  const expectedFiles = [...GHOSTTY_WEB_CANDIDATE_FILES, MANIFEST_FILE].sort()
  if (JSON.stringify(observedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('Ghostty-web candidate bundle contains an unexpected file set.')
  }
  for (const path of GHOSTTY_WEB_CANDIDATE_FILES) {
    const fileStat = await stat(join(bundleRoot, path))
    if (!fileStat.isFile() || fileStat.size > FILE_SIZE_LIMITS[path]) {
      throw new Error(`Ghostty-web candidate bundle exceeds its bound for ${path}.`)
    }
    if ((await hashFile(join(bundleRoot, path))) !== manifest.fileHashes[path]) {
      throw new Error(`Ghostty-web candidate bundle hash failed for ${path}.`)
    }
  }
  await new RepositoryGhosttyWebCandidate(bundleRoot).assertPreparedRelease(
    manifest.release,
  )
  return manifest
}

export async function applyCandidateBundle(
  bundleRoot: string,
  repositoryRoot: string,
  bundle: GhosttyWebCandidateBundle,
  runner: CommandRunner = new LocalCommandRunner(repositoryRoot),
): Promise<void> {
  const head = (await runner.run('git', ['rev-parse', 'HEAD'])).stdout.trim()
  if (head !== bundle.baseSha) {
    throw new Error('Ghostty-web candidate base changed before publication.')
  }
  const current = await new RepositoryGhosttyWebCandidate(repositoryRoot).readCurrentPin()
  if (JSON.stringify(current) !== JSON.stringify(bundle.current)) {
    throw new Error('Ghostty-web current pin changed before publication.')
  }
  await assertExactCandidateTransformation(bundleRoot, repositoryRoot, bundle.release)
  for (const path of GHOSTTY_WEB_CANDIDATE_FILES) {
    await copyFile(join(bundleRoot, path), join(repositoryRoot, path))
  }
  await runner.run('git', ['diff', '--check'])
  const changed = await runner.run('git', ['diff', '--name-only'])
  const changedFiles = changed.stdout.split('\n').filter(Boolean).sort()
  if (JSON.stringify(changedFiles) !== JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)) {
    throw new Error('Applied ghostty-web bundle changed an unexpected file set.')
  }
  await new RepositoryGhosttyWebCandidate(repositoryRoot).assertPreparedRelease(
    bundle.release,
  )
}

async function assertExactCandidateTransformation(
  bundleRoot: string,
  repositoryRoot: string,
  release: ValidatedGhosttyWebRelease,
): Promise<void> {
  const base = Object.fromEntries(
    await Promise.all(
      GHOSTTY_WEB_CANDIDATE_FILES.map(async (path) => [
        path,
        await readFile(join(repositoryRoot, path), 'utf8'),
      ]),
    ),
  ) as Record<(typeof GHOSTTY_WEB_CANDIDATE_FILES)[number], string>
  const expected: typeof base = {
    'THIRD_PARTY_NOTICES.md': updateThirdPartyNotice(
      base['THIRD_PARTY_NOTICES.md'],
      release.tag,
    ),
    'package-lock.json': updatePackageLock(base['package-lock.json'], release),
    'package.json': updatePackageJson(base['package.json'], release),
    'scripts/ghostty-terminal-capability-profile.mts': updateCapabilityProfile(
      base['scripts/ghostty-terminal-capability-profile.mts'],
      release,
    ),
  }
  for (const path of GHOSTTY_WEB_CANDIDATE_FILES) {
    if ((await readFile(join(bundleRoot, path), 'utf8')) !== expected[path]) {
      throw new Error(`Ghostty-web bundle changed ${path} outside its fixed update.`)
    }
  }
}

export function assertDeliveryStateUnchanged(
  expected: UpdateDeliveryState,
  observed: UpdateDeliveryState,
): void {
  if (deliveryKey(expected) !== deliveryKey(observed)) {
    throw new Error('Ghostty-web pull-request state changed before publication.')
  }
}

export function assertValidatedReleaseUnchanged(
  expected: ValidatedGhosttyWebRelease,
  observed: ValidatedGhosttyWebRelease,
): void {
  if (releaseKey(expected) !== releaseKey(observed)) {
    throw new Error('Ghostty-web release evidence changed before publication.')
  }
}

function decodeBundle(value: unknown): GhosttyWebCandidateBundle {
  const bundle = record(value, 'ghostty-web candidate manifest')
  if (bundle.schemaVersion !== 1) {
    throw new Error('Ghostty-web candidate manifest schema is unsupported.')
  }
  const baseSha = requiredString(bundle.baseSha, 'candidate base')
  requireCommit(baseSha, 'candidate base')
  if (
    !Array.isArray(bundle.changedFiles) ||
    JSON.stringify(bundle.changedFiles) !== JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)
  ) {
    throw new Error('Ghostty-web candidate manifest file set is invalid.')
  }
  const current = decodePin(bundle.current)
  const release = decodeRelease(bundle.release)
  if (compareCompatibilityTags(release.tag, current.tag) <= 0) {
    throw new Error('Ghostty-web candidate release is not newer than its base pin.')
  }
  const delivery = decodeDelivery(bundle.delivery)
  const hashes = record(bundle.fileHashes, 'ghostty-web candidate file hashes')
  if (
    JSON.stringify(Object.keys(hashes).sort()) !==
    JSON.stringify(GHOSTTY_WEB_CANDIDATE_FILES)
  ) {
    throw new Error('Ghostty-web candidate manifest hashes are incomplete.')
  }
  const fileHashes: Record<string, string> = {}
  for (const path of GHOSTTY_WEB_CANDIDATE_FILES) {
    const hash = hashes[path]
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Ghostty-web candidate manifest hash is invalid.')
    }
    fileHashes[path] = hash
  }
  return {
    baseSha,
    changedFiles: GHOSTTY_WEB_CANDIDATE_FILES,
    current,
    delivery,
    fileHashes,
    release,
    schemaVersion: 1,
  }
}

function decodePin(value: unknown): PinnedGhosttyWebArtifact {
  const pin = record(value, 'ghostty-web base pin')
  const url = requiredString(pin.url, 'ghostty-web base URL')
  const parsed = parsePinnedArtifactUrl(url)
  if (
    pin.artifactName !== parsed.artifactName ||
    pin.packageVersion !== parsed.packageVersion ||
    pin.revision !== parsed.revision ||
    pin.tag !== parsed.tag
  ) {
    throw new Error('Ghostty-web candidate base pin is inconsistent.')
  }
  return parsed
}

function decodeRelease(value: unknown): ValidatedGhosttyWebRelease {
  const release = record(value, 'validated ghostty-web release')
  const url = requiredString(release.url, 'ghostty-web release URL')
  const parsed = parsePinnedArtifactUrl(url)
  const sha256 = requiredString(release.sha256, 'ghostty-web SHA-256')
  const npmIntegrity = requiredString(release.npmIntegrity, 'ghostty-web npm integrity')
  const sourceCommit = requiredString(release.sourceCommit, 'ghostty-web source commit')
  const ghosttyCommit = requiredString(release.ghosttyCommit, 'Ghostty commit')
  const wasmBytes = release.wasmBytes
  if (
    release.artifactName !== parsed.artifactName ||
    release.packageVersion !== parsed.packageVersion ||
    release.revision !== parsed.revision ||
    release.tag !== parsed.tag ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(npmIntegrity) ||
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    !/^[0-9a-f]{40}$/.test(ghosttyCommit) ||
    typeof wasmBytes !== 'number' ||
    !Number.isSafeInteger(wasmBytes) ||
    wasmBytes <= 0 ||
    wasmBytes > 10 * 1024 * 1024
  ) {
    throw new Error('Validated ghostty-web release manifest is inconsistent.')
  }
  return {
    artifactName: parsed.artifactName,
    ghosttyCommit,
    npmIntegrity,
    packageVersion: parsed.packageVersion,
    revision: parsed.revision,
    sha256,
    sourceCommit,
    tag: parsed.tag,
    url,
    wasmBytes,
  }
}

function decodeDelivery(value: unknown): UpdateDeliveryState {
  const delivery = record(value, 'ghostty-web delivery state')
  const openValue = delivery.openPullRequest
  let openPullRequest: UpdateDeliveryState['openPullRequest']
  if (openValue !== undefined) {
    const open = record(openValue, 'open ghostty-web pull request')
    const headSha = requiredString(open.headSha, 'open ghostty-web head')
    requireCommit(headSha, 'open ghostty-web head')
    const number = open.number
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      throw new Error('Open ghostty-web pull request number is invalid.')
    }
    const tag = parsePinnedTag(requiredString(open.tag, 'open ghostty-web tag'))
    openPullRequest = { headSha, number, tag }
  }
  return {
    closedUnmergedTag: optionalTag(delivery.closedUnmergedTag),
    mergedTag: optionalTag(delivery.mergedTag),
    openPullRequest,
  }
}

function deliveryKey(value: UpdateDeliveryState): string {
  return JSON.stringify({
    closedUnmergedTag: value.closedUnmergedTag,
    mergedTag: value.mergedTag,
    openPullRequest: value.openPullRequest
      ? {
          headSha: value.openPullRequest.headSha,
          number: value.openPullRequest.number,
          tag: value.openPullRequest.tag,
        }
      : undefined,
  })
}

function releaseKey(value: ValidatedGhosttyWebRelease): string {
  return JSON.stringify({
    artifactName: value.artifactName,
    ghosttyCommit: value.ghosttyCommit,
    npmIntegrity: value.npmIntegrity,
    packageVersion: value.packageVersion,
    revision: value.revision,
    sha256: value.sha256,
    sourceCommit: value.sourceCommit,
    tag: value.tag,
    url: value.url,
    wasmBytes: value.wasmBytes,
  })
}

function optionalTag(value: unknown): string | undefined {
  return value === undefined
    ? undefined
    : parsePinnedTag(requiredString(value, 'release tag'))
}

function parsePinnedTag(value: string): string {
  const tag = parseCompatibilityTag(value)
  if (!tag) throw new Error('Ghostty-web delivery release tag is invalid.')
  return tag.name
}

async function enumerateFiles(root: string, relative = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...(await enumerateFiles(root, path)))
    } else if (entry.isFile()) {
      files.push(path)
    } else {
      throw new Error('Ghostty-web candidate bundle contains a non-file entry.')
    }
  }
  return files.sort()
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function requireCommit(value: string, name: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is not a full commit SHA.`)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is invalid.`)
  return value
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`)
  }
  return value as Record<string, unknown>
}
