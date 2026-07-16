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

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootPackage = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
)
const outputDirectory = join(repositoryRoot, 'dist', 'npm')
const stagingRoot = join(repositoryRoot, 'dist', 'npm-stage')

const platforms = {
  'darwin-arm64': {
    packageName: 'hvir-darwin-arm64',
    executable: 'app/hvir.app/Contents/MacOS/hvir',
  },
  'linux-arm64': {
    packageName: 'hvir-linux-arm64',
    executable: 'app/hvir',
  },
  'linux-x64': {
    packageName: 'hvir-linux-x64',
    executable: 'app/hvir',
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

async function copyLicense(stage) {
  await cp(join(repositoryRoot, 'LICENSE'), join(stage, 'LICENSE'))
}

async function packLauncher() {
  assertReleaseVersion()
  const stage = join(stagingRoot, 'hvir')
  await rm(stage, { force: true, recursive: true })
  await mkdir(join(stage, 'bin'), { recursive: true })
  await cp(
    join(repositoryRoot, 'npm', 'launcher', 'hvir.mjs'),
    join(stage, 'bin', 'hvir.mjs'),
  )
  const optionalDependencies = Object.fromEntries(
    Object.values(platforms).map(({ packageName }) => [packageName, rootPackage.version]),
  )
  await writeJson(stagePackagePath(stage), {
    ...packageMetadata('hvir', rootPackage.description),
    bin: { hvir: 'bin/hvir.mjs' },
    files: ['bin'],
    optionalDependencies,
  })
  await writeFile(
    join(stage, 'README.md'),
    `# hvir\n\nInstall globally with \`npm install -g hvir\`, then run \`hvir\`.\n`,
  )
  await copyLicense(stage)
  try {
    await pack(stage)
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
  // them. Carry the complete app as one archive and expand it at npm install.
  await run('tar', ['-czf', join(stage, 'payload.tar.gz'), '-C', archiveRoot, 'app'])
  await cp(
    join(repositoryRoot, 'npm', 'platform', 'install.mjs'),
    join(stage, 'install.mjs'),
  )
  await writeJson(join(stage, 'platform.json'), {
    platform,
    arch,
    executable: configuration.executable,
  })
  await writeJson(stagePackagePath(stage), {
    ...packageMetadata(
      configuration.packageName,
      `Platform payload for hvir on ${platform} ${arch}. Install hvir instead.`,
    ),
    os: [platform],
    cpu: [arch],
    files: ['install.mjs', 'platform.json', 'payload.tar.gz'],
    scripts: { postinstall: 'node install.mjs' },
  })
  await writeFile(
    join(stage, 'README.md'),
    '# hvir platform payload\n\nThis package is installed automatically by `hvir`.\n',
  )
  await copyLicense(stage)
  try {
    const tarball = await pack(stage)
    await verifyPlatformPackage(tarball, configuration)
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

async function verifyPlatformPackage(tarball, configuration) {
  const installation = await mkdtemp(join(repositoryRoot, 'dist', '.npm-install-'))
  try {
    await run('npm', [
      'install',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--no-save',
      '--prefix',
      installation,
      tarball,
    ])
    await access(
      join(
        installation,
        'node_modules',
        configuration.packageName,
        configuration.executable,
      ),
      constants.X_OK,
    )
    process.stdout.write(`Verified npm installation for ${configuration.packageName}\n`)
  } finally {
    await rm(installation, { force: true, recursive: true })
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
  const tag = process.env.GITHUB_REF_NAME
  if (tag?.startsWith('v') && tag !== `v${rootPackage.version}`) {
    throw new Error(
      `Release tag ${tag} does not match package version ${rootPackage.version}`,
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
