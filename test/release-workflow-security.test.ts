import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const macosWorkflow = readFileSync(
  new URL('../.github/workflows/macos-package-release.yml', import.meta.url),
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

describe('native release automation', () => {
  it('keeps every workflow valid and gates native release jobs on current package state', () => {
    expect(() => {
      void parse(releaseWorkflow)
    }).not.toThrow()
    expect(() => {
      void parse(mergedReleaseWorkflow)
    }).not.toThrow()
    expect(() => {
      void parse(macosWorkflow)
    }).not.toThrow()
    expect(releaseWorkflow).toContain('node scripts/prepare-release-pr.mjs "$VERSION"')
    expect(
      releaseWorkflow.match(/if: needs\.prepare\.outputs\.ready == 'true'/g),
    ).toHaveLength(4)
    expect(releaseWorkflow).not.toContain(
      'git push origin "HEAD:${{ github.event.repository.default_branch }}"',
    )
    expect(releaseWorkflow).not.toMatch(/\bnpm publish\b/)
    expect(releaseWorkflow).not.toContain('pack:npm:')
    expect(releaseWorkflow).not.toContain('smoke:packaged')
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
    expect(mergedReleaseWorkflow).toContain('gh workflow run release.yml')
    expect(mergedReleaseWorkflow).toContain('-f bump=current')
    expect(mergedReleaseWorkflow).toContain('-f source_sha="$MERGE_SHA"')
  })

  it('builds and accepts every native package from the same exact source', () => {
    expect(releaseWorkflow).toContain('runs-on: ${{ matrix.os }}')
    expect(releaseWorkflow).toContain('os: ubuntu-24.04')
    expect(releaseWorkflow).toContain('os: ubuntu-24.04-arm')
    expect(releaseWorkflow).toContain('build: npm run pack:linux:x64')
    expect(releaseWorkflow).toContain('build: npm run pack:linux:arm64')
    expect(releaseWorkflow).toContain('xvfb-run -a npm run smoke:linux:installed')
    expect(releaseWorkflow).toContain(
      'uses: ./.github/workflows/macos-package-release.yml',
    )
    expect(releaseWorkflow).toContain('source_sha: ${{ needs.prepare.outputs.sha }}')
    expect(macosWorkflow).toContain('workflow_call:')
    expect(macosWorkflow).toContain('npm run smoke:macos:installed')
    expect(macosWorkflow).toContain('dist/hvir-*-darwin-arm64.pkg')
  })

  it('assembles a private complete draft before one immutable publication', () => {
    const immutable = releaseWorkflow.indexOf('Require repository release immutability')
    const assemble = releaseWorkflow.indexOf(
      'Assemble exact release metadata and installer',
    )
    const createDraft = releaseWorkflow.indexOf('Create or repair a private draft')
    const upload = releaseWorkflow.indexOf(
      'Upload and validate the complete draft asset set',
    )
    const publish = releaseWorkflow.indexOf('Publish the complete immutable release')
    const verify = releaseWorkflow.indexOf(
      'Verify published release attestation and downloaded assets',
    )
    expect(immutable).toBeGreaterThan(-1)
    expect(assemble).toBeGreaterThan(immutable)
    expect(createDraft).toBeGreaterThan(assemble)
    expect(upload).toBeGreaterThan(createDraft)
    expect(publish).toBeGreaterThan(upload)
    expect(verify).toBeGreaterThan(publish)
    expect(releaseWorkflow).toContain('"repos/$GITHUB_REPOSITORY/immutable-releases"')
    expect(releaseWorkflow).toContain('npm run assemble:native-release')
    expect(releaseWorkflow).toContain('--draft')
    expect(releaseWorkflow).toContain('--draft=false')
    expect(releaseWorkflow).toContain('sha256sum --check SHA256SUMS')
    expect(releaseWorkflow).toContain('gh release verify "$TAG"')
    expect(releaseWorkflow).toContain('gh release verify-asset "$TAG" "$asset"')
    for (const name of [
      'SHA256SUMS',
      'THIRD_PARTY_NOTICES.md',
      'hvir-${VERSION}-darwin-arm64.pkg',
      'hvir-${VERSION}-linux-arm64.deb',
      'hvir-${VERSION}-linux-x64.deb',
      'install.sh',
      'release-manifest.json',
    ]) {
      expect(releaseWorkflow).toContain(name)
    }
  })

  it('retires npm metadata only after release verification without unpublishing history', () => {
    const publishJob = releaseWorkflow.indexOf('publish-native-release:')
    const retireJob = releaseWorkflow.indexOf('retire-npm-distribution:')
    expect(retireJob).toBeGreaterThan(publishJob)
    expect(releaseWorkflow).toContain('- publish-native-release')
    expect(releaseWorkflow).toContain('environment: npm-retirement')
    expect(releaseWorkflow).toContain('NPM_RETIREMENT_TOKEN')
    expect(releaseWorkflow).toContain('npm deprecate "${package}@*" "$message"')
    expect(releaseWorkflow).toContain(
      'releases/latest/download/install.sh. Published npm versions remain available only for migration.',
    )
    expect(releaseWorkflow).not.toMatch(/\bnpm unpublish\b/)
  })
})
