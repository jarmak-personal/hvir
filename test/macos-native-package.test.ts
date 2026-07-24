import { readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const builder = parse(
  readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }
const preinstallUrl = new URL('../build/pkg-scripts/preinstall', import.meta.url)
const preinstall = readFileSync(preinstallUrl, 'utf8')
const postinstallUrl = new URL('../build/pkg-scripts/postinstall', import.meta.url)
const postinstall = readFileSync(postinstallUrl, 'utf8')
const nativeCommand = readFileSync(
  new URL('../build/native/hvir-command', import.meta.url),
  'utf8',
)
const installedSmokeUrl = new URL(
  '../scripts/run-macos-package-smoke.sh',
  import.meta.url,
)
const installedSmoke = readFileSync(installedSmokeUrl, 'utf8')
const ciSource = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)
const ci = parse(ciSource) as {
  jobs: Record<
    string,
    {
      name: string
      'runs-on': string
      env: Record<string, string>
      steps: Array<{ name: string; run?: string }>
    }
  >
}
const signedWorkflowSource = readFileSync(
  new URL('../.github/workflows/macos-package-release.yml', import.meta.url),
  'utf8',
)
const signedWorkflow = parse(signedWorkflowSource) as {
  on: Record<string, unknown>
  jobs: Record<
    string,
    {
      environment: string
      steps: Array<{ name: string; run?: string; env?: Record<string, string> }>
    }
  >
}

describe('macOS native package contract', () => {
  it('builds one non-relocatable Apple-silicon package with atomic bundle upgrades', () => {
    expect(builder.mac?.target).toEqual(['pkg'])
    expect(builder.mac).not.toHaveProperty('identity')
    expect(builder.mac?.hardenedRuntime).toBe(true)
    expect(builder.mac?.entitlements).toBe('build/entitlements.mac.plist')
    expect(builder.mac?.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist')
    expect(builder.pkg).toMatchObject({
      artifactName: 'hvir-${version}-macos-${arch}.${ext}',
      scripts: 'pkg-scripts',
      installLocation: '/Applications',
      allowAnywhere: false,
      allowCurrentUserHome: false,
      allowRootDirectory: true,
      isRelocatable: false,
      isVersionChecked: true,
      hasStrictIdentifier: true,
      overwriteAction: 'upgrade',
    })
    expect(packageJson.scripts['pack:mac:arm64']).toContain(
      'electron-builder --mac pkg --arm64',
    )
    expect(packageJson.scripts['pack:mac:arm64:signed']).toContain(
      '--config.forceCodeSigning=true',
    )
  })

  it('installs an owned command and exact removal inventory transactionally', () => {
    expect(statSync(preinstallUrl).mode & 0o111).not.toBe(0)
    expect(preinstall).toContain('hvir-native-package-command-v1')
    expect(preinstall).toContain('hvir-native-package-inventory-v1')
    expect(preinstall).toContain('preflight refused unowned command')
    expect(preinstall).toContain('preflight refused unowned inventory')
    expect(statSync(postinstallUrl).mode & 0o111).not.toBe(0)
    expect(postinstall).toContain('application="$volume_root/Applications/hvir.app"')
    expect(postinstall).toContain('command="$command_dir/hvir"')
    expect(postinstall).toContain('inventory="$inventory_dir/package-inventory-v1.txt"')
    expect(postinstall).toContain('hvir-native-package-command-v1')
    expect(postinstall).toContain('hvir-native-package-inventory-v1')
    expect(nativeCommand).toContain(
      "application='/Applications/hvir.app/Contents/MacOS/hvir'",
    )
    expect(nativeCommand).toContain('exec "$application" "$@"')
    expect(postinstall).toContain('/bin/cp -- "$command_source" "$transaction/hvir"')
    expect(postinstall).toContain('refusing to replace an unowned hvir command')
    expect(postinstall).toContain('/bin/mv -- "$transaction/hvir" "$command"')
    expect(postinstall).toContain('hvir package configuration failed while $stage')
    expect(postinstall).not.toMatch(
      /Library\/Preferences|Application Support\/hvir\/settings/,
    )
  })

  it('accepts install, failed update retention, replacement, runtime, and removal', () => {
    expect(statSync(installedSmokeUrl).mode & 0o111).not.toBe(0)
    expect(installedSmoke).toContain("GITHUB_ACTIONS:-}\" != 'true'")
    expect(installedSmoke).toContain('pkgutil --check-signature')
    expect(installedSmoke).toContain('xcrun stapler validate')
    expect(installedSmoke).toContain('spctl --assess --type exec')
    expect(installedSmoke).toContain('spctl --assess --type install')
    expect(installedSmoke).toContain('"$old_installer" | tee "$install_log"')
    expect(installedSmoke).toContain('--version 0.0.0')
    expect(installedSmoke).toContain(
      'Postinstall-rejected package update unexpectedly succeeded.',
    )
    expect(installedSmoke).toContain(
      'sudo /usr/bin/install -o root -g wheel -m 0755 "$unowned_command" "$command"',
    )
    expect(installedSmoke).toContain('"$current_installer" | tee "$install_log"')
    expect(installedSmoke).toContain("grep -Fq 'installer: The upgrade was successful.'")
    expect(installedSmoke).toContain(
      'run_installed_smoke retained-after-failed-update pty-native',
    )
    expect(installedSmoke).toContain('run_installed_smoke current platform-contracts')
    expect(installedSmoke).toContain('"$command" . \\')
    expect(installedSmoke).toContain('"$current_installer" --uninstall --purge')
    expect(installedSmoke).toContain('scripts/render-native-installer.mjs')
    expect(installedSmoke).toContain('HVIR_FAKE_NPM_PREFIX="$legacy_prefix"')
    expect(installedSmoke).toContain('test ! -e "$legacy_launcher"')
    expect(installedSmoke).toContain("PATH='/usr/bin:/bin:/usr/sbin:/sbin'")
    expect(installedSmoke).toContain('otool -L "$executable"')
    expect(installedSmoke).toContain('find "$application" -type f -name \'*.node\'')
    expect(installedSmoke).toContain("-path '*/prebuilds/darwin-arm64/*'")
    expect(installedSmoke).toContain('Installed native module is not an arm64 Mach-O:')
    expect(installedSmoke).toContain('pkgutil --files "$receipt" |')
    expect(installedSmoke).toContain("grep -Fx 'hvir.app/Contents/MacOS/hvir' >/dev/null")
    expect(installedSmoke).not.toContain('pkgutil --files "$receipt" | grep -Fq')
    expect(installedSmoke).toContain('test -d "$project_root/.git"')
    expect(installedSmoke).not.toMatch(/open -a|Installer\.app|\/usr\/bin\/open/)
  })

  it('keeps credentials out of PR YAML and gates signing behind exact protected sources', () => {
    const structural = ci.jobs['native-macos-package']
    if (!structural) throw new Error('Missing native-macos-package CI job')
    expect(structural).toMatchObject({
      name: 'Native package acceptance (macOS arm64, unsigned structure)',
      'runs-on': 'macos-15',
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        HVIR_MACOS_PACKAGE_ACCEPTANCE: '1',
        HVIR_MACOS_PACKAGE_MODE: 'structural',
      },
    })
    expect(structural.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'npm run pack:mac:arm64' }),
        expect.objectContaining({ run: 'npm run smoke:macos:installed' }),
      ]),
    )
    expect(ciSource).not.toMatch(/MACOS_(APPLICATION|INSTALLER|NOTARY|TEAM)/)
    expect(ciSource).toContain('signed-macos-epic-acceptance:')
    expect(ciSource).toContain("github.event.pull_request.number == 234")
    expect(ciSource).toContain(
      "github.event.pull_request.base.ref == 'main'",
    )
    expect(ciSource).toContain(
      "github.event.pull_request.head.ref == 'epic/222-native-distribution'",
    )
    expect(ciSource).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    )
    expect(ciSource).toContain(
      'source_sha: ${{ github.event.pull_request.head.sha }}',
    )
    expect(ciSource).toContain(
      'source_branch: epic/222-native-distribution',
    )
    expect(ciSource).toContain('allow_pull_request_signing: true')
    expect(ciSource).toContain(
      'uses: ./.github/workflows/macos-package-release.yml',
    )

    expect(Object.keys(signedWorkflow.on)).toEqual([
      'workflow_call',
      'workflow_dispatch',
    ])
    expect(signedWorkflowSource).toContain('allow_merged_source')
    expect(signedWorkflowSource).toContain('allow_pull_request_signing')
    expect(signedWorkflowSource).toContain('source_branch')
    const workflowCall = signedWorkflow.on.workflow_call as {
      secrets: Record<string, { required: boolean }>
    }
    expect(Object.keys(workflowCall.secrets)).toEqual([
      'MACOS_APPLICATION_CERTIFICATE',
      'MACOS_APPLICATION_CERTIFICATE_PASSWORD',
      'MACOS_INSTALLER_CERTIFICATE',
      'MACOS_INSTALLER_CERTIFICATE_PASSWORD',
      'MACOS_NOTARY_KEY',
      'MACOS_NOTARY_KEY_ID',
      'MACOS_NOTARY_ISSUER_ID',
      'MACOS_TEAM_ID',
    ])
    for (const secret of Object.values(workflowCall.secrets)) {
      expect(secret.required).toBe(false)
    }
    const signed = signedWorkflow.jobs['signed-package']
    if (!signed) throw new Error('Missing signed-package release job')
    expect(signed.environment).toBe('native-release-signing')
    expect(signedWorkflowSource).toContain(
      'source_sha must exactly match the selected branch tip $WORKFLOW_SHA',
    )
    expect(signedWorkflowSource).toContain(
      'git fetch origin "refs/heads/$SOURCE_BRANCH"',
    )
    expect(signedWorkflowSource).toContain('git rev-parse FETCH_HEAD')
    expect(signedWorkflowSource).toContain('MACOS_APPLICATION_CERTIFICATE')
    expect(signedWorkflowSource).toContain('MACOS_INSTALLER_CERTIFICATE')
    expect(signedWorkflowSource).toContain('MACOS_NOTARY_KEY')
    expect(signedWorkflowSource).toContain(
      'Require protected signing credentials',
    )
    expect(signedWorkflowSource).toContain(
      'CSC_FOR_PULL_REQUEST: ${{ inputs.allow_pull_request_signing }}',
    )
    expect(signedWorkflowSource).toContain('xcrun stapler staple "$package"')
    expect(signedWorkflowSource).not.toMatch(/pull_request:|push:/)
  })
})
