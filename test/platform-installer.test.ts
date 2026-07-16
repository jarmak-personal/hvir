import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe('npm platform installer', () => {
  it('preserves an existing app when an extracted payload has no app directory', () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.payload, 'wrong'), { recursive: true })
    writeFileSync(join(fixture.payload, 'wrong', 'payload.txt'), 'incomplete')
    createArchive(fixture)

    const installed = spawnSync(process.execPath, ['install.mjs'], {
      cwd: fixture.packageDirectory,
      encoding: 'utf8',
    })

    expect(installed.status).not.toBe(0)
    expect(readFileSync(join(fixture.packageDirectory, 'app', 'keep.txt'), 'utf8')).toBe(
      'known good',
    )
    expect(existsSync(join(fixture.packageDirectory, 'payload.tar.gz'))).toBe(true)
  })

  it('atomically replaces a stale app after validating its executable', () => {
    const fixture = createFixture()
    const executable = join(fixture.payload, 'app', 'bin', 'hvir')
    mkdirSync(join(fixture.payload, 'app', 'bin'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    chmodSync(executable, 0o755)
    createArchive(fixture)

    const installed = spawnSync(process.execPath, ['install.mjs'], {
      cwd: fixture.packageDirectory,
      encoding: 'utf8',
    })

    expect(installed.status, installed.stderr).toBe(0)
    expect(existsSync(join(fixture.packageDirectory, 'app', 'keep.txt'))).toBe(false)
    expect(existsSync(join(fixture.packageDirectory, 'app', 'bin', 'hvir'))).toBe(true)
    expect(existsSync(join(fixture.packageDirectory, 'payload.tar.gz'))).toBe(false)
  })
})

function createFixture(): {
  readonly packageDirectory: string
  readonly payload: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'hvir-installer-test-'))
  temporaryDirectories.push(directory)
  const packageDirectory = join(directory, 'package')
  const payload = join(directory, 'payload')
  mkdirSync(join(packageDirectory, 'app'), { recursive: true })
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(packageDirectory, 'app', 'keep.txt'), 'known good')
  writeFileSync(
    join(packageDirectory, 'platform.json'),
    JSON.stringify({ platform: 'test', arch: 'test', executable: 'app/bin/hvir' }),
  )
  copyFileSync(
    resolve(import.meta.dirname, '..', 'npm', 'platform', 'install.mjs'),
    join(packageDirectory, 'install.mjs'),
  )
  return { packageDirectory, payload }
}

function createArchive(fixture: {
  readonly packageDirectory: string
  readonly payload: string
}): void {
  const archived = spawnSync(
    'tar',
    [
      '-czf',
      join(fixture.packageDirectory, 'payload.tar.gz'),
      '-C',
      fixture.payload,
      '.',
    ],
    { encoding: 'utf8' },
  )
  if (archived.status !== 0) throw new Error(archived.stderr)
}
