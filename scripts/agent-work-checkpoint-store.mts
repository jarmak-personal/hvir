/** Local-only identity: never publish the filename, provider identity, or lookup digest. */
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

export interface SessionAssignment {
  issue: number
  receipt: string
}

export async function assignSession(input: {
  root: string
  repository: string
  provider: string
  session: string
  issue: number
  apply: boolean
}): Promise<SessionAssignment | undefined> {
  if (!input.session || !Number.isSafeInteger(input.issue) || input.issue <= 0) {
    throw new Error('Session assignment identity is unavailable.')
  }
  if (input.apply) await mkdir(input.root, { recursive: true, mode: 0o700 })
  let root
  try {
    root = await lstat(input.root)
  } catch (error) {
    if (!input.apply && isMissing(error)) return undefined
    throw new Error('Private assignment storage unavailable.', { cause: error })
  }
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (root.mode & 0o077) !== 0 ||
    (process.getuid && root.uid !== process.getuid())
  ) {
    throw new Error('Private assignment storage is unsafe.')
  }
  const key = createHash('sha256')
    .update(JSON.stringify([input.repository, input.provider, input.session]))
    .digest('hex')
  const path = join(input.root, `${key}.json`)
  const read = async (): Promise<SessionAssignment | undefined> => {
    let file
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new Error('Private assignment unavailable.', { cause: error })
    }
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        stat.size > 256 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error()
      const value: unknown = JSON.parse(await file.readFile('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      const row = value as Record<string, unknown>
      if (
        Object.keys(row).sort().join(',') !== 'issue,receipt' ||
        typeof row.issue !== 'number' ||
        !Number.isSafeInteger(row.issue) ||
        row.issue <= 0 ||
        typeof row.receipt !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.receipt)
      )
        throw new Error()
      if (row.issue !== input.issue)
        throw new Error('Session already belongs to another issue.')
      return { issue: row.issue, receipt: row.receipt }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Session already belongs to another issue.'
      )
        throw error
      throw new Error('Private assignment unavailable.', { cause: error })
    } finally {
      await file.close()
    }
  }
  const existing = await read()
  if (existing || !input.apply) return existing
  const assignment = { issue: input.issue, receipt: randomBytes(32).toString('hex') }
  const temporary = join(input.root, `.pending-${randomBytes(16).toString('hex')}`)
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    try {
      await file.writeFile(JSON.stringify(assignment))
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST'
      )
        return read()
      throw new Error('Private assignment unavailable.', { cause: error })
    }
    return assignment
  } finally {
    await unlink(temporary)
  }
}

function isMissing(error: unknown): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
  )
}
