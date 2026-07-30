import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
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
    expect((failure as Error & { stderr: string }).stderr).toContain(
      'failed while verifying the SHA-256 digest',
    )
    expect(await readdir(fixture.temporaryParent)).toEqual([])
  })

  it('presents a concise successful macOS install and npm migration', async () => {
    const executable = await createExecutableMacosFixture({ legacy: true })
    const result = await execFileAsync(executable.script, {
      env: executable.env,
    })

    expect(result.stdout.trim().split('\n')).toEqual([
      'Installing hvir 1.2.3 for macOS (Apple silicon).',
      'Downloading the native package...',
      'Download integrity verified.',
      'Apple signature, notarization, and Gatekeeper checks passed.',
      'macOS will request your local administrator password; typed characters will not appear.',
      'Removed the legacy npm installation.',
      'hvir 1.2.3 is installed. Open a project with: hvir .',
    ])
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toMatch(
      /hvir-installer\.|\/private\/var|pkgutil raw|stapler raw|spctl raw|installer raw|removed 2 packages/,
    )
  })

  it('uses the same presentation vocabulary for a macOS update', async () => {
    const executable = await createExecutableMacosFixture({ installed: true })
    const result = await execFileAsync(executable.script, {
      env: executable.env,
    })

    expect(result.stdout).toContain('Updating hvir to 1.2.3 for macOS (Apple silicon).')
    expect(result.stdout).toContain('Download integrity verified.')
    expect(result.stdout).toContain(
      'Apple signature, notarization, and Gatekeeper checks passed.',
    )
    expect(result.stdout).toContain(
      'macOS will request your local administrator password; typed characters will not appear.',
    )
    expect(result.stdout).toContain('hvir 1.2.3 is updated. Open a project with: hvir .')
    expect(result.stdout).not.toMatch(/hvir-installer\.|\/private\/var|installer raw/)
  })

  it.each([
    ['signature', 'validating the macOS installer signature', 'signature diagnostic'],
    [
      'notarization',
      'validating the stapled macOS notarization ticket',
      'notarization diagnostic',
    ],
    [
      'gatekeeper',
      'assessing the macOS package with Gatekeeper',
      'Gatekeeper diagnostic',
    ],
    [
      'package-manager',
      'installing hvir 1.2.3 with the macOS package manager',
      'package manager diagnostic',
    ],
    [
      'migration',
      'removing the verified legacy hvir-workbench launcher',
      'npm migration diagnostic',
    ],
  ] as const)(
    'retains %s diagnostics with the failing stage',
    async (failure, stage, diagnostic) => {
      const executable = await createExecutableMacosFixture({
        failure,
        legacy: failure === 'migration',
      })

      let error: unknown
      try {
        await execFileAsync(executable.script, { env: executable.env })
      } catch (caught) {
        error = caught
      }

      expect(error).toBeInstanceOf(Error)
      const stderr = (error as Error & { stderr: string }).stderr
      expect(stderr).toContain(diagnostic)
      expect(stderr).toContain(`failed while ${stage}`)
    },
  )

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
    const resolutionCall = template.indexOf(
      '\n  verify_native_command_resolution',
      installFunction,
    )
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
    expect(template).toContain('run_with_failure_diagnostics')
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
    expect(template).toContain('hash -r')
    expect(template).toContain(
      'Another hvir command shadows the installed native command:',
    )
    expect(resolutionCall).toBeGreaterThan(removeCall)
    expect(template).toContain('/usr/bin/sudo /usr/bin/apt remove -y hvir')
    expect(template).toContain('/usr/bin/sudo /bin/rm -rf -- /Applications/hvir.app')
    expect(template).toContain('Purging current-user hvir state: $path')
    expect(template).toContain('project directories were preserved')
    expect(template).not.toMatch(/\beval\b/)
    expect(template).not.toMatch(/--no-sandbox/)
    expect(template).not.toMatch(/\brm -rf (?:~|\$HOME|\/)(?:\s|$)/)
  })
})

type MacosFailure =
  'signature' | 'notarization' | 'gatekeeper' | 'package-manager' | 'migration'

async function createExecutableMacosFixture(
  options: {
    failure?: MacosFailure
    installed?: boolean
    legacy?: boolean
  } = {},
) {
  vi.stubEnv('CI', 'true')
  vi.stubEnv('GITHUB_ACTIONS', 'true')
  const fixture = await createFixture({ acceptance: true, unsignedMacos: false })
  const script = join(fixture.root, 'install.sh')
  await renderNativeInstaller({ ...fixture.options, output: script })

  const toolDirectory = join(fixture.root, 'tools')
  const nativeDirectory = join(fixture.root, 'native-bin')
  const nativeCommand = join(nativeDirectory, 'hvir')
  const packageState = join(fixture.root, 'package-installed')
  await Promise.all([mkdir(toolDirectory), mkdir(nativeDirectory)])

  const tools = {
    installer: join(toolDirectory, 'installer'),
    pkgutil: join(toolDirectory, 'pkgutil'),
    spctl: join(toolDirectory, 'spctl'),
    sudo: join(toolDirectory, 'sudo'),
    uname: join(toolDirectory, 'uname'),
    xcrun: join(toolDirectory, 'xcrun'),
  }
  await Promise.all([
    writeExecutable(
      tools.uname,
      `#!/bin/bash
case "$1" in
-s) echo Darwin ;;
-m) echo arm64 ;;
*) exit 64 ;;
esac
`,
    ),
    writeExecutable(
      tools.pkgutil,
      `#!/bin/bash
case "$1" in
--check-signature)
  echo 'pkgutil raw: Developer ID Installer: Fixture (ABCDE12345)'
  echo 'Signed with a trusted timestamp'
  if [[ "\${HVIR_TEST_FAILURE:-}" == signature ]]; then
    echo 'signature diagnostic' >&2
    exit 41
  fi
  ;;
--pkg-info)
  test -f "$HVIR_TEST_PACKAGE_STATE"
  ;;
*) exit 64 ;;
esac
`,
    ),
    writeExecutable(
      tools.xcrun,
      `#!/bin/bash
echo 'stapler raw: The validate action worked!'
if [[ "\${HVIR_TEST_FAILURE:-}" == notarization ]]; then
  echo 'notarization diagnostic' >&2
  exit 42
fi
`,
    ),
    writeExecutable(
      tools.spctl,
      `#!/bin/bash
echo 'spctl raw: accepted; source=Notarized Developer ID'
if [[ "\${HVIR_TEST_FAILURE:-}" == gatekeeper ]]; then
  echo 'Gatekeeper diagnostic' >&2
  exit 43
fi
`,
    ),
    writeExecutable(
      tools.sudo,
      `#!/bin/bash
echo 'sudo raw: Password:'
exec "$@"
`,
    ),
    writeExecutable(
      tools.installer,
      `#!/bin/bash
echo 'installer raw: Processing /private/var/folders/hvir-installer.fixture/package.pkg'
if [[ "\${HVIR_TEST_FAILURE:-}" == package-manager ]]; then
  echo 'package manager diagnostic' >&2
  exit 44
fi
printf '#!/bin/bash\n# hvir-native-package-command-v1\n' >"$HVIR_TEST_NATIVE_COMMAND"
chmod 0755 "$HVIR_TEST_NATIVE_COMMAND"
touch "$HVIR_TEST_PACKAGE_STATE"
echo 'installer raw: The upgrade was successful.'
`,
    ),
  ])

  if (options.installed) {
    await writeExecutable(
      nativeCommand,
      '#!/bin/bash\n# hvir-native-package-command-v1\n',
    )
    await writeFile(packageState, '')
  }

  let path = `${nativeDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fixture.home,
    HVIR_TEST_FAILURE: options.failure,
    HVIR_TEST_NATIVE_COMMAND: nativeCommand,
    HVIR_TEST_PACKAGE_STATE: packageState,
    PATH: path,
    TMPDIR: fixture.temporaryParent,
  }
  if (options.legacy) {
    const legacyPrefix = join(fixture.root, 'legacy-npm')
    const legacyRoot = join(legacyPrefix, 'lib', 'node_modules')
    const legacyBin = join(legacyPrefix, 'bin')
    const legacyTarget = join(legacyRoot, 'hvir-workbench', 'bin', 'hvir.mjs')
    await Promise.all([
      mkdir(legacyBin, { recursive: true }),
      mkdir(join(legacyRoot, 'hvir-workbench', 'bin'), { recursive: true }),
    ])
    await writeExecutable(legacyTarget, '#!/bin/bash\n')
    await symlink(
      '../lib/node_modules/hvir-workbench/bin/hvir.mjs',
      join(legacyBin, 'hvir'),
    )
    await writeExecutable(
      join(legacyBin, 'npm'),
      `#!/bin/bash
case "$1:$2" in
prefix:-g) echo "$HVIR_TEST_LEGACY_PREFIX" ;;
root:-g) echo "$HVIR_TEST_LEGACY_ROOT" ;;
ls:-g) echo "$HVIR_TEST_LEGACY_ROOT/hvir-workbench" ;;
uninstall:-g)
  echo 'removed 2 packages in 321ms'
  if [[ "\${HVIR_TEST_FAILURE:-}" == migration ]]; then
    echo 'npm migration diagnostic' >&2
    exit 45
  fi
  rm -f "$HVIR_TEST_LEGACY_PREFIX/bin/hvir"
  rm -rf "$HVIR_TEST_LEGACY_ROOT/hvir-workbench"
  ;;
*) exit 64 ;;
esac
`,
    )
    path = `${legacyBin}:${path}`
    env.HVIR_TEST_LEGACY_PREFIX = legacyPrefix
    env.HVIR_TEST_LEGACY_ROOT = legacyRoot
    env.PATH = path
  }

  const replacements = new Map([
    ['/usr/bin/uname', tools.uname],
    ['/usr/bin/sudo', tools.sudo],
    ['/usr/sbin/pkgutil', tools.pkgutil],
    ['/usr/sbin/installer', tools.installer],
    ['/usr/sbin/spctl', tools.spctl],
    ['/usr/bin/xcrun', tools.xcrun],
    ['/usr/local/bin/hvir', nativeCommand],
  ])
  let source = await readFile(script, 'utf8')
  for (const [from, to] of replacements) source = source.replaceAll(from, to)
  await writeFile(script, source)
  await chmod(script, 0o755)

  return { env, script }
}

async function writeExecutable(path: string, source: string) {
  await writeFile(path, source)
  await chmod(path, 0o755)
}

async function createFixture(
  options: { acceptance?: boolean; unsignedMacos?: boolean } = {},
) {
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
            acceptanceUnsignedMacos: options.unsignedMacos ?? true,
          }
        : {}),
    },
    root,
    temporaryParent,
  }
}
