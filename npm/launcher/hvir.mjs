#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PLATFORM_PACKAGES = {
  'darwin-arm64': 'hvir-darwin-arm64',
  'linux-arm64': 'hvir-linux-arm64',
  'linux-x64': 'hvir-linux-x64',
}

const launcherDirectory = dirname(fileURLToPath(import.meta.url))
const installedPackagePath = resolve(launcherDirectory, '..', 'package.json')
const launcherPackagePath = existsSync(installedPackagePath)
  ? installedPackagePath
  : resolve(launcherDirectory, '..', '..', 'package.json')
const launcherPackage = JSON.parse(readFileSync(launcherPackagePath, 'utf8'))

function usage() {
  return `hvir ${launcherPackage.version}

Usage: hvir [project]

Launch hvir, optionally opening a local project folder. hvir remembers the last
workspace when no project is supplied.

Options:
  -h, --help     Show this help
  -v, --version  Show the installed version
`
}

function platformPackage() {
  const key = `${process.platform}-${process.arch}`
  const packageName = PLATFORM_PACKAGES[key]
  if (!packageName) {
    throw new Error(
      `hvir does not support ${process.platform} ${process.arch}. ` +
        'Supported platforms are Linux x64, Linux arm64, and macOS arm64.',
    )
  }
  return { key, packageName }
}

function applicationArguments(args) {
  if (args.length === 0 || args[0].startsWith('-')) return args
  return [`--project-root=${resolve(args[0])}`, ...args.slice(1)]
}

async function launch(args) {
  const { key, packageName } = platformPackage()
  const require = createRequire(import.meta.url)
  let metadataPath
  try {
    metadataPath = require.resolve(`${packageName}/platform.json`)
  } catch {
    throw new Error(
      `The ${packageName} payload is missing. Reinstall hvir with npm on this ` +
        `machine (npm install -g hvir). Platform: ${key}.`,
    )
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const executable = resolve(dirname(metadataPath), metadata.executable)
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error(
      `The hvir application payload was not installed at ${executable}. ` +
        'Reinstall without npm --ignore-scripts.',
    )
  }

  const smoke = Boolean(process.env.HVIR_SMOKE)
  const child = spawn(executable, applicationArguments(args), {
    cwd: process.cwd(),
    detached: !smoke,
    env: process.env,
    stdio: smoke ? 'inherit' : 'ignore',
  })
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('error', rejectSpawn)
    child.once('spawn', resolveSpawn)
  })
  if (!smoke) {
    child.unref()
    return
  }
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })
  if (exitCode !== 0) throw new Error(`packaged application exited ${exitCode}`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(usage())
    return
  }
  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${launcherPackage.version}\n`)
    return
  }
  await launch(args)
}

try {
  await main()
} catch (reason) {
  const message = reason instanceof Error ? reason.message : String(reason)
  process.stderr.write(`hvir: ${message}\n`)
  process.exitCode = 1
}
