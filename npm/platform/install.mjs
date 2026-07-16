import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(fileURLToPath(import.meta.url))
const metadata = JSON.parse(readFileSync(join(packageDirectory, 'platform.json'), 'utf8'))
const executable = resolve(packageDirectory, metadata.executable)
const applicationDirectory = join(packageDirectory, 'app')
const archive = join(packageDirectory, 'payload.tar.gz')

function executableInstalled() {
  try {
    accessSync(executable, constants.X_OK)
    return true
  } catch {
    return false
  }
}

if (!executableInstalled()) {
  if (!existsSync(archive)) throw new Error('hvir platform payload archive is missing')
  const temporaryDirectory = mkdtempSync(join(packageDirectory, '.install-'))
  try {
    const extraction = spawnSync('tar', ['-xzf', archive, '-C', temporaryDirectory], {
      encoding: 'utf8',
    })
    if (extraction.status !== 0) {
      throw new Error(
        `could not extract hvir: ${extraction.stderr || `tar exited ${extraction.status}`}`,
      )
    }
    const extractedApplication = join(temporaryDirectory, 'app')
    const extractedExecutable = resolve(temporaryDirectory, metadata.executable)
    if (
      !existsSync(extractedApplication) ||
      !statSync(extractedApplication).isDirectory()
    ) {
      throw new Error('hvir platform payload does not contain an app directory')
    }
    try {
      accessSync(extractedExecutable, constants.X_OK)
    } catch {
      throw new Error(
        `hvir platform payload is missing its executable: ${extractedExecutable}`,
      )
    }

    // Keep a known-good installation until the validated replacement is in
    // place. Both paths are below the package directory, so these renames are
    // atomic on the same filesystem.
    const previousApplication = join(temporaryDirectory, 'previous-app')
    const hadPreviousApplication = existsSync(applicationDirectory)
    if (hadPreviousApplication) renameSync(applicationDirectory, previousApplication)
    try {
      renameSync(extractedApplication, applicationDirectory)
      if (!executableInstalled()) {
        throw new Error(`hvir executable is missing after extraction: ${executable}`)
      }
    } catch (reason) {
      rmSync(applicationDirectory, { force: true, recursive: true })
      if (hadPreviousApplication) {
        renameSync(previousApplication, applicationDirectory)
      }
      throw reason
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

// npm retains the original package tarball in its cache. The installed copy is
// unnecessary after extraction and would otherwise double hvir's disk usage.
rmSync(archive, { force: true })
process.stdout.write(`Installed hvir for ${metadata.platform} ${metadata.arch}\n`)
