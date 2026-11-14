import { cp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digest, pin, repository, verifyArtifact } from './artifacts.mts'
import { archive, execute, extract } from './source.mts'
import { inspectBinary } from './binary.mts'

const [target, artifactArgument, workArgument, ...flags] = process.argv.slice(2)
const selected = target && pin.targets[target]
const allowDevelopment = flags.length === 1 && flags[0] === '--development'
if (
  !selected ||
  !artifactArgument ||
  !workArgument ||
  (flags.length > 0 && !allowDevelopment)
)
  throw new Error(
    'Usage: native:bindings -- TARGET ARTIFACT_DIR NEW_WORK [--development]',
  )
if (selected.platform !== process.platform || selected.arch !== process.arch)
  throw new Error('native-bindings: matching native host required')
const producer = await realpath(resolve(artifactArgument))
const manifest = await verifyArtifact(producer, target, allowDevelopment)
const producerManifestSha = await digest(join(producer, 'manifest.json'))
const head = (
  await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })
).stdout.trim()
const dirty = Boolean(
  (
    await execute('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repository,
    })
  ).stdout.trim(),
)
if (dirty && !allowDevelopment)
  throw new Error('native-bindings: dirty source requires --development')
const packageRoot = join(repository, 'packages/native-terminal')
const bindingPinPath = join(repository, 'scripts/native-terminal/bindings-pin.json')
const bindingPin = JSON.parse(await readFile(bindingPinPath, 'utf8')) as {
  schema: number
  napiVersion: number
  electron: { version: string; url: string; sha256: string }
}
if (
  bindingPin.schema !== 1 ||
  bindingPin.napiVersion !== 8 ||
  !/^[a-f0-9]{64}$/.test(bindingPin.electron.sha256)
)
  throw new Error('native-bindings: invalid header pin')

// Fresh owned staging and authenticated headers; never modify the accepted producer.
const work = resolve(workArgument)
await mkdir(work)
const headerArchive = join(work, 'electron-headers.tar.gz')
await archive(bindingPin.electron.url, bindingPin.electron.sha256, headerArchive)
const headers = join(work, 'headers')
await extract(headerArchive, headers)
const nodeIncludes = join(headers, 'include/node')
const stage = join(work, 'compiled')
await mkdir(stage)
const native = join(work, 'inputs')
await mkdir(native)
const platformFile =
  process.platform === 'darwin' ? 'resource_macos.c' : 'resource_linux.c'
const sources = [
  ...[
    'host_binding.c',
    'terminal.c',
    'terminal_input.c',
    'terminal_internal.h',
    'linux_display.c',
    'linux_display.h',
    'terminal.h',
    'hvir_ghostty_embed.h',
    'resource_binding.c',
    'resource_edge.h',
    platformFile,
    'resource_probe.c',
  ].map((file) => ({
    file,
    source: join(packageRoot, file),
    path: `packages/native-terminal/${file}`,
  })),
  ...['bindings.mts', 'bindings-pin.json'].map((file) => ({
    file,
    source: join(repository, 'scripts/native-terminal', file),
    path: `scripts/native-terminal/${file}`,
  })),
  { file: 'ghostty.h', source: join(producer, 'ghostty.h'), path: 'producer/ghostty.h' },
]
const inputs = []
for (const source of sources) {
  const snapshot = join(native, source.file)
  await cp(source.source, snapshot)
  inputs.push({ path: source.path, sha256: await digest(snapshot) })
}
if (
  (await digest(join(native, 'hvir_ghostty_embed.h'))) !==
  (await digest(join(producer, 'hvir_ghostty_embed.h')))
)
  throw new Error('native-bindings: producer hook header mismatch')
const common = [
  '-std=c11',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-fPIC',
  '-pthread',
  ...(process.platform === 'darwin' ? ['-mmacosx-version-min=13.0'] : []),
]
const addon = [
  ...common,
  process.platform === 'darwin' ? '-bundle' : '-shared',
  '-DNAPI_VERSION=8',
  '-I',
  nodeIncludes,
  '-I',
  native,
  ...(process.platform === 'darwin' ? ['-undefined', 'dynamic_lookup'] : []),
]
const resourceLibraries =
  process.platform === 'darwin'
    ? ['-framework', 'IOSurface', '-framework', 'CoreFoundation', '-lbsm']
    : []
const commands = [
  {
    file: 'native_terminal_engine.node',
    arguments: [
      ...addon,
      '-DNODE_GYP_MODULE_NAME=native_terminal_engine',
      join(native, 'host_binding.c'),
      join(native, 'terminal.c'),
      join(native, 'terminal_input.c'),
      join(native, 'linux_display.c'),
      ...(process.platform === 'darwin'
        ? ['-framework', 'CoreFoundation', '-framework', 'IOSurface']
        : ['-ldl']),
    ],
  },
  {
    file: 'native_terminal_resource.node',
    arguments: [
      ...addon,
      '-DNODE_GYP_MODULE_NAME=native_terminal_resource',
      join(native, 'resource_binding.c'),
      join(native, platformFile),
      ...resourceLibraries,
    ],
  },
  {
    file: 'resource-probe',
    arguments: [
      ...common,
      '-I',
      native,
      join(native, 'resource_probe.c'),
      join(native, platformFile),
      ...resourceLibraries,
    ],
  },
].map((command) => ({
  ...command,
  arguments: [...command.arguments, '-o', join(stage, command.file)],
}))
const compiler = (
  await execute('cc', ['--version'], { maxBuffer: 16 * 1024 })
).stdout.trim()
for (const command of commands)
  await execute('cc', command.arguments, {
    cwd: repository,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
// The manifest and every producer byte must still agree after compilation.
await verifyArtifact(producer, target, allowDevelopment)
if (
  (await digest(join(producer, 'manifest.json'))) !== producerManifestSha ||
  (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim() !==
    head
)
  throw new Error('native-bindings: build identity changed')
const dirtyAfter = Boolean(
  (
    await execute('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repository,
    })
  ).stdout.trim(),
)
if (dirtyAfter && !allowDevelopment)
  throw new Error('native-bindings: dirty source requires --development')
const outputs = await Promise.all(
  commands.map(async ({ file }) => ({
    file,
    sha256: await digest(join(stage, file)),
    bytes: (await stat(join(stage, file))).size,
    dependencies: await inspectBinary(
      join(stage, file),
      selected.platform,
      selected.arch,
    ),
  })),
)
const provenance = {
  schema: 1,
  source: head,
  target,
  development:
    allowDevelopment || dirty || dirtyAfter || manifest.build.development === true,
  inputs: { dirty: dirty || dirtyAfter, allowDevelopment, sourceFiles: inputs },
  headers: {
    ...bindingPin,
    pinSha256: await digest(join(native, 'bindings-pin.json')),
    archiveSha256: await digest(headerArchive),
  },
  producer: {
    source: manifest.source,
    target: manifest.target,
    pinSha256: manifest.pinSha256,
    embedAbi: manifest.embedAbi,
    development: manifest.build.development,
    manifestSha256: producerManifestSha,
  },
  compiler: {
    command: 'cc',
    identity: compiler,
    platform: process.platform,
    arch: process.arch,
    developerDir: process.env.DEVELOPER_DIR ?? null,
    sdkRoot: process.env.SDKROOT ?? null,
    commands,
  },
  outputs,
}
await writeFile(
  join(stage, 'bindings.json'),
  JSON.stringify(provenance, null, 2) + '\n',
  { flag: 'wx' },
)
const output = join(packageRoot, 'build/Release')
await mkdir(output, { recursive: true })
for (const { file } of commands) await cp(join(stage, file), join(output, file))
// Publish the receipt last; consumers must verify its hashes before loading.
await cp(join(stage, 'bindings.json'), join(output, 'bindings.json'))
console.log(`HVIR_NATIVE_BINDINGS_OK ${target} ${output}`)
