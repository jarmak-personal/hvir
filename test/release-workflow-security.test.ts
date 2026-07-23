import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release-npm.yml', import.meta.url),
  'utf8',
)
const mergedReleaseWorkflow = readFileSync(
  new URL('../.github/workflows/release-pr-merged.yml', import.meta.url),
  'utf8',
)
const prepareReleaseScript = readFileSync(
  new URL('../scripts/prepare-release-pr.mjs', import.meta.url),
  'utf8',
)

describe('release PR automation', () => {
  it('keeps both workflows valid and gates publishing on current package state', () => {
    expect(() => {
      void parse(releaseWorkflow)
    }).not.toThrow()
    expect(() => {
      void parse(mergedReleaseWorkflow)
    }).not.toThrow()
    expect(releaseWorkflow).toContain('node scripts/prepare-release-pr.mjs "$VERSION"')
    expect(
      releaseWorkflow.match(/if: needs\.prepare\.outputs\.ready == 'true'/g),
    ).toHaveLength(3)
    expect(releaseWorkflow).not.toContain(
      'git push origin "HEAD:${{ github.event.repository.default_branch }}"',
    )
  })

  it('creates one skip-CI maintenance commit and a changelog-style PR', () => {
    expect(prepareReleaseScript).toContain(
      "await git('commit', '-m', `Bump hvir to ${version} [skip ci]`)",
    )
    expect(prepareReleaseScript).toContain(
      "const expectedVersionFiles = ['package-lock.json', 'package.json']",
    )
    expect(prepareReleaseScript).toContain("'issue',\n    'list'")
    expect(prepareReleaseScript).toContain('`closed:>${since}`')
    expect(releaseWorkflow).toContain('      issues: read\n      pull-requests: write')
    expect(prepareReleaseScript).toContain(
      '## Closed issues since ${boundaryDescription}',
    )
    expect(prepareReleaseScript).toContain('intentionally has no governing issue')
    expect(prepareReleaseScript).not.toMatch(/\bCloses #/)
  })

  it('accepts an automated source only when it is an exact commit merged into main', () => {
    expect(releaseWorkflow).toContain('[[ ! "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]')
    expect(releaseWorkflow).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" "$default_sha"',
    )
    expect(releaseWorkflow).toContain('"$remote_tag_sha" != "$SOURCE_SHA"')
  })

  it('dispatches only a merged same-repository bot release PR from trusted workflow code', () => {
    expect(mergedReleaseWorkflow).toContain('pull_request_target:')
    expect(mergedReleaseWorkflow).toContain('types: [closed]')
    expect(mergedReleaseWorkflow).toContain(
      "github.event.pull_request.user.login == 'github-actions[bot]'",
    )
    expect(mergedReleaseWorkflow).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    )
    expect(mergedReleaseWorkflow).toContain(
      "startsWith(github.event.pull_request.head.ref, 'release/v')",
    )
    expect(mergedReleaseWorkflow).toContain('actions: write')
    expect(mergedReleaseWorkflow).toContain('pull-requests: read')
    expect(mergedReleaseWorkflow).not.toMatch(
      /actions\/checkout|npm (?:ci|install)|git fetch/,
    )
    expect(mergedReleaseWorkflow).not.toMatch(/^\s+run:.*\$\{\{/m)
  })

  it('revalidates release identity and contents before dispatching current', () => {
    expect(mergedReleaseWorkflow).toContain('<!-- hvir-release-pr:v1 -->')
    expect(mergedReleaseWorkflow).toContain(
      "expected_files=$'package-lock.json\\npackage.json'",
    )
    expect(mergedReleaseWorkflow).toContain(
      '.version == $version and .packages[""].version == $version',
    )
    expect(mergedReleaseWorkflow).toContain('gh workflow run release-npm.yml')
    expect(mergedReleaseWorkflow).toContain('-f bump=current')
    expect(mergedReleaseWorkflow).toContain('-f source_sha="$MERGE_SHA"')
  })
})
