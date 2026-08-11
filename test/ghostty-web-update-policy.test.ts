import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  compareCompatibilityTags,
  createGhosttyWebPullRequest,
  GHOSTTY_WEB_UPDATE_MARKER,
  parsePinnedArtifactUrl,
  planGhosttyWebUpdate,
  releaseTagFromPullRequestBody,
  selectNewestPublishedRelease,
  validateDownloadedRelease,
  validateReleaseAssetSet,
  type GhosttyWebRelease,
  type ReleaseAsset,
  type SelectedGhosttyWebRelease,
  type ValidatedGhosttyWebRelease,
} from '../scripts/ghostty-web-update/policy.mts'

const SOURCE_COMMIT = 'a'.repeat(40)
const GHOSTTY_COMMIT = 'b'.repeat(40)

describe('ghostty-web compatibility release policy', () => {
  it('orders package versions before numeric compatibility revisions', () => {
    expect(compareCompatibilityTags('hvir-v0.4.0-10', 'hvir-v0.4.0-9')).toBeGreaterThan(0)
    expect(compareCompatibilityTags('hvir-v0.5.0-1', 'hvir-v0.4.0-99')).toBeGreaterThan(0)
    expect(compareCompatibilityTags('hvir-v1.0.0-1', 'hvir-v0.99.99-99')).toBeGreaterThan(
      0,
    )
  })

  it('selects the newest immutable published compatibility release only', () => {
    const selected = selectNewestPublishedRelease([
      release('v0.5.0'),
      release('hvir-v0.5.0-2', { prerelease: true }),
      release('hvir-v0.4.0-15'),
      release('hvir-v0.5.0-1'),
      release('hvir-v0.4.0-16', { draft: true }),
    ])

    expect(selected.tag.name).toBe('hvir-v0.5.0-1')
  })

  it('fails closed on malformed or mutable published hvir releases', () => {
    expect(() => selectNewestPublishedRelease([release('hvir-v0.4-15')])).toThrow(
      /invalid tag/,
    )
    expect(() =>
      selectNewestPublishedRelease([release('hvir-v0.4.0-15', { immutable: false })]),
    ).toThrow(/not immutable/)
    expect(() =>
      selectNewestPublishedRelease([
        release('hvir-v0.4.0-15'),
        release('hvir-v0.4.0-15'),
      ]),
    ).toThrow(/duplicated/)
  })

  it('requires exactly one tarball with its matching checksum and provenance', () => {
    const selected = selectedRelease('hvir-v0.4.0-15')
    expect(validateReleaseAssetSet(selected).tarball.name).toContain(
      `g${SOURCE_COMMIT.slice(0, 12)}`,
    )
    expect(() =>
      validateReleaseAssetSet({ ...selected, assets: selected.assets.slice(0, 2) }),
    ).toThrow(/exactly three assets/)
    expect(() =>
      validateReleaseAssetSet({
        ...selected,
        assets: [...selected.assets.slice(0, 2), asset('unexpected.txt', bytes('x'), 9)],
      }),
    ).toThrow(/missing its checksum or provenance/)
  })

  it('validates checksums, provenance, tag source, package identity, and npm integrity', () => {
    const fixture = downloadedRelease()
    const validated = validateDownloadedRelease(fixture)

    expect(validated).toMatchObject({
      ghosttyCommit: GHOSTTY_COMMIT,
      packageVersion: '0.4.0',
      sha256: sha256(fixture.tarballBytes),
      sourceCommit: SOURCE_COMMIT,
      tag: 'hvir-v0.4.0-15',
      wasmBytes: 523_293,
    })
    expect(validated.npmIntegrity).toBe(
      `sha512-${createHash('sha512').update(fixture.tarballBytes).digest('base64')}`,
    )
    expect(validated.url).toBe(
      `https://github.com/jarmak-personal/ghostty-web/releases/download/${validated.tag}/${validated.artifactName}`,
    )
  })

  it.each([
    [
      'checksum',
      (fixture: ReturnType<typeof downloadedRelease>) => ({
        checksumBytes: bytes('0'.repeat(64) + `  ${fixture.assets.tarball.name}\n`),
      }),
    ],
    [
      'provenance source',
      (fixture: ReturnType<typeof downloadedRelease>) => ({
        provenanceBytes: provenanceBytes(fixture.assets.tarball.name, {
          sourceRepository: 'https://example.com/ghostty-web.git',
        }),
      }),
    ],
    ['tag source', () => ({ tagCommit: 'c'.repeat(40) })],
    [
      'package version',
      () => ({
        packageSnapshot: { name: 'ghostty-web', version: '0.5.0', wasmBytes: 523_293 },
      }),
    ],
  ])('rejects invalid %s evidence', (_name, mutate) => {
    const fixture = downloadedRelease()
    const changed = mutate(fixture)
    const next = { ...fixture, ...changed }
    if ('checksumBytes' in changed) {
      next.assets = {
        ...fixture.assets,
        checksum: asset(fixture.assets.checksum.name, next.checksumBytes, 2),
      }
    }
    if ('provenanceBytes' in changed) {
      next.assets = {
        ...fixture.assets,
        provenance: asset(fixture.assets.provenance.name, next.provenanceBytes, 3),
      }
    }
    expect(() => validateDownloadedRelease(next)).toThrow()
  })

  it('parses only exact immutable release asset pins', () => {
    expect(
      parsePinnedArtifactUrl(
        `https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-15/ghostty-web-0.4.0-hvir-g${SOURCE_COMMIT.slice(0, 12)}.tgz`,
      ),
    ).toMatchObject({ packageVersion: '0.4.0', revision: 15, tag: 'hvir-v0.4.0-15' })
    expect(() =>
      parsePinnedArtifactUrl(
        'https://github.com/jarmak-personal/ghostty-web/releases/latest',
      ),
    ).toThrow(/not an exact release asset/)
  })
})

describe('ghostty-web update and pull-request policy', () => {
  it('rejects a downgrade and coalesces a newer release into the open pull request', () => {
    expect(() => planGhosttyWebUpdate('hvir-v0.4.0-15', 'hvir-v0.4.0-14', {})).toThrow(
      /older than current pin/,
    )
    expect(
      planGhosttyWebUpdate('hvir-v0.4.0-14', 'hvir-v0.4.0-16', {
        openPullRequest: { number: 12, tag: 'hvir-v0.4.0-15' },
      }),
    ).toEqual({ action: 'prepare', mode: 'coalesce' })
    expect(
      planGhosttyWebUpdate('hvir-v0.4.0-14', 'hvir-v0.4.0-15', {
        openPullRequest: { number: 12, tag: 'hvir-v0.4.0-15' },
      }),
    ).toEqual({ action: 'no-op', reason: 'open-current' })
  })

  it('does not recreate a closed unwanted release until a newer one appears', () => {
    expect(
      planGhosttyWebUpdate('hvir-v0.4.0-14', 'hvir-v0.4.0-15', {
        closedUnmergedTag: 'hvir-v0.4.0-15',
      }),
    ).toEqual({ action: 'suppressed', rejectedTag: 'hvir-v0.4.0-15' })
    expect(
      planGhosttyWebUpdate('hvir-v0.4.0-14', 'hvir-v0.4.0-16', {
        closedUnmergedTag: 'hvir-v0.4.0-15',
      }),
    ).toEqual({ action: 'prepare', mode: 'create' })
  })

  it('generates one bounded issue-less pull-request body', () => {
    const pullRequest = createGhosttyWebPullRequest({
      currentTag: 'hvir-v0.4.0-14',
      release: validatedRelease(),
      runUrl: 'https://github.com/jarmak-personal/hvir/actions/runs/123',
    })

    expect(pullRequest.body).toContain(GHOSTTY_WEB_UPDATE_MARKER)
    expect(releaseTagFromPullRequestBody(pullRequest.body)).toBe('hvir-v0.4.0-15')
    expect(pullRequest.body).not.toMatch(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#/i,
    )
    expect(pullRequest.body).not.toMatch(/(?:Completes-child|Contributes-to):/)
    expect(pullRequest.body).not.toContain('release notes')
  })
})

function release(
  tagName: string,
  overrides: Partial<GhosttyWebRelease> = {},
): GhosttyWebRelease {
  return {
    assets: selectedAssets('0.4.0'),
    draft: false,
    immutable: true,
    prerelease: false,
    tagName,
    ...overrides,
  }
}

function selectedRelease(tag: string): SelectedGhosttyWebRelease {
  return selectNewestPublishedRelease([release(tag)])
}

function selectedAssets(version: string): ReleaseAsset[] {
  const artifactName = `ghostty-web-${version}-hvir-g${SOURCE_COMMIT.slice(0, 12)}.tgz`
  return [
    asset(artifactName, bytes('package bytes'), 1),
    asset(`${artifactName}.sha256`, bytes('0'.repeat(64) + `  ${artifactName}\n`), 2),
    asset(`${artifactName}.provenance.json`, bytes('{}\n'), 3),
  ]
}

function downloadedRelease() {
  const release = selectedRelease('hvir-v0.4.0-15')
  const tarballBytes = bytes('validated package archive')
  const artifactName = `ghostty-web-0.4.0-hvir-g${SOURCE_COMMIT.slice(0, 12)}.tgz`
  const checksumBytes = bytes(`${sha256(tarballBytes)}  ${artifactName}\n`)
  const provenance = provenanceBytes(artifactName)
  const assets = {
    tarball: asset(artifactName, tarballBytes, 1),
    checksum: asset(`${artifactName}.sha256`, checksumBytes, 2),
    provenance: asset(`${artifactName}.provenance.json`, provenance, 3),
  }
  return {
    assets,
    checksumBytes,
    packageSnapshot: { name: 'ghostty-web', version: '0.4.0', wasmBytes: 523_293 },
    provenanceBytes: provenance,
    release: { ...release, assets: Object.values(assets) },
    tagCommit: SOURCE_COMMIT,
    tarballBytes,
  }
}

function provenanceBytes(artifactName: string, overrides: Record<string, unknown> = {}) {
  return bytes(
    `${JSON.stringify({
      schemaVersion: 1,
      package: 'ghostty-web',
      packageVersion: '0.4.0',
      artifact: artifactName,
      sha256: sha256(bytes('validated package archive')),
      sourceRepository: 'https://github.com/jarmak-personal/ghostty-web.git',
      sourceCommit: SOURCE_COMMIT,
      ghosttyCommit: GHOSTTY_COMMIT,
      ...overrides,
    })}\n`,
  )
}

function asset(name: string, content: Uint8Array, id: number): ReleaseAsset {
  return {
    digest: `sha256:${sha256(content)}`,
    id,
    name,
    size: content.byteLength,
    state: 'uploaded',
  }
}

function validatedRelease(): ValidatedGhosttyWebRelease {
  return {
    artifactName: `ghostty-web-0.4.0-hvir-g${SOURCE_COMMIT.slice(0, 12)}.tgz`,
    ghosttyCommit: GHOSTTY_COMMIT,
    npmIntegrity: 'sha512-YWJjZA==',
    packageVersion: '0.4.0',
    revision: 15,
    sha256: 'c'.repeat(64),
    sourceCommit: SOURCE_COMMIT,
    tag: 'hvir-v0.4.0-15',
    url: `https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-15/ghostty-web-0.4.0-hvir-g${SOURCE_COMMIT.slice(0, 12)}.tgz`,
    wasmBytes: 523_293,
  }
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}
