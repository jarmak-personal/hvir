import { spawn, spawnSync } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  nativePayloadCacheRoot,
  prepareNativePayload,
  sha256File,
  type NativePayloadMetadata,
} from '../npm/native-payload.mjs'

const temporaryDirectories: string[] = []
const packageName = 'hvir-test-x64'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('native payload preparation', () => {
  it('uses the platform user cache instead of the npm prefix', () => {
    expect(nativePayloadCacheRoot({ platform: 'darwin', home: '/Users/tester' })).toBe(
      '/Users/tester/Library/Caches/hvir/native',
    )
    expect(
      nativePayloadCacheRoot({
        platform: 'linux',
        environment: { XDG_CACHE_HOME: '/var/cache/tester' },
        home: '/home/tester',
      }),
    ).toBe('/var/cache/tester/hvir/native')
    expect(
      nativePayloadCacheRoot({
        platform: 'linux',
        environment: { XDG_CACHE_HOME: 'relative-cache' },
        home: '/home/tester',
      }),
    ).toBe('/home/tester/.cache/hvir/native')
  })

  it('prepares once outside a read-only platform package', async () => {
    const fixture = await createFixture('1.2.3')
    const reports: string[] = []
    await chmod(fixture.packageDirectory, 0o555)
    try {
      const executable = await prepare(fixture, reports)
      expect(executable).toBe(
        join(fixture.cacheRoot, packageName, fixture.version, 'app', 'bin', 'hvir'),
      )
      expect((await stat(executable)).mode & 0o111).not.toBe(0)
      expect(await readdir(fixture.packageDirectory)).toEqual([
        'payload.tar.gz',
        'platform.json',
      ])
      expect(reports).toEqual([
        'Preparing hvir 1.2.3 for test x64...',
        'Prepared hvir 1.2.3.',
      ])

      await prepare(fixture, reports)
      expect(reports).toHaveLength(2)
    } finally {
      await chmod(fixture.packageDirectory, 0o755)
    }
  })

  it('ignores a legacy install-time app while updating into the user cache', async () => {
    const fixture = await createFixture('1.3.0')
    const legacyApplication = join(fixture.packageDirectory, 'app')
    await mkdir(legacyApplication)
    await writeFile(join(legacyApplication, 'legacy'), 'old postinstall payload')

    const executable = await prepare(fixture)

    expect(executable).toContain('/1.3.0/app/bin/hvir')
    await expect(readFile(join(legacyApplication, 'legacy'), 'utf8')).resolves.toBe(
      'old postinstall payload',
    )
  })

  it('coordinates concurrent preparation and publishes one complete payload', async () => {
    const fixture = await createFixture('2.0.0')
    const reports: string[] = []
    const [first, second] = await Promise.all([
      prepare(fixture, reports),
      prepare(fixture, reports),
    ])

    expect(first).toBe(second)
    expect(
      reports.filter((message) => message.startsWith('Preparing hvir')),
    ).toHaveLength(1)
    expect(await readdir(join(fixture.cacheRoot, packageName))).toEqual(['2.0.0'])
  })

  it('coordinates simultaneous preparation across launcher processes', async () => {
    const fixture = await createFixture('2.1.0')
    const runner = join(await createCacheRoot(), 'runner.mjs')
    const configuration = join(await createCacheRoot(), 'configuration.json')
    const barrier = join(await createCacheRoot(), 'start')
    const firstReady = join(await createCacheRoot(), 'first-ready')
    const secondReady = join(await createCacheRoot(), 'second-ready')
    const moduleUrl = pathToFileURL(
      resolve(import.meta.dirname, '..', 'npm', 'native-payload.mjs'),
    ).href
    await writeFile(
      runner,
      `
        import { access, readFile, writeFile } from 'node:fs/promises'
        import { setTimeout as delay } from 'node:timers/promises'
        import { prepareNativePayload } from ${JSON.stringify(moduleUrl)}

        const [configurationPath, readyPath, barrierPath] = process.argv.slice(2)
        const options = JSON.parse(await readFile(configurationPath, 'utf8'))
        await writeFile(readyPath, '')
        while (true) {
          try { await access(barrierPath); break } catch { await delay(10) }
        }
        const executable = await prepareNativePayload({
          ...options,
          report: (message) => process.stderr.write(message + '\\n'),
        })
        process.stdout.write(executable + '\\n')
      `,
    )
    await writeFile(configuration, JSON.stringify(preparationOptions(fixture)))

    const first = runPreparationProcess(runner, configuration, firstReady, barrier)
    const second = runPreparationProcess(runner, configuration, secondReady, barrier)
    await Promise.all([waitForPath(firstReady), waitForPath(secondReady)])
    await writeFile(barrier, '')
    const results = await Promise.all([first, second])

    expect(results[0].stdout).toBe(results[1].stdout)
    expect(
      results
        .flatMap((result) => result.stderr.split('\n'))
        .filter((message) => message.startsWith('Preparing hvir')),
    ).toHaveLength(1)
  })

  it('recovers a dead owner and removes interrupted staging before retrying', async () => {
    const fixture = await createFixture('3.0.0')
    const versionsRoot = join(fixture.cacheRoot, packageName)
    const lock = join(versionsRoot, '.prepare.lock')
    const abandoned = join(versionsRoot, '.prepare-interrupted')
    await mkdir(lock, { recursive: true })
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now(), token: 'dead' }),
    )
    await mkdir(abandoned)
    await writeFile(join(abandoned, 'partial'), 'partial')

    await expect(prepare(fixture)).resolves.toContain('/3.0.0/app/bin/hvir')
    expect(await readdir(versionsRoot)).toEqual(['3.0.0'])
  })

  it('keeps the prior completed version when a newer archive is invalid', async () => {
    const cacheRoot = await createCacheRoot()
    const first = await createFixture('4.0.0', { cacheRoot })
    const broken = await createFixture('4.1.0', { cacheRoot, includeApplication: false })
    const replacement = await createFixture('4.1.0', { cacheRoot })
    const firstExecutable = await prepare(first)

    await expect(prepare(broken)).rejects.toThrow(
      'the hvir-test-x64 archive does not contain an app directory',
    )
    await expect(readFile(firstExecutable, 'utf8')).resolves.toContain('exit 0')
    expect(await readdir(join(cacheRoot, packageName))).toEqual(['4.0.0'])

    await expect(prepare(replacement)).resolves.toContain('/4.1.0/app/bin/hvir')
  })

  it('retains only the current and immediately previous completed versions', async () => {
    const cacheRoot = await createCacheRoot()
    const first = await createFixture('5.0.0', { cacheRoot })
    const second = await createFixture('5.1.0', { cacheRoot })
    const third = await createFixture('5.2.0', { cacheRoot })
    await prepare(first)
    await prepare(second)
    const versionsRoot = join(cacheRoot, packageName)
    const now = new Date()
    await utimes(
      join(versionsRoot, '5.0.0'),
      new Date(now.getTime() - 10_000),
      new Date(now.getTime() - 10_000),
    )
    await utimes(join(versionsRoot, '5.1.0'), now, now)

    await prepare(third)

    expect((await readdir(versionsRoot)).sort()).toEqual(['5.1.0', '5.2.0'])
  })

  it('rejects checksum drift without publishing a version directory', async () => {
    const fixture = await createFixture('6.0.0')
    const changedMetadata = {
      ...fixture.metadata,
      archiveSha256: '0'.repeat(64),
    }

    await expect(
      prepareNativePayload({
        ...preparationOptions(fixture),
        metadata: changedMetadata,
      }),
    ).rejects.toThrow('archive checksum')
    expect(await readdir(join(fixture.cacheRoot, packageName))).toEqual([])
  })

  it('rejects an executable path outside the prepared app', async () => {
    const fixture = await createFixture('7.0.0')
    await expect(
      prepareNativePayload({
        ...preparationOptions(fixture),
        metadata: { ...fixture.metadata, executable: 'app/../../outside' },
      }),
    ).rejects.toThrow('outside its prepared root')
  })
})

interface Fixture {
  readonly packageDirectory: string
  readonly cacheRoot: string
  readonly version: string
  readonly metadata: NativePayloadMetadata
}

async function createFixture(
  version: string,
  options: { readonly cacheRoot?: string; readonly includeApplication?: boolean } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-native-payload-test-'))
  temporaryDirectories.push(root)
  const packageDirectory = join(root, 'package')
  const archiveRoot = join(root, 'archive')
  const includeApplication = options.includeApplication ?? true
  await mkdir(packageDirectory, { recursive: true })
  if (includeApplication) {
    const executable = join(archiveRoot, 'app', 'bin', 'hvir')
    await mkdir(join(archiveRoot, 'app', 'bin'), { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
  } else {
    await mkdir(join(archiveRoot, 'wrong'), { recursive: true })
    await writeFile(join(archiveRoot, 'wrong', 'partial'), 'partial')
  }
  const archive = join(packageDirectory, 'payload.tar.gz')
  const archived = spawnSync('tar', ['-czf', archive, '-C', archiveRoot, '.'], {
    encoding: 'utf8',
  })
  if (archived.status !== 0) throw new Error(archived.stderr)
  const metadata = {
    platform: 'test',
    arch: 'x64',
    executable: 'app/bin/hvir',
    archiveSha256: await sha256File(archive),
  }
  await writeFile(join(packageDirectory, 'platform.json'), JSON.stringify(metadata))
  return {
    packageDirectory,
    cacheRoot: options.cacheRoot ?? (await createCacheRoot()),
    version,
    metadata,
  }
}

async function createCacheRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-native-cache-test-'))
  temporaryDirectories.push(root)
  return root
}

function preparationOptions(fixture: Fixture): {
  readonly packageDirectory: string
  readonly packageName: string
  readonly packageVersion: string
  readonly metadata: NativePayloadMetadata
  readonly cacheRoot: string
  readonly report: (message: string) => void
} {
  return {
    packageDirectory: fixture.packageDirectory,
    packageName,
    packageVersion: fixture.version,
    metadata: fixture.metadata,
    cacheRoot: fixture.cacheRoot,
    report: () => undefined,
  }
}

function prepare(fixture: Fixture, reports: string[] = []): Promise<string> {
  return prepareNativePayload({
    ...preparationOptions(fixture),
    report: (message) => reports.push(message),
  })
}

async function runPreparationProcess(
  runner: string,
  configuration: string,
  ready: string,
  barrier: string,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, [runner, configuration, ready, barrier], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  if (exitCode !== 0) throw new Error(`preparation process exited ${exitCode}: ${stderr}`)
  return { stdout, stderr }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}
