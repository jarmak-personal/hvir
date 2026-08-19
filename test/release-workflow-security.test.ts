import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import {
  RELEASE_CI_HOSTED_RUNNER_SCHEDULING_ALLOWANCE_MS,
  RELEASE_CI_MAX_WAIT_MS,
  RELEASE_CI_REQUIRED_CRITICAL_PATH_MS,
  REQUIRED_CI_JOBS,
} from '../scripts/require-release-ci-evidence.mts'

const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const release = parse(releaseWorkflow) as {
  jobs: Record<
    string,
    {
      needs?: string | string[]
      outputs?: Record<string, string>
      permissions?: Record<string, string>
      secrets?: string
      'timeout-minutes'?: number
      steps?: Array<{
        id?: string
        name?: string
        uses?: string
        run?: string
        with?: Record<string, string | number | boolean>
        'timeout-minutes'?: number
      }>
    }
  >
}
const ciWorkflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const ci = parse(ciWorkflow) as {
  jobs: Record<
    string,
    {
      name: string
      needs?: string | string[]
      'timeout-minutes'?: number
      strategy?: { matrix?: { include?: Array<{ name?: string }> } }
      steps?: Array<{
        name?: string
        uses?: string
        run?: string
        with?: Record<string, string | number | boolean>
      }>
    }
  >
}

function requiredCiCriticalPathMinutes(): number {
  const requiredNames = new Set<string>(REQUIRED_CI_JOBS)
  const requiredJobIds = new Set(
    Object.entries(ci.jobs)
      .filter(([, job]) => {
        const matrix = job.strategy?.matrix?.include
        const names = matrix
          ? matrix.map((entry) => job.name.replace('${{ matrix.name }}', entry.name ?? ''))
          : [job.name]
        return names.some((name) => requiredNames.has(name))
      })
      .map(([id]) => id),
  )
  const totals = new Map<string, number>()

  const visit = (id: string): number => {
    const known = totals.get(id)
    if (known !== undefined) return known
    const job = ci.jobs[id]
    if (!job || !requiredJobIds.has(id)) return 0
    const timeout = job['timeout-minutes']
    if (!timeout) throw new Error(`Required CI job ${id} needs a timeout`)
    const dependencies = Array.isArray(job.needs)
      ? job.needs
      : job.needs
        ? [job.needs]
        : []
    const total = timeout + Math.max(0, ...dependencies.map(visit))
    totals.set(id, total)
    return total
  }

  return Math.max(...[...requiredJobIds].map(visit))
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
    ).toHaveLength(2)
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
    const prepare = release.jobs.prepare
    const evidenceStep = prepare?.steps?.find(
      (step) => step.name === 'Require exact-source first-attempt CI evidence',
    )
    const evidenceTimeoutMinutes = evidenceStep?.['timeout-minutes'] ?? 0
    expect(evidenceStep?.id).toBe('ci_evidence')
    expect(evidenceTimeoutMinutes).toBe(86)
    expect(prepare?.['timeout-minutes']).toBe(95)
    expect(evidenceTimeoutMinutes * 60_000).toBe(
      RELEASE_CI_MAX_WAIT_MS + 60_000,
    )
    expect(prepare?.['timeout-minutes']).toBe(
      evidenceTimeoutMinutes + 9,
    )
    expect(RELEASE_CI_REQUIRED_CRITICAL_PATH_MS).toBe(
      requiredCiCriticalPathMinutes() * 60_000,
    )
    expect(RELEASE_CI_HOSTED_RUNNER_SCHEDULING_ALLOWANCE_MS).toBe(30 * 60_000)
    expect(RELEASE_CI_MAX_WAIT_MS).toBe(
      RELEASE_CI_REQUIRED_CRITICAL_PATH_MS +
        RELEASE_CI_HOSTED_RUNNER_SCHEDULING_ALLOWANCE_MS,
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

  it('reuses exact accepted Linux artifacts and keeps protected macOS acceptance', () => {
    const prepare = release.jobs.prepare
    const evidenceStep = prepare?.steps?.find(
      (step) => step.name === 'Require exact-source first-attempt CI evidence',
    )
    const publish = release.jobs['publish-native-release']
    const crossRunDownloads = publish?.steps?.filter(
      (step) =>
        step.uses === 'actions/download-artifact@v8' && step.with?.['run-id'],
    )
    const protectedMacosDownload = publish?.steps?.find(
      (step) => step.name === 'Download protected accepted macOS package',
    )
    const linuxProducer = ci.jobs['native-linux-package']
    const retainLinuxArtifact = linuxProducer?.steps?.find(
      (step) => step.name === 'Retain accepted native package',
    )
    const nameLinuxArtifact = linuxProducer?.steps?.find(
      (step) => step.name === 'Give the accepted artifact its public release name',
    )

    expect(release.jobs['build-linux']).toBeUndefined()
    expect(linuxProducer?.strategy?.matrix?.include?.map((entry) => entry.name)).toEqual(
      ['Linux x64', 'Linux arm64'],
    )
    expect(retainLinuxArtifact).toMatchObject({
      uses: 'actions/upload-artifact@v7',
      with: {
        name: 'hvir-${{ matrix.name }}-deb',
        path: '${{ matrix.artifact }}',
        'if-no-files-found': 'error',
        'retention-days': 14,
      },
    })
    expect(nameLinuxArtifact?.run).toContain(
      'target="dist/hvir-${version}-linux-${RELEASE_ARCH}.deb"',
    )
    expect(
      ciWorkflow.match(/hvir_\$\{version\}_(?:amd64|arm64)\.deb/g) ?? [],
    ).toHaveLength(0)
    expect(prepare?.outputs?.ci_run_id).toBe(
      '${{ steps.ci_evidence.outputs.run_id }}',
    )
    expect(evidenceStep?.id).toBe('ci_evidence')
    expect(publish?.needs).toEqual(['prepare', 'build-macos'])
    expect(publish?.permissions).toEqual({ actions: 'read', contents: 'write' })
    expect(crossRunDownloads?.map((step) => step.with)).toEqual([
      {
        name: 'hvir-Linux x64-deb',
        'github-token': '${{ github.token }}',
        repository: '${{ github.repository }}',
        'run-id': '${{ needs.prepare.outputs.ci_run_id }}',
        path: 'dist/release',
      },
      {
        name: 'hvir-Linux arm64-deb',
        'github-token': '${{ github.token }}',
        repository: '${{ github.repository }}',
        'run-id': '${{ needs.prepare.outputs.ci_run_id }}',
        path: 'dist/release',
      },
    ])
    expect(protectedMacosDownload?.with).toEqual({
      name: 'release-macos-arm64',
      path: 'dist/release',
    })
    expect(releaseWorkflow).toContain('[[ ! "$CI_RUN_ID" =~ ^[1-9][0-9]*$ ]]')
    expect(releaseWorkflow).not.toContain('hvir_${VERSION}_amd64.deb')
    expect(releaseWorkflow).not.toContain('hvir_${VERSION}_arm64.deb')
    expect(releaseWorkflow).not.toContain('npm run pack:linux:')
    expect(releaseWorkflow).not.toContain('npm run smoke:linux:installed')
    expect(releaseWorkflow).not.toContain('run: npm ci')
    expect(releaseWorkflow).toContain(
      'uses: ./.github/workflows/macos-package-release.yml',
    )
    expect(release.jobs['build-macos']?.secrets).toBe('inherit')
    expect(releaseWorkflow).toContain('source_sha: ${{ needs.prepare.outputs.sha }}')
    expect(macosWorkflow).toContain('workflow_call:')
    expect(macosWorkflow).toContain('npm run smoke:macos:installed')
    expect(macosWorkflow).toContain('dist/hvir-*-darwin-arm64.pkg')

    const publishSteps = publish?.steps ?? []
    const createDraftIndex = publishSteps.findIndex(
      (step) => step.name === 'Create or repair a private draft',
    )
    for (const requiredPreDraftStep of [
      'Require exact CI artifact source',
      'Download accepted Linux x64 package from exact CI',
      'Download accepted Linux arm64 package from exact CI',
      'Download protected accepted macOS package',
      'Assemble exact release metadata and installer',
    ]) {
      const stepIndex = publishSteps.findIndex(
        (step) => step.name === requiredPreDraftStep,
      )
      expect(stepIndex, requiredPreDraftStep).toBeGreaterThan(-1)
      expect(stepIndex, requiredPreDraftStep).toBeLessThan(createDraftIndex)
    }
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
