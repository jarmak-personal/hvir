import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const source = fileURLToPath(new URL('..', import.meta.url))
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-setup-cli-')))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await cp(
    join(source, 'scripts/native-terminal'),
    join(root, 'scripts/native-terminal'),
    { recursive: true },
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await cp(join(source, 'src/shared'), join(root, 'src/shared'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function cli(script: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) {
  return execute(process.execPath, [`scripts/native-terminal/${script}.mts`, ...args], {
    cwd: root,
    env: { ...process.env, CI: 'false', ...extra },
    timeout: 10000,
  })
}
it('CI dependency installation leaves native preparation to its dedicated owner', async () => {
  const output = await cli('prepare-development', ['--install'], { CI: 'true' })
  expect(output.stdout).toContain('dedicated native jobs')
  await expect(
    readFile(join(root, 'packages/native-terminal/build/development/runtime.json')),
  ).rejects.toThrow()
})
it('refuses an existing setup lock without changing its owner or receipt', async () => {
  const lock = join(root, 'packages/native-terminal/build/development/prepare.lock')
  await mkdir(lock, { recursive: true })
  await writeFile(join(lock, 'owner.json'), '{"pid":123}')
  await expect(cli('prepare-development')).rejects.toThrow(
    'already running or was interrupted',
  )
  expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe('{"pid":123}')
})
it('a failed native build cannot publish readiness and releases the setup lock', async () => {
  await mkdir(join(root, 'packages/native-terminal'), { recursive: true })
  const pin = JSON.parse(
    await readFile(join(root, 'scripts/native-terminal/bindings-pin.json'), 'utf8'),
  ) as { electron: { version: string } }
  await mkdir(join(root, 'node_modules/electron'), { recursive: true })
  await writeFile(
    join(root, 'node_modules/electron/package.json'),
    JSON.stringify({ version: pin.electron.version }),
  )
  await mkdir(join(root, 'bin'))
  for (const tool of ['cc', 'pkg-config', 'xcodebuild', 'xcrun']) {
    await writeFile(join(root, 'bin', tool), '#!/bin/sh\necho fixture-prerequisite\n', {
      mode: 0o755,
    })
  }
  await writeFile(
    join(root, 'scripts/native-terminal/build.mts'),
    "console.error('FIXTURE_BUILD_FAILED'); process.exitCode = 1;\n",
  )
  await expect(
    cli('prepare-development', [], {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
    }),
  ).rejects.toThrow('FIXTURE_BUILD_FAILED')
  const base = join(root, 'packages/native-terminal/build/development')
  await expect(readFile(join(base, 'runtime.json'))).rejects.toThrow()
  await expect(readFile(join(base, 'prepare.lock/owner.json'))).rejects.toThrow()
})
it.each([false, true])(
  'preserves explicit override and removes it for legacy=%s without starting Electron',
  async (legacy) => {
    const directory = join(root, 'node_modules/electron-vite')
    await mkdir(join(directory, 'bin'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './package.json': './package.json' } }),
    )
    await writeFile(
      join(directory, 'bin/electron-vite.js'),
      'console.log(JSON.stringify({library:process.env.HVIR_NATIVE_TERMINAL_LIBRARY??null,args:process.argv.slice(2)}));\n',
    )
    const output = await cli(
      'dev',
      [...(legacy ? ['--legacy'] : []), '--', '--user-data-dir=/fixture/profile'],
      { HVIR_NATIVE_TERMINAL_LIBRARY: '/trusted/manual/library' },
    )
    const result = JSON.parse(output.stdout.trim()) as {
      library: string | null
      args: string[]
    }
    expect(result.library).toBe(legacy ? null : '/trusted/manual/library')
    for (const arg of ['dev', '--', '--user-data-dir=/fixture/profile'])
      expect(result.args).toContain(arg)
  },
)

it('unsupported installation can still prepare the web dependencies, while explicit native setup fails', async () => {
  const path = join(root, 'scripts/native-terminal/pin.json')
  const pin = JSON.parse(await readFile(path, 'utf8')) as {
    targets: Record<string, unknown>
  }
  pin.targets = {}
  await writeFile(path, JSON.stringify(pin))
  expect((await cli('prepare-development', ['--install'])).stdout).toContain(
    'web development remains available',
  )
  await expect(cli('prepare-development')).rejects.toThrow('unsupported target')
})

it('reuses the readiness owner result without invoking a compiler and prunes superseded attempts', async () => {
  const base = 'packages/native-terminal/build/development'
  await mkdir(join(root, base, 'attempt-current/artifact'), { recursive: true })
  await mkdir(join(root, base, 'attempt-old/failed-compiler-cache'), { recursive: true })
  await writeFile(
    join(root, 'scripts/native-terminal/development-runtime.mts'),
    `
    export const developmentRoot = ${JSON.stringify(base)};
    export const developmentReceipt = developmentRoot + '/runtime.json';
    export const developmentTarget = () => 'linux-x64';
    export const developmentInputIdentity = () => { throw new Error('COMPILER_MUST_NOT_RUN'); };
    export const readDevelopmentRuntime = async () => ({library:'validated-library',receipt:{artifact:developmentRoot+'/attempt-current/artifact'}});
  `,
  )
  expect((await cli('prepare-development')).stdout).toContain(
    'ready (reused): validated-library',
  )
  await expect(
    stat(join(root, base, 'attempt-old/failed-compiler-cache')),
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, base, 'attempt-current/artifact'))).resolves.toBeDefined()
})

it('validates the pending receipt before publishing readiness', async () => {
  await mkdir(join(root, 'bin'))
  for (const tool of ['cc', 'pkg-config', 'xcodebuild', 'xcrun']) {
    await writeFile(join(root, 'bin', tool), '#!/bin/sh\necho fixture-prerequisite\n', {
      mode: 0o755,
    })
  }
  await writeFile(
    join(root, 'scripts/native-terminal/development-runtime.mts'),
    `
    import { access, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export const developmentRoot = 'packages/native-terminal/build/development';
    export const developmentReceipt = developmentRoot + '/runtime.json';
    export const developmentTarget = () => 'linux-x64';
    export const developmentInputIdentity = async () => 'stable-native-inputs';
    export async function readDevelopmentRuntime(root, target, verifier, selected) {
      if (!selected) throw new Error('no previous readiness');
      try { await access(join(root, developmentReceipt)); throw new Error('READINESS_PUBLISHED_TOO_EARLY'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const receipt = JSON.parse(await readFile(join(root, selected), 'utf8'));
      if (receipt.inputSha256 !== 'stable-native-inputs') throw new Error('wrong input identity');
      return { library:'validated-library', receipt };
    }
  `,
  )
  await writeFile(
    join(root, 'scripts/native-terminal/build.mts'),
    `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const artifact = join(process.argv[3], 'artifact');
    await mkdir(artifact, { recursive:true });
    await writeFile(join(artifact, 'manifest.json'), '{}');
  `,
  )
  await writeFile(
    join(root, 'scripts/native-terminal/bindings.mts'),
    `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    await mkdir(process.argv[4], {recursive:true});
    const output = join(process.cwd(), 'packages/native-terminal/build/Release');
    await mkdir(output, {recursive:true});
    await writeFile(join(output, 'bindings.json'), '{}');
  `,
  )
  const output = await cli('prepare-development', [], {
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
  })
  expect(output.stdout).toContain('ready: validated-library')
  const receipt: unknown = JSON.parse(
    await readFile(
      join(root, 'packages/native-terminal/build/development/runtime.json'),
      'utf8',
    ),
  )
  expect(receipt).toMatchObject({
    target: 'linux-x64',
    inputSha256: 'stable-native-inputs',
  })
})
