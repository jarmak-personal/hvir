import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'

/** Fixed application namespace, never a project path or caller authority. */
export function agentEndpointDirectoryPath(): string {
  const base =
    process.platform === 'linux' && process.env['XDG_RUNTIME_DIR']
      ? process.env['XDG_RUNTIME_DIR']
      : tmpdir()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Agent sockets require Linux or macOS')
  const directory = join(base, `hvir-agent-${uid}`)
  return directory
}
export async function agentEndpointDirectory(): Promise<string> {
  const directory = agentEndpointDirectoryPath()
  if (!directory.startsWith('/'))
    throw new Error('Agent endpoint directory must be absolute')
  if (Buffer.byteLength(join(directory, '0123456789abcdef.sock')) >= 104)
    throw new Error('Agent endpoint directory exceeds the platform socket path limit')
  const stat = await lstat(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('Agent endpoint directory must be a private user-owned directory')
  return directory
}
async function alive(path: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    let finished = false
    const finish = (value: boolean | undefined): void => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(250, () => finish(undefined))
    socket.once('connect', () => finish(true))
    socket.once('error', (reason: NodeJS.ErrnoException) =>
      finish(['ECONNREFUSED', 'ENOENT'].includes(reason.code ?? '') ? false : undefined),
    )
  })
}
export async function validateSelectedAgentEndpoint(path: string): Promise<void> {
  const directory = await agentEndpointDirectory()
  if (
    !path.startsWith(`${directory}/`) ||
    !/^[a-f0-9]{16}\.sock$/u.test(path.slice(directory.length + 1))
  )
    throw new Error('Instance is outside the private application socket namespace')
  const stat = await lstat(path)
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Instance endpoint is not a private user-owned socket')
}
/** Read-only discovery: the CLI never creates directories or deletes crashed endpoints. */
export async function agentEndpointSnapshot(): Promise<
  readonly { path: string; dev: number; ino: number; live: boolean | undefined }[]
> {
  let directory: string
  try {
    directory = await agentEndpointDirectory()
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw reason
  }
  const entries = await readdir(directory),
    snapshot = []
  if (entries.length > 128) throw new Error('Too many agent endpoint entries')
  for (const name of entries.sort()) {
    if (!/^[a-f0-9]{16}\.sock$/u.test(name)) continue
    const path = join(directory, name),
      stat = await lstat(path).catch(() => undefined)
    if (!stat?.isSocket() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      continue
    snapshot.push({ path, dev: stat.dev, ino: stat.ino, live: await alive(path) })
  }
  return snapshot
}
export async function listAgentEndpoints(): Promise<readonly string[]> {
  return (await agentEndpointSnapshot())
    .filter((entry) => entry.live)
    .map((entry) => entry.path)
}
