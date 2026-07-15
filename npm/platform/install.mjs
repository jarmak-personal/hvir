import { spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
    rmSync(applicationDirectory, { force: true, recursive: true })
    renameSync(extractedApplication, applicationDirectory)
    if (!executableInstalled()) {
      throw new Error(`hvir executable is missing after extraction: ${executable}`)
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true })
  }
}

// npm retains the original package tarball in its cache. The installed copy is
// unnecessary after extraction and would otherwise double hvir's disk usage.
rmSync(archive, { force: true })
process.stdout.write(`Installed hvir for ${metadata.platform} ${metadata.arch}\n`)
