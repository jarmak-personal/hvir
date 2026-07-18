/**
 * Open SSH/local port forwards, keyed by host and remote port.
 *
 * The registry makes `tunnel:open` idempotent — the renderer can ask for the
 * same dashboard twice (or reload mid-session) without stacking listeners —
 * and gives main one place to tear every forward down when the workspace
 * changes or the app quits.
 */

import type { ProjectHost, TunnelHandle } from './project-host'

export const MAX_OPEN_TUNNELS = 16

export interface OpenTunnel {
  readonly tunnelId: string
  readonly localPort: number
}

interface TunnelEntry {
  readonly hostId: string
  readonly handle: TunnelHandle
}

export class TunnelRegistry {
  private readonly entries = new Map<string, TunnelEntry>()
  private readonly pending = new Map<string, Promise<TunnelEntry>>()

  async open(host: ProjectHost, remotePort: number): Promise<OpenTunnel> {
    const tunnelId = `${host.hostId}:${remotePort}`
    const existing = this.entries.get(tunnelId) ?? (await this.pending.get(tunnelId))
    if (existing) return { tunnelId, localPort: existing.handle.localPort }
    if (this.entries.size + this.pending.size >= MAX_OPEN_TUNNELS) {
      throw new Error(`Too many open tunnels (limit ${MAX_OPEN_TUNNELS})`)
    }
    const create = (async (): Promise<TunnelEntry> => {
      const handle = await host.forwardLocalPort(remotePort)
      const entry: TunnelEntry = { hostId: host.hostId, handle }
      this.entries.set(tunnelId, entry)
      return entry
    })()
    this.pending.set(tunnelId, create)
    try {
      const entry = await create
      return { tunnelId, localPort: entry.handle.localPort }
    } finally {
      this.pending.delete(tunnelId)
    }
  }

  async close(tunnelId: string): Promise<void> {
    await this.pending.get(tunnelId)?.catch(() => undefined)
    const entry = this.entries.get(tunnelId)
    if (!entry) return
    this.entries.delete(tunnelId)
    await entry.handle.close()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map((entry) => entry.handle.close().catch(() => undefined)))
  }
}
