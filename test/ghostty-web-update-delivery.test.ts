import { describe, expect, it, vi } from 'vitest'

import type { PreparedCandidate } from '../scripts/ghostty-web-update/coordinator.mts'
import { GitHubGhosttyWebDelivery } from '../scripts/ghostty-web-update/github-delivery.mts'
import {
  createGhosttyWebPullRequest,
  GHOSTTY_WEB_UPDATE_BRANCH,
  type PinnedGhosttyWebArtifact,
  type ValidatedGhosttyWebRelease,
} from '../scripts/ghostty-web-update/policy.mts'
import {
  GHOSTTY_WEB_CANDIDATE_FILES,
  type CommandRunner,
} from '../scripts/ghostty-web-update/repository-candidate.mts'

const HEAD = '1'.repeat(40)

describe('ghostty-web GitHub delivery', () => {
  it('lease-protects and advances the one existing App-owned pull request', async () => {
    const openRelease = release('hvir-v0.4.0-15')
    const nextRelease = release('hvir-v0.4.0-16')
    const pullRequest = pullRequestEvidence(41, openRelease)
    const requests: Array<{ init?: RequestInit; path: string }> = []
    const json = (path: string, init?: RequestInit): Promise<unknown> => {
      requests.push({ init, path })
      if (path.includes('/pulls?')) return Promise.resolve([pullRequest])
      if (path.startsWith('/users/')) {
        return Promise.resolve({ id: 12345, login: 'hvir-dependency-updater[bot]' })
      }
      if (path.endsWith('/pulls/41')) {
        return Promise.resolve({
          number: 41,
          html_url: 'https://github.com/jarmak-personal/hvir/pull/41',
        })
      }
      return Promise.reject(new Error(`Unexpected request ${path}`))
    }
    const client = {
      json: vi.fn(json),
    }
    const commands: Array<readonly [string, readonly string[]]> = []
    const run = vi.fn<CommandRunner['run']>((command, arguments_) => {
      commands.push([command, arguments_])
      if (arguments_[0] === 'rev-parse') {
        return Promise.resolve({ stdout: `${HEAD}\n` })
      }
      if (arguments_[0] === 'show') {
        return Promise.resolve({
          stdout: JSON.stringify({ dependencies: { 'ghostty-web': openRelease.url } }),
        })
      }
      if (arguments_[0] === 'ls-remote') {
        return Promise.resolve({
          stdout: `${HEAD}\trefs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}\n`,
        })
      }
      if (arguments_[0] === 'diff' && arguments_[1] === '--cached') {
        return Promise.resolve({ stdout: `${GHOSTTY_WEB_CANDIDATE_FILES.join('\n')}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })
    const runner: CommandRunner = { run }
    const delivery = new GitHubGhosttyWebDelivery({
      appSlug: 'hvir-dependency-updater',
      client,
      defaultBranch: 'main',
      repository: 'jarmak-personal/hvir',
      root: '/unused',
      runUrl: 'https://github.com/jarmak-personal/hvir/actions/runs/123',
      runner,
    })
    const state = await delivery.inspect()

    await expect(
      delivery.publish(currentPin(), candidate(nextRelease), state),
    ).resolves.toEqual({
      pullRequestNumber: 41,
      url: 'https://github.com/jarmak-personal/hvir/pull/41',
    })
    expect(state).toMatchObject({
      openPullRequest: { number: 41, tag: 'hvir-v0.4.0-15' },
    })
    expect(commands).toContainEqual([
      'git',
      [
        'push',
        `--force-with-lease=refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}:${HEAD}`,
        'origin',
        `HEAD:refs/heads/${GHOSTTY_WEB_UPDATE_BRANCH}`,
      ],
    ])
    expect(commands).toContainEqual(['git', ['add', ...GHOSTTY_WEB_CANDIDATE_FILES]])
    const mutation = requests.find((request) => request.path.endsWith('/pulls/41'))
    expect(mutation?.init?.method).toBe('PATCH')
    expect(typeof mutation?.init?.body).toBe('string')
    expect(mutation?.init?.body).toContain('hvir-v0.4.0-16')
    expect(requests.some((request) => request.path.endsWith('/pulls'))).toBe(false)
  })

  it('fails before touching Git when multiple owned pull requests are open', async () => {
    const selected = release('hvir-v0.4.0-15')
    const client = {
      json: vi.fn(() =>
        Promise.resolve([
          pullRequestEvidence(41, selected),
          pullRequestEvidence(42, selected),
        ]),
      ),
    }
    const run = vi.fn<CommandRunner['run']>(() => Promise.resolve({ stdout: '' }))
    const runner: CommandRunner = { run }
    const delivery = new GitHubGhosttyWebDelivery({
      appSlug: 'hvir-dependency-updater',
      client,
      defaultBranch: 'main',
      repository: 'jarmak-personal/hvir',
      root: '/unused',
      runUrl: 'https://github.com/jarmak-personal/hvir/actions/runs/123',
      runner,
    })

    await expect(delivery.inspect()).rejects.toThrow(/Multiple open/)
    expect(run).not.toHaveBeenCalled()
  })
})

function pullRequestEvidence(number: number, selected: ValidatedGhosttyWebRelease) {
  return {
    number,
    state: 'open',
    body: createGhosttyWebPullRequest({
      currentTag: 'hvir-v0.4.0-14',
      release: selected,
      runUrl: 'https://github.com/jarmak-personal/hvir/actions/runs/122',
    }).body,
    merged_at: null,
    base: { ref: 'main' },
    head: {
      ref: GHOSTTY_WEB_UPDATE_BRANCH,
      sha: HEAD,
      repo: { full_name: 'jarmak-personal/hvir' },
    },
  }
}

function currentPin(): PinnedGhosttyWebArtifact {
  const selected = release('hvir-v0.4.0-14')
  return {
    artifactName: selected.artifactName,
    packageVersion: selected.packageVersion,
    revision: 14,
    tag: selected.tag,
    url: selected.url,
  }
}

function candidate(selected: ValidatedGhosttyWebRelease): PreparedCandidate {
  return { changedFiles: GHOSTTY_WEB_CANDIDATE_FILES, release: selected }
}

function release(tag: string): ValidatedGhosttyWebRelease {
  const sourceCommit = tag.endsWith('-14')
    ? 'a'.repeat(40)
    : tag.endsWith('-15')
      ? 'b'.repeat(40)
      : 'c'.repeat(40)
  const revision = Number(tag.match(/-([0-9]+)$/)?.[1] ?? '1')
  const artifactName = `ghostty-web-0.4.0-hvir-g${sourceCommit.slice(0, 12)}.tgz`
  return {
    artifactName,
    ghosttyCommit: 'd'.repeat(40),
    npmIntegrity: 'sha512-dXBkYXRlZA==',
    packageVersion: '0.4.0',
    revision,
    sha256: 'e'.repeat(64),
    sourceCommit,
    tag,
    url: `https://github.com/jarmak-personal/ghostty-web/releases/download/${tag}/${artifactName}`,
    wasmBytes: 523_293,
  }
}
