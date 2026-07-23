import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const builder = parse(
  readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }
const appArmorProfile = readFileSync(
  new URL('../build/linux/hvir.apparmor', import.meta.url),
  'utf8',
)
const afterInstall = readFileSync(
  new URL('../build/linux/after-install.sh', import.meta.url),
  'utf8',
)
const afterRemove = readFileSync(
  new URL('../build/linux/after-remove.sh', import.meta.url),
  'utf8',
)
const installedSmoke = readFileSync(
  new URL('../scripts/run-linux-package-smoke.sh', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
)

describe('Linux native package contract', () => {
  it('builds only Debian packages for both supported native architectures', () => {
    expect(builder.linux?.target).toEqual(['deb'])
    expect(packageJson.scripts['pack:linux:x64']).toContain(
      'electron-builder --linux deb --x64',
    )
    expect(packageJson.scripts['pack:linux:arm64']).toContain(
      'electron-builder --linux deb --arm64',
    )
    expect(builder.deb?.packageCategory).toBe('devel')
    expect(builder.deb?.depends).toContain('apparmor')
    expect(builder.deb?.appArmorProfile).toBe('build/linux/hvir.apparmor')
  })

  it('attaches the auditable AppArmor policy to the exact package executable', () => {
    expect(appArmorProfile).toContain(
      'profile "${executable}" "/opt/${sanitizedProductName}/${executable}"',
    )
    expect(appArmorProfile).toContain('flags=(unconfined)')
    expect(appArmorProfile).toContain('userns,')
    expect(afterInstall).toContain(
      "APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'",
    )
    expect(afterInstall).toContain(
      "APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'",
    )
    expect(afterInstall).toContain('apparmor_parser --skip-kernel-load --debug')
    expect(afterInstall).toContain('chmod 4755')
    expect(afterInstall).toContain('hvir package configuration failed while $stage')
  })

  it('retains replacement-owned state during updates and removes only package state', () => {
    expect(afterRemove).toContain(
      'upgrade | failed-upgrade | abort-install | abort-upgrade | disappear',
    )
    expect(afterRemove).toContain("update-alternatives \\\n    --remove '${executable}'")
    expect(afterRemove).toContain('apparmor_parser --remove')
    expect(afterRemove).not.toMatch(/config|projects|HOME/)
  })

  it('accepts install, update, sandbox, native bindings, and removal on Ubuntu 24.04', () => {
    expect(installedSmoke).toContain(
      '"${ID:-}" != \'ubuntu\' || "${VERSION_ID:-}" != \'24.04\'',
    )
    expect(installedSmoke).toContain('/usr/bin/apt install')
    expect(installedSmoke).toContain('run_installed_smoke previous pty-native')
    expect(installedSmoke).toContain('run_installed_smoke current platform-contracts')
    expect(installedSmoke).toContain('HVIR_SMOKE_REQUIRE_PROCESS_SANDBOX=1')
    expect(installedSmoke).toContain(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    )
    expect(installedSmoke).toContain(
      'PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin"',
    )
    expect(installedSmoke).toContain('test -d "$project_root/.git"')
    expect(installedSmoke).not.toContain('--no-sandbox')
    expect(ciWorkflow).toContain('Native package acceptance (${{ matrix.name }})')
    expect(ciWorkflow).toContain('ubuntu-24.04-arm')
    expect(ciWorkflow).toContain('xvfb-run -a npm run smoke:linux:installed')
  })
})
