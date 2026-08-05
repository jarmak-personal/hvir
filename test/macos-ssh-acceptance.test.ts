import { readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const acceptanceBuilder = parse(
  readFileSync(
    new URL('../electron-builder.ssh-acceptance.yml', import.meta.url),
    'utf8',
  ),
) as Record<string, Record<string, unknown> | string | boolean>
const releaseBuilder = parse(
  readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown> | string>
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }
const buildScriptUrl = new URL('../scripts/run-macos-ssh-acceptance.sh', import.meta.url)
const buildScript = readFileSync(buildScriptUrl, 'utf8')
const identityScriptUrl = new URL(
  '../scripts/record-macos-ssh-identity.sh',
  import.meta.url,
)
const identityScript = readFileSync(identityScriptUrl, 'utf8')
const mainEntry = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const applicationRuntime = readFileSync(
  new URL('../src/main/application-runtime.ts', import.meta.url),
  'utf8',
)
const buildConfig = readFileSync(
  new URL('../electron.vite.config.ts', import.meta.url),
  'utf8',
)

describe('macOS SSH acceptance channel', () => {
  it('retains the release identity and defines one distinct non-installing bundle', () => {
    expect(releaseBuilder).toMatchObject({
      appId: 'dev.hvir.app',
      productName: 'hvir',
    })
    expect(acceptanceBuilder).toMatchObject({
      extends: './electron-builder.yml',
      appId: 'dev.hvir.ssh-acceptance',
      productName: 'hvir SSH Acceptance',
      forceCodeSigning: true,
      directories: { output: 'dist/ssh-acceptance', buildResources: 'build' },
      mac: {
        target: null,
        extendInfo: {
          NSLocalNetworkUsageDescription:
            'hvir SSH Acceptance connects to contributor-selected SSH hosts on the local network.',
        },
      },
    })
    expect(acceptanceBuilder).not.toHaveProperty('pkg')
  })

  it('fails closed on signing inputs and launches only the inspected bundle', () => {
    expect(statSync(buildScriptUrl).mode & 0o111).not.toBe(0)
    expect(buildScript).toContain('MACOS_APPLICATION_CERTIFICATE')
    expect(buildScript).toContain('MACOS_APPLICATION_CERTIFICATE_PASSWORD')
    expect(buildScript).toContain('MACOS_TEAM_ID')
    expect(buildScript).toContain(
      'Refusing to build or launch an ad-hoc or raw Electron SSH acceptance app.',
    )
    expect(buildScript.indexOf('if [[ "$missing" == true ]]')).toBeLessThan(
      buildScript.indexOf('npm run build -- --mode ssh-acceptance'),
    )
    expect(buildScript).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
    expect(buildScript).toContain('--config electron-builder.ssh-acceptance.yml')
    expect(buildScript).toContain(
      'scripts/record-macos-ssh-identity.sh --acceptance "$application"',
    )
    expect(buildScript).toContain('exec "$executable"')
    expect(buildScript).not.toMatch(
      /npm run dev|electron-vite dev|codesign[^\n]*--sign -/,
    )
    expect(packageJson.scripts['build:macos:ssh-acceptance']).toContain('--build-only')
    expect(packageJson.scripts['acceptance:ssh:macos']).toBe(
      'bash scripts/run-macos-ssh-acceptance.sh',
    )
  })

  it('records only closed Apple identity facts for the exact two bundles', () => {
    expect(statSync(identityScriptUrl).mode & 0o111).not.toBe(0)
    expect(identityScript).toContain('dev.hvir.app')
    expect(identityScript).toContain('dev.hvir.ssh-acceptance')
    expect(identityScript).toContain("'Developer ID Application:'*")
    expect(identityScript).toContain('Team ID: $team_id')
    expect(identityScript).toContain('designated requirement: $requirement')
    expect(identityScript).toContain('main-executable UUID: $uuids')
    expect(identityScript).toContain(
      'acceptance application has no Local Network usage description.',
    )
    expect(identityScript).not.toMatch(/cat "\$signature_log"|cat "\$requirement_log"/)
  })

  it('selects the compiled channel and root before constructing storage owners', () => {
    expect(buildConfig).toContain("mode === 'ssh-acceptance'")
    expect(buildConfig).toContain("'ssh-acceptance'")
    expect(buildConfig).toContain('__HVIR_BUILD_CHANNEL__')
    expect(applicationRuntime).toContain('configureApplicationRuntime(')
    expect(applicationRuntime).toContain('__HVIR_BUILD_CHANNEL__')
    const selection = mainEntry.indexOf("from './application-runtime'")
    expect(selection).toBeGreaterThan(-1)
    for (const construction of [
      'RuntimeDiagnostics.create(',
      'ProjectHostCatalog.create(',
      'ProjectRegistry.create(',
      'TerminalSessionRegistry.load(',
      'HarnessProfileStore.load(',
    ]) {
      expect(selection).toBeLessThan(mainEntry.indexOf(construction))
    }
    expect(mainEntry).not.toContain("app.getPath('userData')")
  })
})
