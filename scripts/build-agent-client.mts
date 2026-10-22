import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

const exec = promisify(execFile)
const targets: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'macos-x64': 'x86_64-apple-darwin',
  'macos-arm64': 'aarch64-apple-darwin',
}
const selected = process.argv[2],
  target = selected && targets[selected]
if (!target) throw new Error('Select linux-x64, linux-arm64, macos-x64 or macos-arm64')
const development = process.argv.includes('--development'),
  root = resolve('packages/hvir-agent')
const source = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim()
if (
  !development &&
  (
    await exec('git', [
      'status',
      '--porcelain',
      '--',
      'packages/hvir-agent',
      'scripts/build-agent-client.mts',
      'LICENSE',
    ])
  ).stdout.trim()
)
  throw new Error('Exact-source client builds require clean maintained inputs')
await exec('rustup', ['target', 'add', '--toolchain', '1.99.0', target], { cwd: root })
const environment = { ...process.env, MACOSX_DEPLOYMENT_TARGET: '11.0' }
await exec('cargo', ['+1.99.0', 'fmt', '--check'], { cwd: root, env: environment })
await exec('cargo', ['+1.99.0', 'test', '--locked'], {
  cwd: root,
  env: environment,
  maxBuffer: 1024 * 1024,
})
await exec(
  'cargo',
  ['+1.99.0', 'clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
  { cwd: root, env: environment, maxBuffer: 1024 * 1024 },
)
const sysroot = (await exec('rustc', ['+1.99.0', '--print', 'sysroot'])).stdout.trim()
let rustFlags = ''
if (selected.startsWith('linux')) {
  const host = (await exec('rustc', ['+1.99.0', '-vV'])).stdout.match(
    /^host: (.+)$/m,
  )?.[1]
  if (!host) throw new Error('Pinned Rust host identity is unavailable')
  rustFlags = `-C linker=${join(sysroot, 'lib/rustlib', host, 'bin/rust-lld')} -C linker-flavor=ld.lld -C target-feature=+crt-static -C link-self-contained=yes`
}
await exec('cargo', ['+1.99.0', 'build', '--release', '--locked', '--target', target], {
  cwd: root,
  env: { ...environment, RUSTFLAGS: rustFlags },
  maxBuffer: 1024 * 1024,
})
const binary = join(
    process.env.CARGO_TARGET_DIR ?? join(root, 'target'),
    target,
    'release/hvir-agent',
  ),
  bytes = await readFile(binary)
if (bytes.length > 16 * 1024 * 1024)
  throw new Error('Client exceeds the shipped size bound')
const file = (await exec('file', ['-b', binary])).stdout
if (
  !file.includes(
    selected.endsWith('x64') ? 'x86' : selected.startsWith('linux') ? 'aarch64' : 'arm64',
  )
)
  throw new Error('Client CPU does not match target')
if (selected.startsWith('linux')) {
  const headers = (await exec('readelf', ['-l', '-d', binary])).stdout
  if (/INTERP|NEEDED/.test(headers))
    throw new Error('Linux client is not statically linked')
} else {
  const libraries = (await exec('otool', ['-L', binary])).stdout
    .trim()
    .split('\n')
    .slice(1)
  if (libraries.some((line) => !/^\s*\/(usr\/lib|System\/Library)\//.test(line)))
    throw new Error('macOS client depends on a non-system library')
  const load = (await exec('otool', ['-l', binary])).stdout
  if (!/minos 11\.0/.test(load))
    throw new Error('macOS client deployment target is not 11.0')
}
const directory = resolve('out/agent-clients', selected)
await mkdir(directory, { recursive: true })
await copyFile(binary, join(directory, 'hvir-agent'))
// Preserve the exact pinned toolchain and resolved crate notices with each distributable.
const notices = join(directory, 'notices')
await mkdir(notices, { recursive: true })
await copyFile(resolve('LICENSE'), join(notices, 'hvir-LICENSE'))
await copyFile(join(root, 'MUSL-COPYRIGHT'), join(notices, 'musl-1.2.5-COPYRIGHT'))
await copyFile(
  join(sysroot, 'share/doc/rust/COPYRIGHT-library.html'),
  join(notices, 'rust-1.99.0-COPYRIGHT-library.html'),
)
const metadata = JSON.parse(
  (
    await exec('cargo', ['+1.99.0', 'metadata', '--locked', '--format-version', '1'], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout,
) as { packages: { name: string; version: string; manifest_path: string }[] }
for (const dependency of metadata.packages) {
  const sourceDirectory = resolve(dependency.manifest_path, '..')
  for (const file of await readdir(sourceDirectory)) {
    if (!/^(LICENSE|COPYRIGHT)([.-]|$)/.test(file)) continue
    await copyFile(
      join(sourceDirectory, file),
      join(notices, `${dependency.name}-${dependency.version}-${file}`),
    )
  }
}
await writeFile(
  join(directory, 'metadata.json'),
  JSON.stringify(
    {
      contract: '1.0',
      source,
      development,
      target: selected,
      rustTarget: target,
      toolchain: '1.99.0',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `HVIR_AGENT_CLIENT_BUILD_OK ${selected} source=${source} development=${development}`,
)
