import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const PREPARED_MARKER = '.hvir-payload.json'
const PREPARATION_LOCK = '.prepare.lock'
const PREPARATION_PREFIX = '.prepare-'
const STALE_LOCK_PREFIX = '.stale-lock-'
const LOCK_OWNER = 'owner.json'
const LOCK_WAIT_MS = 5 * 60 * 1000
const OWNER_WRITE_GRACE_MS = 2 * 1000
const LOCK_POLL_MS = 100

export function nativePayloadCacheRoot({
  platform = process.platform,
  environment = process.env,
  home = homedir(),
} = {}) {
  let cacheDirectory
  if (platform === 'darwin') {
    cacheDirectory = join(home, 'Library', 'Caches')
  } else if (platform === 'linux') {
    const xdgCache = environment.XDG_CACHE_HOME
    cacheDirectory = xdgCache && isAbsolute(xdgCache) ? xdgCache : join(home, '.cache')
  } else {
    throw new Error(`hvir does not support native payload caching on ${platform}`)
  }
  return join(cacheDirectory, 'hvir', 'native')
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function prepareNativePayload({
  packageDirectory,
  packageName,
  packageVersion,
  metadata,
  cacheRoot = nativePayloadCacheRoot(),
  report = (message) => process.stderr.write(`${message}\n`),
}) {
  assertSafeSegment(packageName, 'platform package name')
  assertSafeSegment(packageVersion, 'platform package version')
  const payload = validateMetadata(metadata)
  const versionsRoot = join(resolve(cacheRoot), packageName)
  const preparedRoot = join(versionsRoot, packageVersion)
  const archive = join(resolve(packageDirectory), 'payload.tar.gz')

  await mkdir(versionsRoot, { recursive: true, mode: 0o700 })
  const existingExecutable = await validatedExecutable(
    preparedRoot,
    packageName,
    packageVersion,
    payload,
  )
  if (existingExecutable) return existingExecutable

  const lock = await acquirePreparationLock({
    versionsRoot,
    preparedRoot,
    packageName,
    packageVersion,
    metadata: payload,
    report,
  })
  if (lock.executable) return lock.executable

  let stagingDirectory
  try {
    const concurrentlyPrepared = await validatedExecutable(
      preparedRoot,
      packageName,
      packageVersion,
      payload,
    )
    if (concurrentlyPrepared) return concurrentlyPrepared

    await removeAbandonedPreparation(versionsRoot)
    report(`Preparing hvir ${packageVersion} for ${payload.platform} ${payload.arch}...`)

    const archiveDigest = await sha256File(archive)
    if (archiveDigest !== payload.archiveSha256) {
      throw new Error(
        `the ${packageName} archive checksum is ${archiveDigest}, expected ${payload.archiveSha256}`,
      )
    }

    stagingDirectory = await mkdtemp(join(versionsRoot, PREPARATION_PREFIX))
    await extractArchive(archive, stagingDirectory)
    const extractedApplication = join(stagingDirectory, 'app')
    const applicationStats = await stat(extractedApplication).catch(() => undefined)
    if (!applicationStats?.isDirectory()) {
      throw new Error(`the ${packageName} archive does not contain an app directory`)
    }

    const extractedExecutable = resolvePayloadPath(stagingDirectory, payload.executable)
    await access(extractedExecutable, constants.X_OK).catch(() => {
      throw new Error(
        `the ${packageName} archive is missing its executable at ${payload.executable}`,
      )
    })
    await writeFile(
      join(stagingDirectory, PREPARED_MARKER),
      `${JSON.stringify({
        packageName,
        packageVersion,
        archiveSha256: payload.archiveSha256,
      })}\n`,
      { mode: 0o600 },
    )

    await rm(preparedRoot, { force: true, recursive: true })
    await rename(stagingDirectory, preparedRoot)
    stagingDirectory = undefined

    const executable = await validatedExecutable(
      preparedRoot,
      packageName,
      packageVersion,
      payload,
    )
    if (!executable) {
      throw new Error(`the prepared ${packageName} payload failed validation`)
    }
    await pruneCompletedVersions(versionsRoot, packageVersion)
    report(`Prepared hvir ${packageVersion}.`)
    return executable
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    throw new Error(`could not prepare hvir ${packageVersion}: ${message}`, {
      cause: reason,
    })
  } finally {
    if (stagingDirectory) {
      await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined)
    }
    await releasePreparationLock(lock.path, lock.token)
  }
}

async function acquirePreparationLock({
  versionsRoot,
  preparedRoot,
  packageName,
  packageVersion,
  metadata,
  report,
}) {
  const lockPath = join(versionsRoot, PREPARATION_LOCK)
  const deadline = Date.now() + LOCK_WAIT_MS
  let reportedWait = false

  while (true) {
    const executable = await validatedExecutable(
      preparedRoot,
      packageName,
      packageVersion,
      metadata,
    )
    if (executable) return { executable }

    const token = randomUUID()
    try {
      await mkdir(lockPath)
      try {
        await writeFile(
          join(lockPath, LOCK_OWNER),
          `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token })}\n`,
          { flag: 'wx', mode: 0o600 },
        )
      } catch (reason) {
        await rm(lockPath, { force: true, recursive: true })
        throw reason
      }
      return { path: lockPath, token }
    } catch (reason) {
      if (!isErrorCode(reason, 'EEXIST')) throw reason
    }

    if (await recoverStaleLock(lockPath, versionsRoot)) continue
    if (Date.now() >= deadline) {
      throw new Error(
        `another hvir launch is still preparing ${packageName}; wait for it to finish, then retry`,
      )
    }
    if (!reportedWait) {
      report(`Waiting for another hvir launch to finish preparing ${packageVersion}...`)
      reportedWait = true
    }
    await delay(LOCK_POLL_MS)
  }
}

async function recoverStaleLock(lockPath, versionsRoot) {
  const owner = await readJson(join(lockPath, LOCK_OWNER))
  let stale
  if (isLockOwner(owner)) {
    stale = !processIsAlive(owner.pid)
  } else {
    const lockStats = await stat(lockPath).catch(() => undefined)
    stale = Boolean(lockStats && Date.now() - lockStats.mtimeMs >= OWNER_WRITE_GRACE_MS)
  }
  if (!stale) return false

  const stalePath = join(versionsRoot, `${STALE_LOCK_PREFIX}${randomUUID()}`)
  try {
    await rename(lockPath, stalePath)
  } catch (reason) {
    if (isErrorCode(reason, 'ENOENT')) return true
    return false
  }
  await rm(stalePath, { force: true, recursive: true })
  return true
}

async function releasePreparationLock(lockPath, token) {
  if (!lockPath || !token) return
  const owner = await readJson(join(lockPath, LOCK_OWNER))
  if (isLockOwner(owner) && owner.token === token) {
    await rm(lockPath, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function validatedExecutable(preparedRoot, packageName, packageVersion, metadata) {
  const marker = await readJson(join(preparedRoot, PREPARED_MARKER))
  if (
    !marker ||
    marker.packageName !== packageName ||
    marker.packageVersion !== packageVersion ||
    marker.archiveSha256 !== metadata.archiveSha256
  ) {
    return undefined
  }
  const executable = resolvePayloadPath(preparedRoot, metadata.executable)
  try {
    await access(executable, constants.X_OK)
    return executable
  } catch {
    return undefined
  }
}

async function removeAbandonedPreparation(versionsRoot) {
  const entries = await readdir(versionsRoot, { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name.startsWith(PREPARATION_PREFIX) ||
            entry.name.startsWith(STALE_LOCK_PREFIX)),
      )
      .map((entry) =>
        rm(join(versionsRoot, entry.name), { force: true, recursive: true }),
      ),
  )
}

async function pruneCompletedVersions(versionsRoot, currentVersion) {
  const entries = await readdir(versionsRoot, { withFileTypes: true })
  const completed = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => ({
        name: entry.name,
        modified: (await stat(join(versionsRoot, entry.name))).mtimeMs,
      })),
  )
  const previous = completed
    .filter((entry) => entry.name !== currentVersion)
    .sort((left, right) => right.modified - left.modified)
    .at(0)?.name
  const retained = new Set([currentVersion, previous].filter(Boolean))
  await Promise.all(
    completed
      .filter((entry) => !retained.has(entry.name))
      .map((entry) =>
        rm(join(versionsRoot, entry.name), { force: true, recursive: true }),
      ),
  )
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('the platform payload metadata is invalid')
  }
  for (const key of ['platform', 'arch', 'executable', 'archiveSha256']) {
    if (typeof metadata[key] !== 'string' || metadata[key].length === 0) {
      throw new Error(`the platform payload metadata is missing ${key}`)
    }
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.archiveSha256)) {
    throw new Error('the platform payload archive checksum is invalid')
  }
  if (!metadata.executable.startsWith('app/')) {
    throw new Error('the platform payload executable must be below app')
  }
  resolvePayloadPath(join(sep, 'hvir-payload-root'), metadata.executable)
  return metadata
}

function resolvePayloadPath(root, payloadPath) {
  const absoluteRoot = resolve(root)
  const resolved = resolve(absoluteRoot, payloadPath)
  const childPath = relative(absoluteRoot, resolved)
  if (!childPath || childPath === '..' || childPath.startsWith(`..${sep}`)) {
    throw new Error(
      `the platform payload path is outside its prepared root: ${payloadPath}`,
    )
  }
  return resolved
}

function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
    throw new Error(`the ${label} is invalid`)
  }
}

async function extractArchive(archive, destination) {
  await new Promise((resolveExtraction, rejectExtraction) => {
    const child = spawn('tar', ['-xzf', archive, '-C', destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length)
    })
    child.once('error', rejectExtraction)
    child.once('close', (code) => {
      if (code === 0) {
        resolveExtraction()
      } else {
        rejectExtraction(
          new Error(
            `tar exited ${code ?? 'without a status'}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        )
      }
    })
  })
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function isLockOwner(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    Number.isFinite(value.startedAt) &&
    typeof value.token === 'string'
  )
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (reason) {
    return isErrorCode(reason, 'EPERM')
  }
}

function isErrorCode(reason, code) {
  return reason instanceof Error && 'code' in reason && reason.code === code
}
