#!/usr/bin/env node

import { execFile } from 'node:child_process'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { prepareNativePayload, sha256File } from '../npm/native-payload.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackage = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
)
const outputDirectory = join(repositoryRoot, 'dist', 'npm')
const stagingRoot = join(repositoryRoot, 'dist', 'npm-stage')
const launcherPackageName = 'hvir-workbench'
const thirdPartyNoticesFilename = 'THIRD_PARTY_NOTICES.md'
const requiredNoticeCopyrights = [
  'Copyright (c) 2025 Coder',
  'Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors',
]

const platforms = {
  'darwin-arm64': {
    packageName: 'hvir-darwin-arm64',
    executable: 'app/hvir.app/Contents/MacOS/hvir',
    notices: 'app/hvir.app/Contents/Resources/THIRD_PARTY_NOTICES.md',
  },
  'linux-arm64': {
    packageName: 'hvir-linux-arm64',
    executable: 'app/hvir',
    notices: 'app/resources/THIRD_PARTY_NOTICES.md',
  },
  'linux-x64': {
    packageName: 'hvir-linux-x64',
    executable: 'app/hvir',
    notices: 'app/resources/THIRD_PARTY_NOTICES.md',
  },
}

function packageMetadata(name, description) {
  return {
    name,
    version: rootPackage.version,
    description,
    author: rootPackage.author,
    license: rootPackage.license,
    keywords: rootPackage.keywords,
    repository: rootPackage.repository,
    homepage: rootPackage.homepage,
    bugs: rootPackage.bugs,
    engines: { node: '>=18' },
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return stdout
}

async function pack(stage) {
  await mkdir(outputDirectory, { recursive: true })
  const output = await run('npm', ['pack', stage, '--pack-destination', outputDirectory])
  const filename = output.trim().split('\n').at(-1)
  if (!filename) throw new Error(`npm pack did not report an archive for ${stage}`)
  return join(outputDirectory, filename)
}

async function copyLegalFiles(stage) {
  await Promise.all([
    cp(join(repositoryRoot, 'LICENSE'), join(stage, 'LICENSE')),
    cp(
      join(repositoryRoot, thirdPartyNoticesFilename),
      join(stage, thirdPartyNoticesFilename),
    ),
  ])
}

async function packLauncher() {
  assertReleaseVersion()
  const stage = join(stagingRoot, launcherPackageName)
  await rm(stage, { force: true, recursive: true })
  await mkdir(join(stage, 'bin'), { recursive: true })
  await cp(
    join(repositoryRoot, 'npm', 'launcher', 'hvir.mjs'),
    join(stage, 'bin', 'hvir.mjs'),
  )
  await cp(
    join(repositoryRoot, 'npm', 'native-payload.mjs'),
    join(stage, 'native-payload.mjs'),
  )
  const optionalDependencies = Object.fromEntries(
    Object.values(platforms).map(({ packageName }) => [packageName, rootPackage.version]),
  )
  await writeJson(stagePackagePath(stage), {
    ...packageMetadata(launcherPackageName, rootPackage.description),
    bin: { hvir: 'bin/hvir.mjs' },
    files: ['bin', 'native-payload.mjs', 'LICENSE', thirdPartyNoticesFilename],
    optionalDependencies,
  })
  await writeFile(
    join(stage, 'README.md'),
    `# hvir\n\nInstall globally with \`npm install -g ${launcherPackageName}\`, then run \`hvir\`.\n\nSee [third-party notices](${thirdPartyNoticesFilename}).\n`,
  )
  await copyLegalFiles(stage)
  try {
    const tarball = await pack(stage)
    await verifyPackageArchiveIncludesLegalFiles(tarball)
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

async function packPlatform(platform, arch, buildOutput) {
  assertReleaseVersion()
  const key = `${platform}-${arch}`
  const configuration = platforms[key]
  if (!configuration) throw new Error(`Unsupported npm payload: ${key}`)
  if (process.platform !== platform || process.arch !== arch) {
    throw new Error(
      `${key} must be packaged on native ${platform} ${arch}; this host is ` +
        `${process.platform} ${process.arch}`,
    )
  }
  const source = await findPackagedApplication(
    resolve(repositoryRoot, buildOutput),
    platform,
  )
  const stage = join(stagingRoot, configuration.packageName)
  const archiveRoot = join(stage, 'archive')
  const applicationRoot = join(archiveRoot, 'app')
  await rm(stage, { force: true, recursive: true })
  await mkdir(applicationRoot, { recursive: true })
  if (platform === 'darwin') {
    await cp(source, join(applicationRoot, 'hvir.app'), {
      recursive: true,
      verbatimSymlinks: true,
    })
  } else {
    for (const entry of await readdir(source)) {
      await cp(join(source, entry), join(applicationRoot, entry), {
        recursive: true,
        verbatimSymlinks: true,
      })
    }
  }
  // npm pack omits symlinks, while Electron's macOS framework layout requires
  // them. Carry the complete app as one archive for script-free first-use preparation.
  const archive = join(stage, 'payload.tar.gz')
  await run('tar', ['-czf', archive, '-C', archiveRoot, 'app'])
  const platformMetadata = {
    platform,
    arch,
    executable: configuration.executable,
    archiveSha256: await sha256File(archive),
  }
  await writeJson(join(stage, 'platform.json'), platformMetadata)
  await writeJson(stagePackagePath(stage), {
    ...packageMetadata(
      configuration.packageName,
      `Platform payload for hvir on ${platform} ${arch}. Install ${launcherPackageName} instead.`,
    ),
    os: [platform],
    cpu: [arch],
    files: ['platform.json', 'payload.tar.gz', 'LICENSE', thirdPartyNoticesFilename],
  })
  await writeFile(
    join(stage, 'README.md'),
    `# hvir platform payload\n\nThis package is installed automatically by \`${launcherPackageName}\`.\n\nSee [third-party notices](${thirdPartyNoticesFilename}).\n`,
  )
  await copyLegalFiles(stage)
  try {
    const tarball = await pack(stage)
    await verifyPackageArchiveIncludesLegalFiles(tarball)
    await verifyPlatformPackage(tarball, configuration, platformMetadata)
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

async function verifyPlatformPackage(tarball, configuration, metadata) {
  const installation = await mkdtemp(join(repositoryRoot, 'dist', '.npm-install-'))
  try {
    await run('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      '--strict-allow-scripts',
      '--prefix',
      installation,
      tarball,
    ])
    const packageRoot = join(installation, 'node_modules', configuration.packageName)
    const installedPackage = JSON.parse(
      await readFile(join(packageRoot, 'package.json'), 'utf8'),
    )
    if (installedPackage.scripts) {
      throw new Error(`${configuration.packageName} must not declare lifecycle scripts`)
    }
    await access(join(packageRoot, 'payload.tar.gz'), constants.R_OK)
    await verifyThirdPartyNotices(join(packageRoot, thirdPartyNoticesFilename))
    const cacheRoot = join(installation, 'cache')
    const executable = await prepareNativePayload({
      packageDirectory: packageRoot,
      packageName: configuration.packageName,
      packageVersion: rootPackage.version,
      metadata,
      cacheRoot,
      report: (message) => process.stdout.write(`${message}\n`),
    })
    await access(executable, constants.X_OK)
    await verifyThirdPartyNotices(
      join(
        cacheRoot,
        configuration.packageName,
        rootPackage.version,
        configuration.notices,
      ),
    )
    process.stdout.write(`Verified npm installation for ${configuration.packageName}\n`)
  } finally {
    await rm(installation, { force: true, recursive: true })
  }
}

async function verifyPackageArchiveIncludesLegalFiles(tarball) {
  const listing = await run('tar', ['-tzf', tarball])
  for (const filename of ['LICENSE', thirdPartyNoticesFilename]) {
    if (!listing.split('\n').includes(`package/${filename}`)) {
      throw new Error(`${tarball} does not contain ${filename}`)
    }
  }
}

async function verifyThirdPartyNotices(path) {
  const notices = await readFile(path, 'utf8')
  for (const copyright of requiredNoticeCopyrights) {
    if (!notices.includes(copyright)) {
      throw new Error(`${path} does not contain ${copyright}`)
    }
  }
}

async function findPackagedApplication(root, platform) {
  const candidates = await walkDirectories(root, 4)
  if (platform === 'darwin') {
    const application = candidates.find((path) => path.endsWith('/hvir.app'))
    if (application) return application
  } else {
    for (const directory of candidates) {
      try {
        const executable = await stat(join(directory, 'hvir'))
        const resources = await stat(join(directory, 'resources'))
        if (executable.isFile() && resources.isDirectory()) return directory
      } catch {
        // Not the root of the packaged Electron application.
      }
    }
  }
  throw new Error(`Could not find the packaged hvir application below ${root}`)
}

async function walkDirectories(root, depth) {
  const directories = [root]
  if (depth === 0) return directories
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    directories.push(...(await walkDirectories(join(root, entry.name), depth - 1)))
  }
  return directories
}

function stagePackagePath(stage) {
  return join(stage, 'package.json')
}

function assertReleaseVersion() {
  const expectedVersion = process.env.HVIR_RELEASE_VERSION
  const tag = process.env.GITHUB_REF_NAME
  const tagVersion = tag?.startsWith('v') ? tag.slice(1) : undefined
  const releaseVersion = expectedVersion ?? tagVersion
  if (releaseVersion && releaseVersion !== rootPackage.version) {
    throw new Error(
      `Release version ${releaseVersion} does not match package version ${rootPackage.version}`,
    )
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === 'launcher') {
  await packLauncher()
} else if (command === 'platform' && args.length === 3) {
  await packPlatform(args[0], args[1], args[2])
} else {
  const relativeScript = relative(repositoryRoot, fileURLToPath(import.meta.url))
  throw new Error(
    `Usage: node ${relativeScript} launcher | platform <platform> <arch> <build-output>`,
  )
}
