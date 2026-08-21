import { createHash } from 'node:crypto'

const COMPATIBILITY_TAG = /^hvir-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([1-9]\d*)$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const SOURCE_REPOSITORY = 'https://github.com/jarmak-personal/ghostty-web.git'
const PACKAGE_NAME = 'ghostty-web'
const ARTIFACT_PREFIX =
  'https://github.com/jarmak-personal/ghostty-web/releases/download/'

export const GHOSTTY_WEB_UPDATE_BRANCH = 'automation/ghostty-web-update'
export const GHOSTTY_WEB_UPDATE_MARKER = '<!-- hvir-ghostty-web-update:v1 -->'

export interface CompatibilityTag {
  readonly name: string
  readonly packageVersion: string
  readonly revision: number
  readonly version: readonly [number, number, number]
}

export interface ReleaseAsset {
  readonly digest: string | null
  readonly id: number
  readonly name: string
  readonly size: number
  readonly state: string
}

export interface GhosttyWebRelease {
  readonly assets: readonly ReleaseAsset[]
  readonly draft: boolean
  readonly immutable: boolean
  readonly prerelease: boolean
  readonly tagName: string
}

export interface SelectedGhosttyWebRelease extends GhosttyWebRelease {
  readonly tag: CompatibilityTag
}

export interface ReleaseAssetSet {
  readonly checksum: ReleaseAsset
  readonly provenance: ReleaseAsset
  readonly tarball: ReleaseAsset
}

export interface PackageSnapshot {
  readonly name: string
  readonly version: string
  readonly wasmBytes: number
}

export interface ValidatedGhosttyWebRelease {
  readonly artifactName: string
  readonly ghosttyCommit: string
  readonly npmIntegrity: string
  readonly packageVersion: string
  readonly revision: number
  readonly sha256: string
  readonly sourceCommit: string
  readonly tag: string
  readonly url: string
  readonly wasmBytes: number
}

export interface PinnedGhosttyWebArtifact {
  readonly artifactName: string
  readonly packageVersion: string
  readonly revision: number
  readonly tag: string
  readonly url: string
}

export interface UpdateDeliveryState {
  readonly closedUnmergedTag?: string
  readonly mergedTag?: string
  readonly openPullRequest?: {
    readonly headSha?: string
    readonly number: number
    readonly tag: string
  }
}

export type GhosttyWebUpdatePlan =
  | { readonly action: 'no-op'; readonly reason: 'main-current' | 'open-current' }
  | { readonly action: 'suppressed'; readonly rejectedTag: string }
  | { readonly action: 'prepare'; readonly mode: 'create' | 'coalesce' }

interface ProvenanceRecord {
  readonly artifact: string
  readonly ghosttyCommit: string
  readonly package: string
  readonly packageVersion: string
  readonly schemaVersion: number
  readonly sha256: string
  readonly sourceCommit: string
  readonly sourceRepository: string
}

export function parseCompatibilityTag(name: string): CompatibilityTag | undefined {
  const match = COMPATIBILITY_TAG.exec(name)
  if (!match) return undefined
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  const revision = Number(match[4])
  if (
    version.some((part) => !Number.isSafeInteger(part)) ||
    !Number.isSafeInteger(revision)
  ) {
    return undefined
  }
  return {
    name,
    packageVersion: `${version[0]}.${version[1]}.${version[2]}`,
    revision,
    version,
  }
}

export function compareCompatibilityTags(first: string, second: string): number {
  const left = requireCompatibilityTag(first)
  const right = requireCompatibilityTag(second)
  for (const index of [0, 1, 2] as const) {
    const difference = left.version[index] - right.version[index]
    if (difference !== 0) return difference
  }
  return left.revision - right.revision
}

export function selectNewestPublishedRelease(
  releases: readonly GhosttyWebRelease[],
): SelectedGhosttyWebRelease {
  const selected: SelectedGhosttyWebRelease[] = []
  const seen = new Set<string>()
  for (const release of releases) {
    if (release.draft || release.prerelease) continue
    const tag = parseCompatibilityTag(release.tagName)
    if (!tag) {
      if (release.tagName.startsWith('hvir-v')) {
        throw new Error('A published hvir compatibility release has an invalid tag.')
      }
      continue
    }
    if (!release.immutable) {
      throw new Error(`Published compatibility release ${tag.name} is not immutable.`)
    }
    if (seen.has(tag.name)) {
      throw new Error(`Published compatibility release ${tag.name} is duplicated.`)
    }
    seen.add(tag.name)
    selected.push({ ...release, tag })
  }
  selected.sort((first, second) =>
    compareCompatibilityTags(second.tag.name, first.tag.name),
  )
  const newest = selected[0]
  if (!newest) throw new Error('No published hvir compatibility release is available.')
  return newest
}

export function validateReleaseAssetSet(
  release: SelectedGhosttyWebRelease,
): ReleaseAssetSet {
  if (release.assets.length !== 3) {
    throw new Error(`Release ${release.tag.name} must contain exactly three assets.`)
  }
  const names = new Set(release.assets.map((asset) => asset.name))
  if (names.size !== release.assets.length) {
    throw new Error(`Release ${release.tag.name} contains duplicate asset names.`)
  }
  for (const asset of release.assets) validateAssetMetadata(asset, release.tag.name)

  const tarballs = release.assets.filter((asset) => asset.name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(
      `Release ${release.tag.name} must contain exactly one package tarball.`,
    )
  }
  const tarball = tarballs[0]!
  const expectedArtifact = new RegExp(
    `^ghostty-web-${escapeRegExp(release.tag.packageVersion)}-hvir-g[0-9a-f]{12}\\.tgz$`,
  )
  if (!expectedArtifact.test(tarball.name)) {
    throw new Error(`Release ${release.tag.name} has an invalid package filename.`)
  }
  const checksum = release.assets.find((asset) => asset.name === `${tarball.name}.sha256`)
  const provenance = release.assets.find(
    (asset) => asset.name === `${tarball.name}.provenance.json`,
  )
  if (!checksum || !provenance) {
    throw new Error(
      `Release ${release.tag.name} is missing its checksum or provenance asset.`,
    )
  }
  requireAssetSize(tarball, 10 * 1024 * 1024)
  requireAssetSize(checksum, 512)
  requireAssetSize(provenance, 16 * 1024)
  return { checksum, provenance, tarball }
}

export function validateDownloadedRelease(input: {
  readonly assets: ReleaseAssetSet
  readonly checksumBytes: Uint8Array
  readonly packageSnapshot: PackageSnapshot
  readonly provenanceBytes: Uint8Array
  readonly release: SelectedGhosttyWebRelease
  readonly tagCommit: string
  readonly tarballBytes: Uint8Array
}): ValidatedGhosttyWebRelease {
  const { assets, release } = input
  const tarballSha256 = digest('sha256', input.tarballBytes, 'hex')
  requireAssetDigest(assets.tarball, input.tarballBytes)
  requireAssetDigest(assets.checksum, input.checksumBytes)
  requireAssetDigest(assets.provenance, input.provenanceBytes)

  const checksum = decodeText(input.checksumBytes, 'checksum')
  const checksumPattern = new RegExp(
    `^([0-9a-f]{64})  ${escapeRegExp(assets.tarball.name)}\\n?$`,
  )
  const checksumMatch = checksumPattern.exec(checksum)
  if (!checksumMatch || checksumMatch[1] !== tarballSha256) {
    throw new Error(`Release ${release.tag.name} checksum does not match its tarball.`)
  }

  const provenance = parseProvenance(input.provenanceBytes)
  if (
    provenance.schemaVersion !== 1 ||
    provenance.package !== PACKAGE_NAME ||
    provenance.packageVersion !== release.tag.packageVersion ||
    provenance.artifact !== assets.tarball.name ||
    provenance.sha256 !== tarballSha256 ||
    provenance.sourceRepository !== SOURCE_REPOSITORY ||
    !COMMIT_SHA.test(provenance.sourceCommit) ||
    !COMMIT_SHA.test(provenance.ghosttyCommit)
  ) {
    throw new Error(`Release ${release.tag.name} provenance does not match its identity.`)
  }
  if (!COMMIT_SHA.test(input.tagCommit) || input.tagCommit !== provenance.sourceCommit) {
    throw new Error(
      `Release ${release.tag.name} tag does not resolve to its source commit.`,
    )
  }
  const expectedArtifact = `${PACKAGE_NAME}-${provenance.packageVersion}-hvir-g${provenance.sourceCommit.slice(0, 12)}.tgz`
  if (provenance.artifact !== expectedArtifact) {
    throw new Error(
      `Release ${release.tag.name} package filename does not match its source.`,
    )
  }
  if (
    input.packageSnapshot.name !== PACKAGE_NAME ||
    input.packageSnapshot.version !== provenance.packageVersion ||
    !Number.isSafeInteger(input.packageSnapshot.wasmBytes) ||
    input.packageSnapshot.wasmBytes <= 0 ||
    input.packageSnapshot.wasmBytes > 10 * 1024 * 1024
  ) {
    throw new Error(`Release ${release.tag.name} package metadata is invalid.`)
  }

  const npmIntegrity = `sha512-${digest('sha512', input.tarballBytes, 'base64')}`
  if (!NPM_INTEGRITY.test(npmIntegrity)) {
    throw new Error(`Release ${release.tag.name} npm integrity could not be derived.`)
  }
  const url = `${ARTIFACT_PREFIX}${release.tag.name}/${assets.tarball.name}`
  return {
    artifactName: assets.tarball.name,
    ghosttyCommit: provenance.ghosttyCommit,
    npmIntegrity,
    packageVersion: provenance.packageVersion,
    revision: release.tag.revision,
    sha256: tarballSha256,
    sourceCommit: provenance.sourceCommit,
    tag: release.tag.name,
    url,
    wasmBytes: input.packageSnapshot.wasmBytes,
  }
}

export function parsePinnedArtifactUrl(url: string): PinnedGhosttyWebArtifact {
  const pattern = new RegExp(
    `^${escapeRegExp(ARTIFACT_PREFIX)}(hvir-v[^/]+)/([^/]+\\.tgz)$`,
  )
  const match = pattern.exec(url)
  if (!match)
    throw new Error('The current ghostty-web dependency is not an exact release asset.')
  const tagName = match[1]
  const artifactName = match[2]
  if (!tagName || !artifactName) {
    throw new Error('The current ghostty-web dependency identity is incomplete.')
  }
  const tag = requireCompatibilityTag(tagName)
  const artifactPattern = new RegExp(
    `^ghostty-web-${escapeRegExp(tag.packageVersion)}-hvir-g[0-9a-f]{12}\\.tgz$`,
  )
  if (!artifactPattern.test(artifactName)) {
    throw new Error('The current ghostty-web dependency filename does not match its tag.')
  }
  return {
    artifactName,
    packageVersion: tag.packageVersion,
    revision: tag.revision,
    tag: tag.name,
    url,
  }
}

export function planGhosttyWebUpdate(
  currentTag: string,
  latestTag: string,
  delivery: UpdateDeliveryState,
): GhosttyWebUpdatePlan {
  const latestComparison = compareCompatibilityTags(latestTag, currentTag)
  if (latestComparison < 0) {
    throw new Error(
      `Newest published release ${latestTag} is older than current pin ${currentTag}.`,
    )
  }
  const open = delivery.openPullRequest
  if (open) {
    const openComparison = compareCompatibilityTags(open.tag, latestTag)
    if (openComparison > 0) {
      throw new Error(
        `Open update pull request #${open.number} is newer than ${latestTag}.`,
      )
    }
    if (openComparison === 0) return { action: 'no-op', reason: 'open-current' }
  }
  if (latestComparison === 0) {
    if (open) {
      throw new Error(
        `Open update pull request #${open.number} is stale after main advanced.`,
      )
    }
    return { action: 'no-op', reason: 'main-current' }
  }
  if (!open && delivery.closedUnmergedTag) {
    if (compareCompatibilityTags(delivery.closedUnmergedTag, latestTag) >= 0) {
      return { action: 'suppressed', rejectedTag: delivery.closedUnmergedTag }
    }
  }
  if (!open && delivery.mergedTag) {
    if (compareCompatibilityTags(delivery.mergedTag, latestTag) >= 0) {
      throw new Error(
        `Merged update ${delivery.mergedTag} is not reflected in current main.`,
      )
    }
  }
  return { action: 'prepare', mode: open ? 'coalesce' : 'create' }
}

export function createGhosttyWebPullRequest(input: {
  readonly currentTag: string
  readonly release: ValidatedGhosttyWebRelease
  readonly runUrl: string
}): { readonly body: string; readonly title: string } {
  const runUrl = new URL(input.runUrl)
  if (runUrl.protocol !== 'https:' || runUrl.hostname !== 'github.com') {
    throw new Error('The updater run URL must be an HTTPS github.com URL.')
  }
  const release = input.release
  const body = [
    '## Outcome',
    '',
    `Updates the immutable ghostty-web compatibility artifact from \`${input.currentTag}\` to \`${release.tag}\`. This automated dependency pull request intentionally has no governing issue and no closing relationship.`,
    '',
    '## Validated release',
    '',
    `- Release: \`${release.tag}\``,
    `- Package: \`ghostty-web@${release.packageVersion}\``,
    `- Artifact: \`${release.artifactName}\``,
    `- SHA-256: \`${release.sha256}\``,
    `- Source commit: \`${release.sourceCommit}\``,
    `- Ghostty commit: \`${release.ghosttyCommit}\``,
    '',
    'The updater verified the release tag, exact asset set, checksum, provenance, package metadata, npm integrity, clean installation, and hvir terminal-runtime contract before pushing this candidate.',
    '',
    '## Required gates',
    '',
    'This ordinary pull request must pass hvir verification, Electron, CodeQL, coherent-attempt aggregate, planning, branch-protection, and maintainer-review gates. Native certification remains release-owned. It is not automatically merged.',
    '',
    `Preparation run: ${runUrl.toString()}`,
    '',
    GHOSTTY_WEB_UPDATE_MARKER,
  ].join('\n')
  return {
    body,
    title: `deps: update ghostty-web to ${release.tag}`,
  }
}

export function releaseTagFromPullRequestBody(body: string): string {
  if (!body.includes(GHOSTTY_WEB_UPDATE_MARKER)) {
    throw new Error('The ghostty-web update pull request marker is missing.')
  }
  const matches = [...body.matchAll(/^- Release: `(hvir-v[^`]+)`$/gm)]
  if (matches.length !== 1) {
    throw new Error('The ghostty-web update pull request release identity is invalid.')
  }
  const releaseTag = matches[0]?.[1]
  if (!releaseTag) {
    throw new Error('The ghostty-web update pull request release identity is invalid.')
  }
  return requireCompatibilityTag(releaseTag).name
}

function requireCompatibilityTag(name: string): CompatibilityTag {
  const tag = parseCompatibilityTag(name)
  if (!tag) throw new Error(`Invalid ghostty-web compatibility tag: ${name}.`)
  return tag
}

function validateAssetMetadata(asset: ReleaseAsset, tag: string): void {
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.state !== 'uploaded' ||
    typeof asset.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(asset.digest)
  ) {
    throw new Error(`Release ${tag} contains invalid asset metadata.`)
  }
}

function requireAssetSize(asset: ReleaseAsset, maximum: number): void {
  if (asset.size > maximum) {
    throw new Error(`Release asset ${asset.name} exceeds its bounded size.`)
  }
}

function requireAssetDigest(asset: ReleaseAsset, bytes: Uint8Array): void {
  if (bytes.byteLength !== asset.size) {
    throw new Error(`Release asset ${asset.name} size does not match its metadata.`)
  }
  const expected = `sha256:${digest('sha256', bytes, 'hex')}`
  if (asset.digest !== expected) {
    throw new Error(`Release asset ${asset.name} digest does not match its metadata.`)
  }
}

function parseProvenance(bytes: Uint8Array): ProvenanceRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeText(bytes, 'provenance'))
  } catch {
    throw new Error('Release provenance is not valid JSON.')
  }
  if (!isRecord(parsed)) throw new Error('Release provenance is not an object.')
  return {
    artifact: requiredString(parsed.artifact),
    ghosttyCommit: requiredString(parsed.ghosttyCommit),
    package: requiredString(parsed.package),
    packageVersion: requiredString(parsed.packageVersion),
    schemaVersion: requiredNumber(parsed.schemaVersion),
    sha256: requiredString(parsed.sha256),
    sourceCommit: requiredString(parsed.sourceCommit),
    sourceRepository: requiredString(parsed.sourceRepository),
  }
}

function decodeText(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`Release ${name} is not valid UTF-8.`)
  }
}

function digest(
  algorithm: 'sha256' | 'sha512',
  bytes: Uint8Array,
  encoding: 'base64' | 'hex',
): string {
  return createHash(algorithm).update(bytes).digest(encoding)
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Release provenance is incomplete.')
  return value
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Release provenance is incomplete.')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
