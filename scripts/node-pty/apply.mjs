import process from 'node:process'
import { log } from 'node:console'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const directory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(directory, '../..')
const execute = promisify(execFile)
const paths = ['src/unixTerminal.ts', 'lib/unixTerminal.js']
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const fail = (stage) => {
  throw new Error(`node-pty exit-drain patch: ${stage}`)
}

/** Fixed, reviewed dependency correction; no runtime monkey-patching or patch registry. */
export async function applyNodePtyPatch(root = repository) {
  const pin = await json(join(directory, 'pin.json'))
  if (
    !pin ||
    pin.schema !== 1 ||
    pin.name !== 'node-pty' ||
    pin.version !== '1.1.0' ||
    pin.patch !== 'exit-drain.patch.txt' ||
    pin.url !== 'https://registry.npmjs.org/node-pty/-/node-pty-1.1.0.tgz' ||
    typeof pin.integrity !== 'string' ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pin.integrity) ||
    !/^[a-f0-9]{64}$/.test(pin.patchSha256) ||
    !Array.isArray(pin.files) ||
    pin.files.length !== paths.length ||
    pin.files.some(
      (file, index) =>
        file?.path !== paths[index] ||
        !/^[a-f0-9]{64}$/.test(file.originalSha256) ||
        !/^[a-f0-9]{64}$/.test(file.patchedSha256) ||
        file.originalSha256 === file.patchedSha256,
    )
  )
    fail('invalid maintained pin')
  const patch = join(directory, pin.patch)
  if (digest(await readFile(patch)) !== pin.patchSha256) fail('patch digest mismatch')
  const repositoryRoot = await realpath(resolve(root))
  const packageRoot = join(repositoryRoot, 'node_modules/node-pty')
  if (
    (await realpath(packageRoot)) !== packageRoot ||
    (await lstat(packageRoot)).isSymbolicLink()
  )
    fail('linked dependency is unsupported')
  const [installed, manifest, lock] = await Promise.all([
    json(join(packageRoot, 'package.json')),
    json(join(repositoryRoot, 'package.json')),
    json(join(repositoryRoot, 'package-lock.json')),
  ])
  const locked = lock.packages?.['node_modules/node-pty']
  if (
    installed.name !== pin.name ||
    installed.version !== pin.version ||
    manifest.dependencies?.['node-pty'] !== pin.version ||
    lock.packages?.['']?.dependencies?.['node-pty'] !== pin.version ||
    locked?.version !== pin.version ||
    locked.resolved !== pin.url ||
    locked.integrity !== pin.integrity
  )
    fail('dependency identity or lock mismatch')
  const before = await Promise.all(
    pin.files.map(async (file) => {
      const path = join(packageRoot, file.path)
      if ((await realpath(path)) !== path || (await lstat(path)).isSymbolicLink())
        fail(`linked input ${file.path}`)
      return digest(await readFile(path))
    }),
  )
  if (before.every((hash, index) => hash === pin.files[index].patchedSha256))
    return { state: 'verified', version: pin.version }
  if (!before.every((hash, index) => hash === pin.files[index].originalSha256))
    fail('unknown or mixed dependency source; reinstall the pinned package')
  const args = ['apply', '--directory=node_modules/node-pty', '--whitespace=error-all']
  const options = { cwd: repositoryRoot, timeout: 10000, maxBuffer: 65536 }
  await execute('git', [...args, '--check', patch], options)
  await execute('git', [...args, patch], options)
  for (const file of pin.files) {
    if (digest(await readFile(join(packageRoot, file.path))) !== file.patchedSha256)
      fail(`patched digest mismatch ${file.path}`)
  }
  return { state: 'patched', version: pin.version }
}

if (
  process.argv[1] &&
  (await realpath(fileURLToPath(import.meta.url))) ===
    (await realpath(resolve(process.argv[1])))
) {
  if (process.argv.length !== 2) fail('this installer accepts no arguments')
  const result = await applyNodePtyPatch()
  log(`HVIR_NODE_PTY_PATCH_OK ${result.version} ${result.state}`)
}
