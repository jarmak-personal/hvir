import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  agentEndpointDirectory,
  agentEndpointDirectoryPath,
  agentEndpointSnapshot,
} from '../../agent-transport/endpoint-directory'

export function plannedAgentEndpoint(instance: string): string {
  return join(
    agentEndpointDirectoryPath(),
    `${instance.replaceAll('-', '').slice(0, 16)}.sock`,
  )
}

/** LocalHost's fixed application endpoint mechanics; no arbitrary filesystem port. */
export class LocalAgentEndpoint {
  private path?: string
  private identity?: { dev: number; ino: number }
  async prepare(instance: string): Promise<string> {
    await mkdir(agentEndpointDirectoryPath(), { mode: 0o700 }).catch(
      (reason: unknown) => {
        if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
      },
    )
    await agentEndpointDirectory()
    for (const entry of await agentEndpointSnapshot()) {
      if (entry.live !== false) continue
      const stat = await lstat(entry.path).catch(() => undefined)
      if (stat?.isSocket() && stat.dev === entry.dev && stat.ino === entry.ino)
        await unlink(entry.path).catch(() => undefined)
    }
    return (this.path = plannedAgentEndpoint(instance))
  }
  async claim(): Promise<void> {
    if (!this.path) throw new Error('Agent endpoint was not prepared')
    const stat = await lstat(this.path)
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw new Error('Agent endpoint was replaced')
    this.identity = { dev: stat.dev, ino: stat.ino }
    await chmod(this.path, 0o600)
  }
  async release(): Promise<void> {
    if (!this.path || !this.identity) return
    const stat = await lstat(this.path).catch(() => undefined)
    if (
      stat?.isSocket() &&
      stat.dev === this.identity.dev &&
      stat.ino === this.identity.ino
    )
      await unlink(this.path).catch(() => undefined)
  }
}
