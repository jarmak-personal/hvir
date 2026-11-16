import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (name: string): string =>
  readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
interface Job {
  uses?: string
  if?: string
  needs?: string | string[]
  with?: Record<string, unknown>
  strategy?: { matrix: { include: Array<Record<string, unknown>> } }
  steps?: Array<{
    name?: string
    run?: string
    env?: Record<string, string>
    with?: Record<string, unknown>
  }>
}
const nativeSource = read('native-terminal')
const packagesSource = read('native-terminal-packages')
const signedSource = read('macos-package-release')
const native = parse(nativeSource) as { jobs: Record<string, Job> }
const packages = parse(packagesSource) as { jobs: Record<string, Job> }
const signed = parse(signedSource) as { jobs: Record<string, Job> }

describe('exact native candidate package workflow', () => {
  it('routes registered PR/dispatch builds into candidate-only packaging after exact SDK and clients', () => {
    expect(native.jobs.packages).toMatchObject({
      needs: ['build', 'agent-clients'],
      uses: './.github/workflows/native-terminal-packages.yml',
      with: { source_sha: '${{ github.event.pull_request.head.sha || github.sha }}' },
    })
    expect(native.jobs['agent-clients']!.with?.source_sha).toBe(
      '${{ github.event.pull_request.head.sha || github.sha }}',
    )
    expect(packagesSource).not.toMatch(
      /gh release|softprops|action-gh-release|--no-sandbox|disable-setuid-sandbox/,
    )
  })
  it('builds all targets natively and accepts the identical Linux22packages onUbuntu24/Debian13', () => {
    expect(
      packages.jobs.package!.strategy?.matrix.include.map((entry) => [
        entry.target,
        entry.os,
      ]),
    ).toEqual([
      ['linux-x64', 'ubuntu-22.04'],
      ['linux-arm64', 'ubuntu-22.04-arm'],
      ['macos-arm64', 'macos-15'],
    ])
    for (const name of ['ubuntu-24', 'debian']) {
      expect(packages.jobs[name]!.needs).toBe('package')
      const commands =
        packages.jobs[name]!.steps?.map((step) => step.run ?? '').join('\n') ?? ''
      expect(commands).toContain('prepare-release-linux-package.mts')
      expect(commands).toContain('smoke:linux:installed')
      expect(commands).toContain('relocate-package-inputs.mts')
      expect(commands).not.toContain('pack:linux')
    }
  })
  it('restores approved compiled bindings, assembles production payload, moves developer inputs, then opts in installed probes', () => {
    const steps = packages.jobs.package!.steps ?? []
    const commands = steps.map((step) => step.run ?? '').join('\n')
    expect(commands).toContain(
      'native-terminal-bindings-$TARGET.tar.gz" -C packages/native-terminal/build Release',
    )
    expect(commands).toContain(
      'package.mts "$TARGET" out/native-sdk/artifact out/native-terminal',
    )
    expect(commands).toContain('relocate-package-inputs.mts')
    expect(steps.findIndex((step) => step.name?.startsWith('Move every'))).toBeLessThan(
      steps.findIndex((step) => step.name?.startsWith('Accept installed Linux')),
    )
    expect(
      steps.find((step) => step.name?.startsWith('Build candidate'))?.env
        ?.HVIR_PACKAGE_NATIVE_TERMINAL,
    ).toBe('1')
    expect(
      steps.find((step) => step.name?.startsWith('Accept installed Linux'))?.env
        ?.HVIR_NATIVE_PACKAGE_ACCEPTANCE,
    ).toBe('1')
  })
  it('keeps signing behind explicit branch dispatch and the existing protected source/sign/notary owner', () => {
    expect(nativeSource).toContain("inputs.sign_candidate && 'signed' || 'unsigned'")
    expect(nativeSource).toContain(
      "cancel-in-progress: ${{ github.event_name != 'workflow_dispatch' || !inputs.sign_candidate }}",
    )
    expect(packages.jobs['signed-macos']).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.sign_candidate",
      uses: './.github/workflows/macos-package-release.yml',
      with: {
        source_sha: '${{ inputs.source_sha }}',
        allow_merged_source: false,
        candidate_only: true,
        native_terminal: true,
      },
    })
    expect(signedSource).toContain('environment: native-release-signing')
    expect(signedSource).toContain(
      'git merge-base --is-ancestor "$SOURCE_SHA" "$branch_sha"',
    )
    expect(signedSource).toContain('npm run pack:mac:arm64:signed')
    expect(signedSource).toContain('xcrun stapler validate')
    expect(
      signed.jobs['signed-package']!.steps?.some((step) =>
        step.run?.includes('package.mts macos-arm64'),
      ),
    ).toBe(true)
  })
})

const sourceGuard = signed.jobs['signed-package']!.steps?.find(
  (step) => step.name === 'Require an exact protected release or native candidate source',
)?.run
if (!sourceGuard) throw new Error('Exact signed-source intent guard missing')
describe('explicit signed-source intent', () => {
  it.each([
    ['true', 'true', 'false', 'branch', 0],
    ['true', 'true', 'true', 'branch', 1],
    ['true', 'false', 'false', 'branch', 1],
    ['false', 'false', 'true', 'branch', 0],
    ['false', 'true', 'false', 'branch', 1],
    ['true', 'true', 'false', 'tag', 1],
  ])(
    'candidate=%s native=%s merged=%s ref=%s yields %i',
    (candidate, native, merged, ref, expected) => {
      const result = spawnSync('bash', ['-se'], {
        input: sourceGuard,
        encoding: 'utf8',
        env: {
          ...process.env,
          CANDIDATE_ONLY: String(candidate),
          NATIVE_TERMINAL: String(native),
          ALLOW_MERGED_SOURCE: String(merged),
          REF_TYPE: String(ref),
          SOURCE_SHA: 'a'.repeat(40),
        },
      })
      expect(result.status, result.stderr || result.stdout).toBe(expected)
    },
  )
})
