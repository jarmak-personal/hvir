#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = resolve(repositoryRoot, 'scripts/native-installer.template.sh')
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const artifactPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const teamPattern = /^[A-Z0-9]{10}$/

export async function renderNativeInstaller(options) {
  validateOptions(options)
  const artifacts = {
    linuxX64: await artifactRecord(options.linuxX64Artifact),
    linuxArm64: await artifactRecord(options.linuxArm64Artifact),
    macosArm64: await artifactRecord(options.macosArm64Artifact),
  }
  if (
    !options.acceptanceAssetDirectory &&
    new Set(Object.values(artifacts).map(({ name }) => name)).size !== 3
  ) {
    throw new Error('Release artifact names must be distinct.')
  }

  const releaseBaseUrl =
    `https://github.com/${options.repository}/releases/download/` + `v${options.version}`
  const replacements = new Map([
    ['HVIR_VERSION', shellQuote(options.version)],
    ['HVIR_RELEASE_BASE_URL', shellQuote(releaseBaseUrl)],
    ['HVIR_LINUX_X64_ARTIFACT', shellQuote(artifacts.linuxX64.name)],
    ['HVIR_LINUX_X64_SHA256', shellQuote(artifacts.linuxX64.sha256)],
    ['HVIR_LINUX_ARM64_ARTIFACT', shellQuote(artifacts.linuxArm64.name)],
    ['HVIR_LINUX_ARM64_SHA256', shellQuote(artifacts.linuxArm64.sha256)],
    ['HVIR_MACOS_ARM64_ARTIFACT', shellQuote(artifacts.macosArm64.name)],
    ['HVIR_MACOS_ARM64_SHA256', shellQuote(artifacts.macosArm64.sha256)],
    ['HVIR_MACOS_TEAM_ID', shellQuote(options.macosTeamId)],
    [
      'HVIR_ACCEPTANCE_ASSET_DIRECTORY',
      shellQuote(options.acceptanceAssetDirectory ?? ''),
    ],
    [
      'HVIR_ACCEPTANCE_UNSIGNED_MACOS',
      shellQuote(options.acceptanceUnsignedMacos ? '1' : '0'),
    ],
  ])

  let output = await readFile(templatePath, 'utf8')
  for (const [name, value] of replacements) {
    const token = `@@${name}@@`
    if (!output.includes(token)) throw new Error(`Installer template lacks ${token}.`)
    output = output.replaceAll(token, value)
  }
  const unresolved = output.match(/@@[A-Z0-9_]+@@/)
  if (unresolved) {
    throw new Error(`Installer template retained ${unresolved[0]}.`)
  }

  const outputPath = resolve(options.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, output, { encoding: 'utf8', mode: 0o755 })
  await chmod(outputPath, 0o755)
  return { artifacts, outputPath, releaseBaseUrl }
}

function validateOptions(options) {
  if (!versionPattern.test(options.version ?? '')) {
    throw new Error(`Invalid hvir version: ${options.version ?? 'missing'}.`)
  }
  if (!repositoryPattern.test(options.repository ?? '')) {
    throw new Error(`Invalid GitHub repository: ${options.repository ?? 'missing'}.`)
  }
  if (!teamPattern.test(options.macosTeamId ?? '')) {
    throw new Error('The macOS Apple team ID must contain 10 uppercase letters/digits.')
  }
  if (!options.output) throw new Error('An installer output path is required.')
  for (const [target, path, extension] of [
    ['Linux x64', options.linuxX64Artifact, '.deb'],
    ['Linux arm64', options.linuxArm64Artifact, '.deb'],
    ['macOS arm64', options.macosArm64Artifact, '.pkg'],
  ]) {
    if (!path || !basename(path).endsWith(extension)) {
      throw new Error(`${target} requires one ${extension} artifact.`)
    }
  }
  if (options.acceptanceAssetDirectory) {
    if (
      process.env.CI !== 'true' ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      !isAbsolute(options.acceptanceAssetDirectory)
    ) {
      throw new Error(
        'Local acceptance assets require an absolute path on GitHub Actions.',
      )
    }
  } else if (options.acceptanceUnsignedMacos) {
    throw new Error('Unsigned macOS mode is valid only for local CI acceptance assets.')
  }
}

async function artifactRecord(path) {
  if (!path) throw new Error('All three native artifact paths are required.')
  const name = basename(path)
  if (!artifactPattern.test(name)) {
    throw new Error(`Unsafe native artifact name: ${name}.`)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(resolve(path))) hash.update(chunk)
  return {
    name,
    sha256: hash.digest('hex'),
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
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
    '--repository',
    '--linux-x64-artifact',
    '--linux-arm64-artifact',
    '--macos-arm64-artifact',
    '--macos-team-id',
    '--output',
    '--acceptance-asset-directory',
    '--acceptance-unsigned-macos',
  ])
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`Unknown option: ${key}.`)
  }
  const unsigned = values.get('--acceptance-unsigned-macos')
  if (unsigned !== undefined && unsigned !== 'true' && unsigned !== 'false') {
    throw new Error('--acceptance-unsigned-macos must be true or false.')
  }
  return {
    version: values.get('--version'),
    repository: values.get('--repository') ?? 'jarmak-personal/hvir',
    linuxX64Artifact: values.get('--linux-x64-artifact'),
    linuxArm64Artifact: values.get('--linux-arm64-artifact'),
    macosArm64Artifact: values.get('--macos-arm64-artifact'),
    macosTeamId: values.get('--macos-team-id'),
    output: values.get('--output'),
    acceptanceAssetDirectory: values.get('--acceptance-asset-directory'),
    acceptanceUnsignedMacos: unsigned === 'true',
  }
}

async function main() {
  const result = await renderNativeInstaller(parseArguments(process.argv.slice(2)))
  process.stdout.write(`Rendered ${result.outputPath}\n`)
  for (const [target, artifact] of Object.entries(result.artifacts)) {
    process.stdout.write(`${target}: ${artifact.name} ${artifact.sha256}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
