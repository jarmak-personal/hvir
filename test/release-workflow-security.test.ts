import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const release = parse(releaseWorkflow) as {
  jobs: Record<string, { secrets?: string }>
}
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
const releaseCiEvidenceScript = readFileSync(
  new URL('../scripts/require-release-ci-evidence.mts', import.meta.url),
  'utf8',
)
const releasePrIntegrityScript = readFileSync(
  new URL('../scripts/validate-release-pr.mts', import.meta.url),
  'utf8',
)
const nodeTsconfig = JSON.parse(
  readFileSync(new URL('../tsconfig.node.json', import.meta.url), 'utf8'),
) as { include: string[] }
const releaseValidatorCheckout = [
  'scripts/validate-release-pr.mts',
  ...[...releasePrIntegrityScript.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map(
    (match) => `scripts/${match[1]}`,
  ),
].join('\n')

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
    ).toHaveLength(3)
    expect(releaseWorkflow).not.toContain(
      'git push origin "HEAD:${{ github.event.repository.default_branch }}"',
    )
    expect(releaseWorkflow).not.toMatch(/\bnpm publish\b/)
    expect(releaseWorkflow).not.toContain('pack:npm:')
    expect(releaseWorkflow).not.toContain('smoke:packaged')
  })

  it('creates one CI-eligible maintenance commit and a changelog-style PR', () => {
    expect(prepareReleaseScript).toContain(
      "await git('commit', '-m', `Bump hvir to ${version}`)",
    )
    expect(prepareReleaseScript).not.toContain('[skip ci]')
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

  it('consumes exact-source CI evidence instead of rerunning generic current-source checks', () => {
    expect(releaseWorkflow).toContain('      actions: read')
    expect(releaseWorkflow).toContain(
      'RELEASE_SOURCE_SHA: ${{ steps.version.outputs.sha }}',
    )
    expect(releaseWorkflow).toContain('run: node scripts/require-release-ci-evidence.mts')
    expect(releaseWorkflow).toContain(
      "      - name: Require exact-source first-attempt CI evidence\n        if: inputs.bump == 'current'\n        timeout-minutes: 11\n        env:",
    )
    expect(releaseWorkflow).toContain("if: inputs.bump == 'current'")
    expect(releaseWorkflow).not.toContain("if: inputs.bump != 'current'")
    expect(releaseWorkflow).not.toContain('Verify release source')
    expect(releaseWorkflow).not.toContain(
      'Exercise unpackaged Electron production workflow',
    )
    expect(releaseWorkflow).not.toContain('release-prepare-smoke-failure')
    expect(releaseCiEvidenceScript).toContain(
      "export const RELEASE_REPOSITORY = 'jarmak-personal/hvir'",
    )
    expect(releaseCiEvidenceScript).toContain(
      "export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'",
    )
    expect(releaseCiEvidenceScript).toContain('run.runAttempt === 1')
    expect(releaseCiEvidenceScript).toContain('RELEASE_CI_MAX_WAIT_MS = 10 * 60_000')
    expect(releaseCiEvidenceScript).not.toMatch(/\/rerun|\/dispatches/)
    expect(releaseCiEvidenceScript).not.toContain('method:')
    expect(releaseCiEvidenceScript).not.toContain('response.text()')
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
    expect(mergedReleaseWorkflow).toContain(
      'ref: ${{ github.event.repository.default_branch }}',
    )
    expect(mergedReleaseWorkflow).toContain('persist-credentials: false')
    const parsedMergedReleaseWorkflow = parse(mergedReleaseWorkflow) as {
      jobs: Record<
        string,
        { steps: Array<{ name?: string; with?: Record<string, unknown> }> }
      >
    }
    const checkout = parsedMergedReleaseWorkflow.jobs.dispatch?.steps.find(
      (step) => step.name === 'Check out trusted release validation',
    )
    expect(checkout?.with?.['sparse-checkout']).toBe(releaseValidatorCheckout)
    expect(mergedReleaseWorkflow).not.toMatch(/npm (?:ci|install)|git fetch/)
    expect(mergedReleaseWorkflow).not.toMatch(/^\s+run:.*\$\{\{/m)
  })

  it('revalidates release identity and contents before dispatching current', () => {
    expect(mergedReleaseWorkflow).toContain('node scripts/validate-release-pr.mts')
    expect(releasePrIntegrityScript).toContain(
      "export const RELEASE_PR_MARKER = '<!-- hvir-release-pr:v1 -->'",
    )
    expect(releasePrIntegrityScript).toContain(
      "export const RELEASE_VERSION_FILES = ['package-lock.json', 'package.json']",
    )
    expect(nodeTsconfig.include).toContain('scripts/**/*.mts')
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
    expect(release.jobs['build-macos']?.secrets).toBe('inherit')
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
    const immutableStep = releaseWorkflow.slice(immutable, assemble)
    expect(immutableStep).toContain(
      'GH_TOKEN: ${{ secrets.IMMUTABLE_RELEASES_READ_TOKEN }}',
    )
    expect(immutableStep).toContain(
      'IMMUTABLE_RELEASES_READ_TOKEN is unavailable in native-release-signing',
    )
    expect(immutableStep).not.toContain('GH_TOKEN: ${{ github.token }}')
    const createDraftStep = releaseWorkflow.slice(createDraft, upload)
    expect(createDraftStep).toContain('GH_TOKEN: ${{ github.token }}')
    expect(createDraftStep).toContain(
      'RELEASE_REF_WRITE_TOKEN: ${{ secrets.IMMUTABLE_RELEASES_READ_TOKEN }}',
    )
    expect(createDraftStep).toContain('GH_TOKEN="$RELEASE_REF_WRITE_TOKEN" gh api')
    expect(createDraftStep).toContain('"repos/$GITHUB_REPOSITORY/git/refs"')
    expect(createDraftStep).not.toContain('git push origin "$TAG"')
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

  it('retains no npm registry mutation authority after one-time retirement', () => {
    expect(releaseWorkflow).not.toContain('environment: npm-retirement')
    expect(releaseWorkflow).not.toContain('NPM_RETIREMENT_TOKEN')
    expect(releaseWorkflow).not.toMatch(/\bnpm deprecate\b/)
    expect(releaseWorkflow).not.toMatch(/\bnpm unpublish\b/)
  })
})
