import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GhosttyWebReleaseSource } from './coordinator.mts'
import { BoundedGitHubClient } from './github-client.mts'
import {
  parseCompatibilityTag,
  validateDownloadedRelease,
  validateReleaseAssetSet,
  type GhosttyWebRelease,
  type PackageSnapshot,
  type ReleaseAsset,
  type SelectedGhosttyWebRelease,
  type ValidatedGhosttyWebRelease,
} from './policy.mts'

const SOURCE_REPOSITORY = 'jarmak-personal/ghostty-web'
const MAX_RELEASE_PAGES = 10
const RELEASES_PER_PAGE = 100

export class GitHubGhosttyWebReleaseSource implements GhosttyWebReleaseSource {
  readonly #client: Pick<BoundedGitHubClient, 'bytes' | 'json'>

  constructor(
    client: Pick<BoundedGitHubClient, 'bytes' | 'json'> = new BoundedGitHubClient(),
  ) {
    this.#client = client
  }

  async listReleases(): Promise<readonly GhosttyWebRelease[]> {
    const releases: GhosttyWebRelease[] = []
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const response = await this.#client.json(
        `/repos/${SOURCE_REPOSITORY}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      )
      if (!Array.isArray(response)) throw new Error('GitHub release listing is invalid.')
      releases.push(...response.map(decodeRelease))
      if (response.length < RELEASES_PER_PAGE) return releases
    }
    throw new Error('GitHub release listing exceeded its bounded pagination.')
  }

  async validateRelease(release: GhosttyWebRelease): Promise<ValidatedGhosttyWebRelease> {
    const selected = requireSelectedRelease(release)
    const assets = validateReleaseAssetSet(selected)
    const [tarballBytes, checksumBytes, provenanceBytes, tagCommit] = await Promise.all([
      this.#download(assets.tarball.id, assets.tarball.size),
      this.#download(assets.checksum.id, assets.checksum.size),
      this.#download(assets.provenance.id, assets.provenance.size),
      this.#resolveTagCommit(selected.tag.name),
    ])
    const packageSnapshot = await inspectPackage(tarballBytes)
    return validateDownloadedRelease({
      assets,
      checksumBytes,
      packageSnapshot,
      provenanceBytes,
      release: selected,
      tagCommit,
      tarballBytes,
    })
  }

  #download(assetId: number, expectedBytes: number): Promise<Uint8Array> {
    return this.#client.bytes(
      `/repos/${SOURCE_REPOSITORY}/releases/assets/${assetId}`,
      { headers: { Accept: 'application/octet-stream' } },
      expectedBytes,
    )
  }

  async #resolveTagCommit(tag: string): Promise<string> {
    const reference = decodeGitObject(
      await this.#client.json(`/repos/${SOURCE_REPOSITORY}/git/ref/tags/${tag}`),
    )
    let object = reference
    for (let depth = 0; depth < 4; depth += 1) {
      if (object.type === 'commit') return object.sha
      if (object.type !== 'tag')
        throw new Error(`Release ${tag} resolves to an invalid object.`)
      object = decodeGitObject(
        await this.#client.json(`/repos/${SOURCE_REPOSITORY}/git/tags/${object.sha}`),
      )
    }
    throw new Error(`Release ${tag} has an excessively nested annotated tag.`)
  }
}

function decodeRelease(value: unknown): GhosttyWebRelease {
  const release = record(value, 'GitHub release')
  if (
    typeof release.tag_name !== 'string' ||
    typeof release.draft !== 'boolean' ||
    typeof release.immutable !== 'boolean' ||
    typeof release.prerelease !== 'boolean' ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('GitHub release metadata is incomplete.')
  }
  return {
    assets: release.assets.map(decodeAsset),
    draft: release.draft,
    immutable: release.immutable,
    prerelease: release.prerelease,
    tagName: release.tag_name,
  }
}

function decodeAsset(value: unknown): ReleaseAsset {
  const asset = record(value, 'GitHub release asset')
  if (
    !Number.isSafeInteger(asset.id) ||
    typeof asset.name !== 'string' ||
    !Number.isSafeInteger(asset.size) ||
    typeof asset.state !== 'string' ||
    (asset.digest !== null && typeof asset.digest !== 'string')
  ) {
    throw new Error('GitHub release asset metadata is incomplete.')
  }
  return {
    digest: asset.digest,
    id: asset.id as number,
    name: asset.name,
    size: asset.size as number,
    state: asset.state,
  }
}

function requireSelectedRelease(release: GhosttyWebRelease): SelectedGhosttyWebRelease {
  const tag = parseCompatibilityTag(release.tagName)
  if (!tag || release.draft || release.prerelease || !release.immutable) {
    throw new Error('Selected ghostty-web release is no longer eligible.')
  }
  return { ...release, tag }
}

function decodeGitObject(value: unknown): {
  readonly sha: string
  readonly type: string
} {
  const container = record(value, 'GitHub Git object')
  const candidate =
    'object' in container ? record(container.object, 'GitHub Git object') : container
  if (
    typeof candidate.sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(candidate.sha) ||
    typeof candidate.type !== 'string'
  ) {
    throw new Error('GitHub Git object metadata is incomplete.')
  }
  return { sha: candidate.sha, type: candidate.type }
}

async function inspectPackage(tarball: Uint8Array): Promise<PackageSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-ghostty-web-update-'))
  const archive = join(directory, 'package.tgz')
  try {
    await writeFile(archive, tarball)
    const packageJson = await extractTarMember(archive, 'package/package.json', 64 * 1024)
    const wasm = await extractTarMember(
      archive,
      'package/ghostty-vt.wasm',
      10 * 1024 * 1024,
    )
    let metadata: unknown
    try {
      metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packageJson))
    } catch {
      throw new Error('ghostty-web package metadata is invalid.')
    }
    const packageRecord = record(metadata, 'ghostty-web package')
    if (
      typeof packageRecord.name !== 'string' ||
      typeof packageRecord.version !== 'string'
    ) {
      throw new Error('ghostty-web package metadata is incomplete.')
    }
    return {
      name: packageRecord.name,
      version: packageRecord.version,
      wasmBytes: wasm.byteLength,
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

function extractTarMember(
  archive: string,
  member: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xOf', archive, member],
      {
        encoding: 'buffer',
        env: releaseInspectionEnvironment(),
        maxBuffer: maximumBytes,
        timeout: 30_000,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error(`ghostty-web package is missing ${member}.`, { cause: error }))
          return
        }
        resolve(new Uint8Array(stdout))
      },
    )
  })
}

function releaseInspectionEnvironment(): NodeJS.ProcessEnv {
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`)
  }
  return value as Record<string, unknown>
}
