import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderNativeInstaller } from '../scripts/render-native-installer.mjs'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const template = await readFile(
  new URL('../scripts/native-installer.template.sh', import.meta.url),
  'utf8',
)

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('release-owned native installer', () => {
  it('renders one executable release-specific script with embedded digests', async () => {
    const fixture = await createFixture()
    const output = join(fixture.root, 'dist', 'install.sh')
    const result = await renderNativeInstaller({
      ...fixture.options,
      output,
    })
    const script = await readFile(output, 'utf8')

    expect(result.releaseBaseUrl).toBe(
      'https://github.com/jarmak-personal/hvir/releases/download/v1.2.3',
    )
    expect(script).toContain("readonly HVIR_VERSION='1.2.3'")
    expect(script).toContain(
      "readonly HVIR_RELEASE_BASE_URL='https://github.com/jarmak-personal/hvir/releases/download/v1.2.3'",
    )
    for (const artifact of Object.values(result.artifacts)) {
      expect(script).toContain(artifact.name)
      expect(script).toContain(artifact.sha256)
    }
    expect(script).not.toMatch(/@@[A-Z0-9_]+@@/)
    await execFileAsync('/bin/bash', ['-n', output])
    await execFileAsync(output, ['--help'], {
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })
  })

  it('stops a digest mismatch before a native package operation and cleans temp state', async () => {
    vi.stubEnv('CI', 'true')
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const fixture = await createFixture({ acceptance: true })
    const output = join(fixture.root, 'install.sh')
    await renderNativeInstaller({ ...fixture.options, output })
    const validDigest = createHash('sha256').update('native-package').digest('hex')
    const script = (await readFile(output, 'utf8')).replaceAll(
      validDigest,
      '0'.repeat(64),
    )
    await writeFile(output, script)
    await chmod(output, 0o755)

    let failure: unknown
    try {
      await execFileAsync(output, {
        env: {
          ...process.env,
          HOME: fixture.home,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          TMPDIR: fixture.temporaryParent,
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error & { stderr: string }).stderr).toContain('Digest mismatch')
    expect(await readdir(fixture.temporaryParent)).toEqual([])
  })

  it('fails closed for unsafe release metadata and local acceptance inputs', async () => {
    const fixture = await createFixture()
    await expect(
      renderNativeInstaller({
        ...fixture.options,
        version: 'latest',
        output: join(fixture.root, 'install.sh'),
      }),
    ).rejects.toThrow(/Invalid hvir version/)
    vi.stubEnv('CI', 'false')
    vi.stubEnv('GITHUB_ACTIONS', 'false')
    await expect(
      renderNativeInstaller({
        ...fixture.options,
        acceptanceAssetDirectory: fixture.assetDirectory,
        output: join(fixture.root, 'install.sh'),
      }),
    ).rejects.toThrow(/GitHub Actions/)
  })

  it('keeps selection, privileges, migration, uninstall, and purge bounded', () => {
    const installFunction = template.indexOf('install_or_update()')
    const verifyCall = template.indexOf('\n  verify_native_command', installFunction)
    const removeCall = template.indexOf('\n  remove_legacy_launcher', installFunction)
    expect(template).toContain('Linux:x86_64)')
    expect(template).toContain('Linux:aarch64 | Linux:arm64)')
    expect(template).toContain('Darwin:arm64)')
    expect(template).toContain("linux_id\" != 'ubuntu'")
    expect(template).toContain("linux_version\" != '24.04'")
    expect(template).toContain("--proto '=https'")
    expect(template).toContain('Digest mismatch for $artifact_name.')
    expect(template).toContain('/usr/sbin/pkgutil --check-signature')
    expect(template).toContain('/usr/bin/xcrun stapler validate')
    expect(template).toContain('/usr/sbin/spctl --assess --type install')
    expect(template).toContain(
      '/usr/bin/sudo /usr/bin/apt install --no-install-recommends -y "$artifact"',
    )
    expect(template).toContain(
      '/usr/bin/sudo /usr/sbin/installer -pkg "$artifact" -target /',
    )
    expect(template).toContain('npm did not confirm ownership')
    expect(template).toContain('"$legacy_npm" uninstall -g hvir-workbench')
    expect(template).toContain('verify_native_command')
    expect(verifyCall).toBeGreaterThan(installFunction)
    expect(verifyCall).toBeLessThan(removeCall)
    expect(template).toContain('/usr/bin/sudo /usr/bin/apt remove -y hvir')
    expect(template).toContain('/usr/bin/sudo /bin/rm -rf -- /Applications/hvir.app')
    expect(template).toContain('Purging current-user hvir state: $path')
    expect(template).toContain('project directories were preserved')
    expect(template).not.toMatch(/\beval\b/)
    expect(template).not.toMatch(/--no-sandbox/)
    expect(template).not.toMatch(/\brm -rf (?:~|\$HOME|\/)(?:\s|$)/)
  })
})

async function createFixture(options: { acceptance?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hvir-native-installer-test-'))
  roots.push(root)
  const assetDirectory = join(root, 'assets')
  const home = join(root, 'home')
  const temporaryParent = join(root, 'tmp')
  await mkdir(assetDirectory)
  await mkdir(home)
  await mkdir(temporaryParent)
  const linuxX64Artifact = join(assetDirectory, 'hvir-1.2.3-linux-x64.deb')
  const linuxArm64Artifact = join(assetDirectory, 'hvir-1.2.3-linux-arm64.deb')
  const macosArm64Artifact = join(assetDirectory, 'hvir-1.2.3-darwin-arm64.pkg')
  await Promise.all(
    [linuxX64Artifact, linuxArm64Artifact, macosArm64Artifact].map((path) =>
      writeFile(path, 'native-package'),
    ),
  )
  return {
    assetDirectory,
    home,
    options: {
      version: '1.2.3',
      repository: 'jarmak-personal/hvir',
      linuxX64Artifact,
      linuxArm64Artifact,
      macosArm64Artifact,
      macosTeamId: 'ABCDE12345',
      ...(options.acceptance
        ? {
            acceptanceAssetDirectory: assetDirectory,
            acceptanceUnsignedMacos: true,
          }
        : {}),
    },
    root,
    temporaryParent,
  }
}
