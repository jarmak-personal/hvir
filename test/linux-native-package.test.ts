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
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const packagedRuntimeInspection = readFileSync(
  new URL('../scripts/inspect-packaged-runtime.mts', import.meta.url),
  'utf8',
)
const installedStartupProbe = readFileSync(
  new URL('../scripts/installed-startup-probe.mts', import.meta.url),
  'utf8',
)

describe('Linux native package contract', () => {
  it('builds only Debian packages for both supported native architectures', () => {
    expect(builder.linux?.target).toEqual(['deb'])
    expect(builder.linux?.icon).toBe('build/icons-linux')
    expect(packageJson.scripts['pack:linux:x64']).toContain(
      'electron-builder --linux deb --x64',
    )
    expect(packageJson.scripts['pack:linux:arm64']).toContain(
      'electron-builder --linux deb --arm64',
    )
    expect(builder.deb?.packageCategory).toBe('devel')
    expect(builder.deb?.depends).not.toContain('apparmor')
    expect(builder.deb?.depends).toContain('libc6 (>= 2.35)')
    expect(builder.deb?.depends).toContain('libstdc++6 (>= 12)')
    expect(builder.deb?.depends).toContain('libasound2 | libasound2t64')
    expect(builder.deb?.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64')
    expect(builder.deb?.depends).toContain('libgtk-3-0 | libgtk-3-0t64')
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
    expect(afterInstall).toContain(
      "HVIR_COMMAND='/opt/${sanitizedProductName}/resources/hvir-command'",
    )
    expect(afterInstall).toContain('apparmor_parser --skip-kernel-load --debug')
    expect(afterInstall).toContain(
      'APPARMOR_USERNS_RESTRICTION=/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    )
    expect(afterInstall).toContain('runuser -u nobody -- unshare --user true')
    expect(afterInstall).toContain('chmod 4755')
    expect(afterInstall).toContain('hvir package configuration failed while $stage')
  })

  it('retains replacement-owned state during updates and removes only package state', () => {
    expect(afterRemove).toContain(
      'upgrade | failed-upgrade | abort-install | abort-upgrade | disappear',
    )
    expect(afterRemove).toContain(
      'update-alternatives \\\n    --remove \'${executable}\' "$HVIR_COMMAND"',
    )
    expect(afterRemove).toContain('apparmor_parser --remove')
    expect(afterRemove).not.toMatch(/config|projects|HOME/)
  })

  it('accepts package structure, ordinary startup, sandbox integration, and removal across the Linux matrix', () => {
    expect(installedSmoke).not.toMatch(/\b(?:ID|ID_LIKE|VERSION_ID)=/)
    expect(installedSmoke).not.toContain('/etc/os-release')
    expect(installedSmoke).toContain('scripts/render-native-installer.mjs')
    expect(installedSmoke).toContain('"$previous_installer" 2>&1 | tee "$install_log"')
    expect(installedSmoke).toContain('"$current_installer" 2>&1 | tee "$update_log"')
    expect(installedSmoke).toContain('assert_packaged_runtime')
    expect(installedSmoke).toContain('--exercise-harness-dialogs')
    expect(installedSmoke).toContain('run_installed_startup previous')
    expect(installedSmoke).toContain('run_installed_startup current')
    expect(installedSmoke).not.toContain('run_installed_smoke')
    expect(installedSmoke).not.toContain('HVIR_SMOKE_REQUIRE_PROCESS_SANDBOX')
    expect(installedSmoke).toContain(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    )
    expect(installedSmoke).toContain(
      'PATH="$blocked_tools_root:/usr/sbin:/usr/bin:/sbin:/bin"',
    )
    expect(installedSmoke).toContain('--command /usr/bin/hvir')
    expect(installedSmoke).toContain('--expected-main /opt/hvir/hvir')
    expect(installedSmoke).toContain('--native-platform linux')
    expect(installedSmoke).toContain('"$current_installer" --uninstall --purge')
    expect(installedSmoke).toContain('HVIR_FAKE_NPM_PREFIX="$legacy_prefix"')
    expect(installedSmoke).toContain('test ! -e "$legacy_launcher"')
    expect(installedSmoke).toContain(
      'Another hvir command shadows the installed native command:',
    )
    expect(installedSmoke).toContain(
      'require_contains "$desktop_entry" \'Exec=/opt/hvir/hvir %U\'',
    )
    expect(installedSmoke).toContain('"build/icons-linux/${icon_size}x${icon_size}.png"')
    expect(installedSmoke).toContain('test -d "$project_root/.git"')
    expect(installedSmoke).not.toContain('--no-sandbox')
    expect(packagedRuntimeInspection).toContain("'/out/main/echo-worker.js'")
    expect(packagedRuntimeInspection).toContain("'/out/main/git-worker.js'")
    expect(packagedRuntimeInspection).toContain(
      "'/node_modules/node-pty/build/Release/pty.node'",
    )
    expect(packagedRuntimeInspection).toContain("'HVIR_SMOKE'")
    expect(installedStartupProbe).toContain("process.command.includes('--type=renderer')")
    expect(installedStartupProbe).toContain("await stopProcessGroup(child, 'SIGTERM'")
    expect(installedStartupProbe).toContain("HVIR_SMOKE: '1'")
    expect(releaseWorkflow).toContain(
      'Build and accept Linux package (${{ matrix.name }})',
    )
    expect(releaseWorkflow).toContain('ubuntu-22.04-arm')
    expect(releaseWorkflow).toContain('ubuntu-24.04-arm')
    expect(releaseWorkflow).toContain('node:24-trixie')
    expect(releaseWorkflow).toContain(
      'xvfb-run -a npm run smoke:linux:installed',
    )
    expect(ciWorkflow).toContain('xvfb-run -a npm run smoke')
  })
})
