import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  buildInputFlags,
  digest,
  pin,
  pinPath,
  repository,
  verifyArtifact,
} from './artifacts.mts'
import { execute, prepareSource, prepareZig } from './source.mts'
import { inspectBinary } from './binary.mts'

const [target, requestedWork, ...rest] = process.argv.slice(2)
const selected = target && pin.targets[target]
if (!selected || !requestedWork || rest.length % 2)
  throw new Error(
    'Usage: native:build -- TARGET NEW_WORK [--zig PATH] [--source-archive PATH] [--packages PATH]',
  )
const options = new Map<string, string>()
for (let n = 0; n < rest.length; n += 2) {
  const key = rest[n]!,
    value = rest[n + 1]!
  if (!['--zig', '--source-archive', '--packages'].includes(key) || options.has(key))
    throw new Error('Invalid build option')
  options.set(key, resolve(value))
}
if (process.platform !== selected.platform || process.arch !== selected.arch)
  throw new Error(
    'native-build: use a matching native host; cross-build is not loader evidence',
  )
const work = resolve(requestedWork)
const environment = {
  ...process.env,
  ZIG_GLOBAL_CACHE_DIR: join(work, 'build-cache'),
  ...(selected.platform === 'linux' ? { PKG_CONFIG_ALLOW_SYSTEM_LIBS: '1' } : {}),
}
let egl: Record<string, string> | undefined
if (selected.platform === 'linux') {
  try {
    egl = {
      pkgConfig: (await execute('pkg-config', ['--version'])).stdout.trim(),
      moduleVersion: (
        await execute('pkg-config', ['--modversion', 'egl'])
      ).stdout.trim(),
      linkFlags: (
        await execute('pkg-config', ['--libs', 'egl'], { env: environment })
      ).stdout.trim(),
      allowSystemLibs: '1',
    }
  } catch (cause) {
    throw new Error(
      'native-toolchain: Linux requires pkg-config and EGL development files (Ubuntu 22.04: pkg-config libegl-dev)',
      { cause },
    )
  }
}
await mkdir(work) // Each attempt retains its own evidence; never overwrite a previous build.
const zig = options.get('--zig') ?? (await prepareZig(work))
if ((await execute(zig, ['version'])).stdout.trim() !== pin.zig.version)
  throw new Error('native-toolchain: version mismatch')
const source = await prepareSource(work, options.get('--source-archive'))
const packages = options.get('--packages') ?? join(work, 'dependency-cache/p')
if (!options.has('--packages')) {
  await run(
    'sh',
    [
      join(source, 'nix/build-support/fetch-zig-cache.sh'),
      join(source, 'deps/packages.txt'),
    ],
    source,
    {
      ...environment,
      PATH: `${resolve(zig, '..')}:${process.env.PATH ?? ''}`,
      ZIG_GLOBAL_CACHE_DIR: join(work, 'dependency-cache'),
    },
  )
}
const inventory = JSON.parse(
  await readFile(join(source, 'deps/packages.json'), 'utf8'),
) as Record<string, unknown>
const packageNames = await readdir(packages)
if (Object.keys(inventory).some((name) => !packageNames.includes(name)))
  throw new Error('native-build: incomplete dependency cache')
const prefix = join(work, 'install')
const args = [
  'build',
  '-j2',
  '--system',
  packages,
  // --system makes Linux prefer ambient libraries unless explicitly disabled.
  // Use the pinned source dependencies, matching upstream's macOS defaults.
  '-fno-sys=freetype',
  '-fno-sys=harfbuzz',
  '-fno-sys=fontconfig',
  '-fno-sys=libpng',
  '-fno-sys=zlib',
  '-fno-sys=oniguruma',
  ...(selected.platform === 'linux' ? ['-fno-sys=libxml2'] : []),
  '--cache-dir',
  join(work, 'local-cache'),
  '-Dapp-runtime=none',
  '-Demit-lib-vt=false',
  '-Demit-xcframework=false',
  '-Demit-macos-app=false',
  '-Demit-docs=false',
  '-Demit-themes=false',
  '-Doptimize=ReleaseFast',
  `-Dtarget=${selected.triple}`,
  `-Dversion-string=${pin.source.applicationVersion}`,
  `-Dlib-version-string=${pin.source.vtVersion}`,
  '--prefix',
  prefix,
]
await run(zig, args, source, environment)
const output = join(work, 'artifact')
await mkdir(output)
await cp(join(prefix, 'lib', selected.library), join(output, selected.library))
await cp(join(source, 'include/ghostty.h'), join(output, 'ghostty.h'))
await cp(
  join(repository, 'packages/native-terminal/hvir_ghostty_embed.h'),
  join(output, 'hvir_ghostty_embed.h'),
)
await run(
  'cc',
  [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-I',
    join(source, 'include'),
    '-I',
    join(repository, 'packages/native-terminal'),
    join(repository, 'packages/native-terminal/loader_probe.c'),
    ...(process.platform === 'linux' ? ['-ldl'] : []),
    '-o',
    join(output, 'loader-probe'),
  ],
  repository,
)
const dependencyReport = await inspectBinary(
  join(output, selected.library),
  selected.platform,
  selected.arch,
)
console.log(dependencyReport)
await run(
  join(output, 'loader-probe'),
  [join(output, selected.library), pin.source.applicationVersion],
  work,
)
for (const [library, version, code] of [
  [join(output, 'absent-library'), pin.source.applicationVersion, 70],
  [join(output, selected.library), 'wrong-version', 72],
  [
    process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
    pin.source.applicationVersion,
    71,
  ],
] as const) {
  try {
    await execute(join(output, 'loader-probe'), [library, version], { timeout: 30_000 })
    throw new Error('native-loader: expected refusal was accepted')
  } catch (error) {
    if ((error as { code?: number }).code !== code) throw error
  }
}
const relocated = join(work, 'relocated')
await cp(output, relocated, { recursive: true })
await run(
  join(relocated, 'loader-probe'),
  [join(relocated, selected.library), pin.source.applicationVersion],
  work,
)
// Keep upstream and dependency notices with the artifact. This is the full renderer input set,
// not the smaller libghostty-vt-only license inventory.
const notices = join(output, 'notices')
await mkdir(notices)
await cp(join(source, 'LICENSE'), join(notices, 'ghostty-LICENSE'))
await cp(join(repository, 'LICENSE'), join(notices, 'hvir-LICENSE'))
for (const file of [
  'LICENSE',
  'lib/libcxx/LICENSE.TXT',
  'lib/libcxxabi/LICENSE.TXT',
  'lib/libunwind/LICENSE.TXT',
])
  await cp(join(dirname(zig), file), join(notices, `zig-${file.replaceAll('/', '-')}`))

for (const file of ['README.md', 'OFL.txt', 'MIT.txt', 'BSD-2-Clause.txt'])
  await cp(join(source, 'src/font/res', file), join(notices, `embedded-fonts-${file}`))
for (const file of [
  'vendor/nerd-fonts/LICENSE',
  'pkg/simdutf/vendor/LICENSE-MIT',
  'pkg/simdutf/vendor/LICENSE-APACHE',
])
  await cp(join(source, file), join(notices, file.replaceAll('/', '-')))

for (const name of Object.keys(inventory)) {
  const directory = join(packages, name)
  for (const file of await readdir(directory)) {
    if (/^(LICENSE|COPYING|COPYRIGHT)([.-]|$)/i.test(file)) {
      const destination = join(notices, `${name}-${file}`)
      await cp(join(directory, file), destination, { recursive: true })
    }
  }
}
const files: { path: string; sha256: string; bytes: number }[] = []
async function record(directory: string, relative = ''): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) await record(path, name)
    else if (entry.isFile())
      files.push({
        path: name,
        sha256: await digest(path),
        bytes: (await stat(path)).size,
      })
    else throw new Error('native-artifact: unexpected notice symlink')
  }
}
await record(output)
const hvirSource = (
  await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })
).stdout.trim()
const versions = {
  zig: pin.zig.version,
  zigBinarySha256: await digest(zig),
  cc: (await execute('cc', ['--version'])).stdout.split('\n')[0],
  ...(egl ? { egl } : {}),
  ...(process.platform === 'darwin'
    ? {
        xcode: (await execute('xcodebuild', ['-version'])).stdout.trim(),
        sdk: (
          await execute('xcrun', ['--sdk', 'macosx', '--show-sdk-version'])
        ).stdout.trim(),
        metal: (await execute('xcrun', ['metal', '--version'])).stdout.split('\n')[0],
      }
    : {}),
}
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      schema: 1,
      source: hvirSource,
      pinSha256: await digest(pinPath),
      target,
      applicationVersion: pin.source.applicationVersion,
      vtVersion: pin.source.vtVersion,
      embedAbi: pin.source.embedAbi,
      build: {
        upstream: pin.source.commit,
        sourceArchiveSha256: pin.source.sha256,
        patches: pin.patches,
        versions,
        ...buildInputFlags(
          {
            zig: options.has('--zig'),
            sourceArchive: options.has('--source-archive'),
            packages: options.has('--packages'),
          },
          Boolean(
            (
              await execute(
                'git',
                [
                  'status',
                  '--porcelain',
                  '--',
                  'scripts/native-terminal',
                  'packages/native-terminal',
                ],
                { cwd: repository },
              )
            ).stdout.trim(),
          ),
        ),
        options: args.map((a) =>
          a.startsWith(work) || a === packages ? '<build-path>' : a,
        ),
        loader: 'passed',
        loaderRefusals: ['missing-library', 'wrong-version', 'missing-embedding-ABI'],
        relocatedLoader: 'passed',
        dependencyReport,
      },
      files,
    },
    null,
    2,
  ) + '\n',
)
await verifyArtifact(output, target, true)
console.log(`HVIR_NATIVE_BUILD_OK ${target}; artifact=${output}`)

async function run(
  command: string,
  commandArgs: string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      stdio: 'inherit',
      detached: true,
    })
    let interrupted = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      interrupted = true
      if (!child.pid) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* Already settled. */
      }
      escalation ??= setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          /* Already settled. */
        }
      }, 5000)
    }
    const deadline = setTimeout(stop, 30 * 60_000)
    const cleanup = () => {
      clearTimeout(deadline)
      if (escalation) clearTimeout(escalation)
      process.removeListener('SIGINT', stop)
      process.removeListener('SIGTERM', stop)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (code === 0 && !interrupted) accept()
      else reject(new Error(`native-build: command failed (${code ?? signal})`))
    })
  })
}
