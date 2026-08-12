import { describe, expect, it, vi } from 'vitest'

import {
  runGhosttyWebUpdate,
  type GhosttyWebCandidateWorkspace,
  type GhosttyWebDelivery,
  type GhosttyWebReleaseSource,
} from '../scripts/ghostty-web-update/coordinator.mts'
import type {
  GhosttyWebRelease,
  PinnedGhosttyWebArtifact,
  UpdateDeliveryState,
  ValidatedGhosttyWebRelease,
} from '../scripts/ghostty-web-update/policy.mts'

describe('ghostty-web update coordinator', () => {
  it('reports a current-pin no-op without downloading, changing files, or publishing', async () => {
    const fixture = coordinatorFixture({ latestTag: CURRENT.tag })

    await expect(runGhosttyWebUpdate(fixture.input)).resolves.toMatchObject({
      outcome: 'no-op',
      reason: 'main-current',
    })
    expect(fixture.validateRelease).not.toHaveBeenCalled()
    expect(fixture.prepareCandidate).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('coalesces a newer validated candidate into the existing pull request', async () => {
    const fixture = coordinatorFixture({
      delivery: { openPullRequest: { number: 41, tag: 'hvir-v0.4.0-15' } },
      latestTag: 'hvir-v0.4.0-16',
    })

    await expect(runGhosttyWebUpdate(fixture.input)).resolves.toMatchObject({
      outcome: 'published',
      pullRequestNumber: 41,
      selectedTag: 'hvir-v0.4.0-16',
    })
    expect(fixture.validateRelease).toHaveBeenCalledOnce()
    expect(fixture.prepareCandidate).toHaveBeenCalledOnce()
    expect(fixture.publish).toHaveBeenCalledOnce()
    expect(fixture.publish.mock.calls[0]?.[2]).toEqual({
      openPullRequest: { number: 41, tag: 'hvir-v0.4.0-15' },
    })
  })

  it('leaves candidate and delivery authority untouched after transient discovery failure', async () => {
    const fixture = coordinatorFixture({ latestTag: 'hvir-v0.4.0-15' })
    fixture.listReleases.mockRejectedValueOnce(new Error('transient source failure'))

    await expect(runGhosttyWebUpdate(fixture.input)).rejects.toThrow(
      'transient source failure',
    )
    expect(fixture.validateRelease).not.toHaveBeenCalled()
    expect(fixture.prepareCandidate).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('does not publish when candidate validation fails', async () => {
    const fixture = coordinatorFixture({ latestTag: 'hvir-v0.4.0-15' })
    fixture.prepareCandidate.mockRejectedValueOnce(new Error('npm ci failed'))

    await expect(runGhosttyWebUpdate(fixture.input)).rejects.toThrow('npm ci failed')
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('suppresses a closed unwanted release without downloading it', async () => {
    const fixture = coordinatorFixture({
      delivery: { closedUnmergedTag: 'hvir-v0.4.0-15' },
      latestTag: 'hvir-v0.4.0-15',
    })

    await expect(runGhosttyWebUpdate(fixture.input)).resolves.toEqual({
      outcome: 'suppressed',
      currentTag: CURRENT.tag,
      selectedTag: 'hvir-v0.4.0-15',
      rejectedTag: 'hvir-v0.4.0-15',
    })
    expect(fixture.validateRelease).not.toHaveBeenCalled()
    expect(fixture.prepareCandidate).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled()
  })
})

const CURRENT: PinnedGhosttyWebArtifact = {
  artifactName: 'ghostty-web-0.4.0-hvir-gaaaaaaaaaaaa.tgz',
  packageVersion: '0.4.0',
  revision: 14,
  tag: 'hvir-v0.4.0-14',
  url: 'https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-14/ghostty-web-0.4.0-hvir-gaaaaaaaaaaaa.tgz',
}

function coordinatorFixture(options: {
  readonly delivery?: UpdateDeliveryState
  readonly latestTag: string
}) {
  const release = publishedRelease(options.latestTag)
  const validated = validatedRelease(options.latestTag)
  const listReleases = vi.fn<GhosttyWebReleaseSource['listReleases']>(() =>
    Promise.resolve([release]),
  )
  const validateRelease = vi.fn<GhosttyWebReleaseSource['validateRelease']>(() =>
    Promise.resolve(validated),
  )
  const prepareCandidate = vi.fn<GhosttyWebCandidateWorkspace['prepareCandidate']>(
    (candidate) =>
      Promise.resolve({ changedFiles: ['package.json'], release: candidate }),
  )
  const publish = vi.fn<GhosttyWebDelivery['publish']>(() =>
    Promise.resolve({
      pullRequestNumber: options.delivery?.openPullRequest?.number ?? 52,
      url: 'https://github.com/jarmak-personal/hvir/pull/52',
    }),
  )
  return {
    input: {
      candidate: {
        readCurrentPin: () => Promise.resolve(CURRENT),
        prepareCandidate,
      },
      delivery: {
        inspect: () => Promise.resolve(options.delivery ?? {}),
        publish,
      },
      releases: { listReleases, validateRelease },
    },
    listReleases,
    prepareCandidate,
    publish,
    validateRelease,
  }
}

function publishedRelease(tagName: string): GhosttyWebRelease {
  return {
    assets: [],
    draft: false,
    immutable: true,
    prerelease: false,
    tagName,
  }
}

function validatedRelease(tag: string): ValidatedGhosttyWebRelease {
  const packageVersion = tag.match(/^hvir-v([0-9.]+)-/)?.[1] ?? '0.4.0'
  const revision = Number(tag.match(/-([0-9]+)$/)?.[1] ?? '1')
  const sourceCommit = 'a'.repeat(40)
  const artifactName = `ghostty-web-${packageVersion}-hvir-g${sourceCommit.slice(0, 12)}.tgz`
  return {
    artifactName,
    ghosttyCommit: 'b'.repeat(40),
    npmIntegrity: 'sha512-YWJjZA==',
    packageVersion,
    revision,
    sha256: 'c'.repeat(64),
    sourceCommit,
    tag,
    url: `https://github.com/jarmak-personal/ghostty-web/releases/download/${tag}/${artifactName}`,
    wasmBytes: 523_293,
  }
}
