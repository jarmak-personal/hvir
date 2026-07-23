#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { renderNativeInstaller } from './render-native-installer.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const noticesSource = resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md')
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const sourceCommitPattern = /^[0-9a-f]{40}$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const teamPattern = /^[A-Z0-9]{10}$/

export async function assembleNativeRelease(options) {
  validateOptions(options)
  const version = options.version
  const tag = `v${version}`
  const assetDirectory = resolve(options.assetDirectory)
  const expectedArtifacts = [
    {
      platform: 'linux',
      architecture: 'x64',
      name: `hvir-${version}-linux-x64.deb`,
    },
    {
      platform: 'linux',
      architecture: 'arm64',
      name: `hvir-${version}-linux-arm64.deb`,
    },
    {
      platform: 'macos',
      architecture: 'arm64',
      name: `hvir-${version}-darwin-arm64.pkg`,
    },
  ]

  await mkdir(assetDirectory, { recursive: true })
  await requireExactInputs(
    assetDirectory,
    expectedArtifacts.map(({ name }) => name),
  )

  const artifacts = await Promise.all(
    expectedArtifacts.map(async (artifact) => ({
      ...artifact,
      sha256: await sha256File(resolve(assetDirectory, artifact.name)),
    })),
  )
  const installerPath = resolve(assetDirectory, 'install.sh')
  const rendered = await renderNativeInstaller({
    version,
    repository: options.repository,
    linuxX64Artifact: resolve(assetDirectory, artifacts[0].name),
    linuxArm64Artifact: resolve(assetDirectory, artifacts[1].name),
    macosArm64Artifact: resolve(assetDirectory, artifacts[2].name),
    macosTeamId: options.macosTeamId,
    output: installerPath,
  })

  const renderedArtifacts = [
    rendered.artifacts.linuxX64,
    rendered.artifacts.linuxArm64,
    rendered.artifacts.macosArm64,
  ]
  for (const [index, renderedArtifact] of renderedArtifacts.entries()) {
    const artifact = artifacts[index]
    if (
      renderedArtifact.name !== artifact.name ||
      renderedArtifact.sha256 !== artifact.sha256
    ) {
      throw new Error(`Installer metadata disagrees with ${artifact.name}.`)
    }
  }

  const noticesName = 'THIRD_PARTY_NOTICES.md'
  const noticesPath = resolve(assetDirectory, noticesName)
  await copyFile(noticesSource, noticesPath)
  const installer = {
    name: basename(installerPath),
    sha256: await sha256File(installerPath),
  }
  const notices = {
    name: noticesName,
    sha256: await sha256File(noticesPath),
  }
  const manifest = {
    schemaVersion: 1,
    version,
    tag,
    sourceCommit: options.sourceSha,
    installer,
    notices,
    artifacts,
  }
  const manifestName = 'release-manifest.json'
  const manifestPath = resolve(assetDirectory, manifestName)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const checksumNames = [
    ...artifacts.map(({ name }) => name),
    installer.name,
    manifestName,
    notices.name,
  ]
  const checksums = await Promise.all(
    checksumNames.map(
      async (name) => `${await sha256File(resolve(assetDirectory, name))}  ${name}`,
    ),
  )
  const checksumsPath = resolve(assetDirectory, 'SHA256SUMS')
  await writeFile(checksumsPath, `${checksums.join('\n')}\n`)

  await requireExactOutputs(assetDirectory, [...checksumNames, basename(checksumsPath)])
  return {
    assetDirectory,
    checksumsPath,
    installerPath,
    manifest,
    manifestPath,
  }
}

function validateOptions(options) {
  if (!versionPattern.test(options.version ?? '')) {
    throw new Error(`Invalid hvir version: ${options.version ?? 'missing'}.`)
  }
  if (!sourceCommitPattern.test(options.sourceSha ?? '')) {
    throw new Error('The release source must be one full lowercase commit SHA.')
  }
  if (!repositoryPattern.test(options.repository ?? '')) {
    throw new Error(`Invalid GitHub repository: ${options.repository ?? 'missing'}.`)
  }
  if (!teamPattern.test(options.macosTeamId ?? '')) {
    throw new Error('The macOS Apple team ID must contain 10 uppercase letters/digits.')
  }
  if (!options.assetDirectory) {
    throw new Error('A release asset directory is required.')
  }
}

async function requireExactInputs(assetDirectory, expectedNames) {
  const entries = await readdir(assetDirectory)
  const allowedGenerated = new Set([
    'install.sh',
    'release-manifest.json',
    'SHA256SUMS',
    'THIRD_PARTY_NOTICES.md',
  ])
  const unexpected = entries.filter(
    (name) => !expectedNames.includes(name) && !allowedGenerated.has(name),
  )
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release inputs: ${unexpected.sort().join(', ')}.`)
  }
  for (const name of expectedNames) {
    const path = resolve(assetDirectory, name)
    let metadata
    try {
      metadata = await stat(path)
    } catch {
      throw new Error(`Missing release input: ${name}.`)
    }
    if (!metadata.isFile()) throw new Error(`Release input is not a file: ${name}.`)
  }
}

async function requireExactOutputs(assetDirectory, expectedNames) {
  const actual = (await readdir(assetDirectory)).sort()
  const expected = [...expectedNames].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Release output set is not exact: ${actual.join(', ')}; expected ${expected.join(', ')}.`,
    )
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function parseArguments(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value pairs; stopped at ${key ?? 'end'}.`)
    }
    if (values.has(key)) throw new Error(`Duplicate option: ${key}.`)
    values.set(key, value)
  }
  const known = new Set([
    '--version',
    '--source-sha',
    '--repository',
    '--macos-team-id',
    '--asset-directory',
  ])
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`Unknown option: ${key}.`)
  }
  return {
    version: values.get('--version'),
    sourceSha: values.get('--source-sha'),
    repository: values.get('--repository') ?? 'jarmak-personal/hvir',
    macosTeamId: values.get('--macos-team-id'),
    assetDirectory: values.get('--asset-directory'),
  }
}

async function main() {
  const result = await assembleNativeRelease(parseArguments(process.argv.slice(2)))
  process.stdout.write(`Assembled ${result.manifest.tag} in ${result.assetDirectory}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
