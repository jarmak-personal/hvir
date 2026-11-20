import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { digest, repository } from './artifacts.mts'
import { execute } from './source.mts'
import {
  developmentInputIdentity,
  developmentReceipt,
  developmentRoot,
  developmentTarget,
  readDevelopmentRuntime,
  type DevelopmentRuntimeReceipt,
} from './development-runtime.mts'
import { runDevelopmentProcess } from './development-process.mts'

async function prepare(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 1 || args[0] !== '--install'))
    throw new Error('Usage: native:prepare [--install]')
  // Dedicated CI native jobs already own compilation and qualification. This only avoids
  // duplicating that compiler workload in unrelated lint/test/release dependency installs.
  if (args[0] === '--install' && process.env.CI === 'true') {
    console.log(
      'Native development setup: CI install; dedicated native jobs prepare their own artifacts.',
    )
    return
  }
  let target: string
  try {
    target = developmentTarget()
  } catch (error) {
    if (args[0] !== '--install') throw error
    console.log(
      'Native development setup: unsupported host; web development remains available through npm run dev:legacy.',
    )
    return
  }
  const base = join(repository, developmentRoot)
  await mkdir(base, { recursive: true })
  const lock = join(base, 'prepare.lock')
  try {
    await mkdir(lock)
  } catch (cause) {
    throw new Error(
      'Native setup is already running or was interrupted. Stop any prior setup before removing packages/native-terminal/build/development/prepare.lock and running npm run native:prepare.',
      { cause },
    )
  }
  async function pruneAttempts(selected: string): Promise<void> {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith('attempt-') &&
        entry.name !== selected
      )
        await rm(join(base, entry.name), { recursive: true })
    }
  }
  let interrupted = false
  const interrupt = () => {
    interrupted = true
  }
  const active = () => {
    if (interrupted)
      throw new Error('Native setup interrupted; run npm run native:prepare again.')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  process.on('SIGHUP', interrupt)
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid }) + '\n',
      { flag: 'wx' },
    )
    try {
      const ready = await readDevelopmentRuntime(repository, target)
      active()
      await pruneAttempts(basename(ready.receipt.artifact.slice(0, -'/artifact'.length)))
      active()
      console.log(`Native development runtime ready (reused): ${ready.library}`)
      return
    } catch {
      /* Missing, stale, or corrupt artifacts are rebuilt below. */
    }
    active()
    console.log(
      'Preparing native Ghostty locally. The first install downloads pinned public inputs and compiles the renderer; allow several minutes and several GiB of temporary disk space. No account/token is required.',
    )
    try {
      await execute('cc', ['--version'])
      if (process.platform === 'linux')
        await execute('pkg-config', ['--modversion', 'egl'])
      else {
        await execute('xcodebuild', ['-version'])
        await execute('xcrun', ['metal', '--version'])
      }
    } catch (cause) {
      throw new Error(
        'Native build prerequisites missing. Ubuntu: sudo apt-get install build-essential python3 pkg-config libegl-dev libgl1-mesa-dri binutils file curl xz-utils patch. macOS: select full Xcode with its Metal toolchain (DEVELOPER_DIR may select it). See docs/native-terminal-development.md.',
        { cause },
      )
    }
    active()
    const identity = await developmentInputIdentity(repository, target)
    active()
    const attempt = await mkdtemp(join(base, 'attempt-'))
    const native = join(attempt, 'native')
    await runDevelopmentProcess(
      ['scripts/native-terminal/build.mts', target, native],
      repository,
    )
    active()
    await rename(join(native, 'artifact'), join(attempt, 'artifact'))
    // Complete outputs retain provenance; successful temporary compiler/source caches need
    // not accumulate across npm ci runs. Failed attempts remain available for diagnosis.
    await rm(native, { recursive: true })
    active()
    const artifact = join(attempt, 'artifact')
    await runDevelopmentProcess(
      [
        'scripts/native-terminal/bindings.mts',
        target,
        artifact,
        join(attempt, 'bindings'),
        '--development',
      ],
      repository,
    )
    active()
    if ((await developmentInputIdentity(repository, target)) !== identity)
      throw new Error(
        'Native source changed during preparation. Run npm run native:prepare again.',
      )
    const receipt: DevelopmentRuntimeReceipt = {
      schema: 1,
      target,
      inputSha256: identity,
      artifact: relative(repository, artifact),
      manifestSha256: await digest(join(artifact, 'manifest.json')),
      bindingsSha256: await digest(
        join(repository, 'packages/native-terminal/build/Release/bindings.json'),
      ),
    }
    const pending = join(attempt, 'runtime.json')
    await writeFile(pending, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    const ready = await readDevelopmentRuntime(
      repository,
      target,
      undefined,
      relative(repository, pending),
    )
    active()
    await rename(pending, join(repository, developmentReceipt))
    await rm(join(attempt, 'bindings'), { recursive: true })
    // This lock serializes setup. Retain the newly validated artifact only; failed
    // attempts remain diagnostic until the next successful preparation.
    await pruneAttempts(basename(attempt))
    console.log(`Native development runtime ready: ${ready.library}`)
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    process.off('SIGHUP', interrupt)
    await rm(lock, { recursive: true })
  }
}
prepare().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
