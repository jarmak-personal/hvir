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
    expect(builder.mac?.entitlementsInherit).toBe(
      'build/entitlements.mac.inherit.plist',
    )
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
    expect(postinstall).toContain("application=\"$volume_root/Applications/hvir.app\"")
    expect(postinstall).toContain("command=\"$command_dir/hvir\"")
    expect(postinstall).toContain(
      "inventory=\"$inventory_dir/package-inventory-v1.txt\"",
    )
    expect(postinstall).toContain('hvir-native-package-command-v1')
    expect(postinstall).toContain('hvir-native-package-inventory-v1')
    expect(postinstall).toContain(
      'exec /Applications/hvir.app/Contents/MacOS/hvir "$@"',
    )
    expect(postinstall).toContain('refusing to replace an unowned hvir command')
    expect(postinstall).toContain('/bin/mv -- "$transaction/hvir" "$command"')
    expect(postinstall).toContain(
      'hvir package configuration failed while $stage',
    )
    expect(postinstall).not.toMatch(/Library\/Preferences|Application Support\/hvir\/settings/)
  })

  it('accepts install, failed update retention, replacement, runtime, and removal', () => {
    expect(statSync(installedSmokeUrl).mode & 0o111).not.toBe(0)
    expect(installedSmoke).toContain("GITHUB_ACTIONS:-}\" != 'true'")
    expect(installedSmoke).toContain('pkgutil --check-signature')
    expect(installedSmoke).toContain('xcrun stapler validate')
    expect(installedSmoke).toContain('spctl --assess --type exec')
    expect(installedSmoke).toContain('spctl --assess --type install')
    expect(installedSmoke).toContain(
      'sudo /usr/sbin/installer -pkg "$old_package" -target /',
    )
    expect(installedSmoke).toContain('--version 0.0.0')
    expect(installedSmoke).toContain(
      'Postinstall-rejected package update unexpectedly succeeded.',
    )
    expect(installedSmoke).toContain(
      'sudo /usr/bin/install -o root -g wheel -m 0755 "$unowned_command" "$command"',
    )
    expect(installedSmoke).toContain(
      'sudo /usr/sbin/installer -pkg "$package_path" -target /',
    )
    expect(installedSmoke).toContain(
      'run_installed_smoke retained-after-failed-update pty-native',
    )
    expect(installedSmoke).toContain('run_installed_smoke current platform-contracts')
    expect(installedSmoke).toContain("PATH='/usr/bin:/bin:/usr/sbin:/sbin'")
    expect(installedSmoke).toContain('otool -L "$executable"')
    expect(installedSmoke).toContain("find \"$application\" -type f -name '*.node'")
    expect(installedSmoke).toContain('test -d "$project_root/.git"')
    expect(installedSmoke).not.toMatch(/open -a|Installer\.app|\/usr\/bin\/open/)
  })

  it('keeps credentials out of PR checks and gates signing behind release protection', () => {
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

    expect(Object.keys(signedWorkflow.on)).toEqual(['workflow_dispatch'])
    const signed = signedWorkflow.jobs['signed-package']
    if (!signed) throw new Error('Missing signed-package release job')
    expect(signed.environment).toBe('native-release-signing')
    expect(signedWorkflowSource).toContain(
      'source_sha must exactly match the selected branch tip $WORKFLOW_SHA',
    )
    expect(signedWorkflowSource).toContain(
      'git rev-parse "origin/$SOURCE_REF"',
    )
    expect(signedWorkflowSource).toContain('MACOS_APPLICATION_CERTIFICATE')
    expect(signedWorkflowSource).toContain('MACOS_INSTALLER_CERTIFICATE')
    expect(signedWorkflowSource).toContain('MACOS_NOTARY_KEY')
    expect(signedWorkflowSource).toContain('xcrun stapler staple "$package"')
    expect(signedWorkflowSource).not.toMatch(/pull_request:|push:/)
  })
})
