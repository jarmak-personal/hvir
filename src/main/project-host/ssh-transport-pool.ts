import { type Client, type ClientChannel, type SFTPWrapper } from 'ssh2'

import type { Disposer } from './project-host'

export const SSH_MAX_PHYSICAL_TRANSPORTS = 8
export const SSH_MAX_CONTROL_TRANSPORTS = 2
export const SSH_CONTROL_CHANNEL_BUDGET = 6
export const SSH_TERMINAL_CHANNEL_BUDGET = 8
export const SSH_TUNNEL_CHANNEL_BUDGET = 16
export const SSH_MAX_TUNNEL_TRANSPORTS = 2
export const SSH_TRANSPORT_IDLE_GRACE_MS = 5 * 60_000

const SSH_CHANNEL_OPEN_ATTEMPTS = 5

export type SshTransportRole = 'control' | 'terminal' | 'tunnel'

interface SshTransport {
  readonly id: number
  readonly role: SshTransportRole
  readonly client: Client
  readonly primary: boolean
  readonly channels: Set<ClientChannel>
  readonly failureListeners: Set<() => void>
  pendingChannels: number
  readonly channelBudget: number
  sftpActive: boolean
  closed: boolean
  idleTimer?: ReturnType<typeof setTimeout>
}

interface SshTransportReservation {
  readonly transport: SshTransport
  release(): void
}

export interface SshTransportDiagnostic {
  readonly id: number
  readonly role: SshTransportRole
  readonly primary: boolean
  readonly channels: number
  readonly pendingChannels: number
  readonly channelBudget: number
  readonly refusedChannels: number
}

export interface SshTransportPoolOwner {
  connected(): Promise<Client>
  assertTransportGrowthAllowed(role: SshTransportRole): void
  openAuxiliaryTransport(role: SshTransportRole): Promise<Client>
  lifecycleSignal(): AbortSignal
}

/**
 * Singular channel-capacity authority for one logical SshHost. It owns every
 * physical transport and channel lease but delegates authentication to the
 * host's one connection lifecycle.
 */
export class SshTransportPool {
  private readonly channels = new Set<ClientChannel>()
  private readonly transports = new Set<SshTransport>()
  private nextTransportId = 1
  private transportGrowthTail: Promise<void> = Promise.resolve()
  private readonly refusedChannels = new Map<number, number>()

  constructor(private readonly owner: SshTransportPoolOwner) {}

  diagnostics(): readonly SshTransportDiagnostic[] {
    return [...this.transports]
      .filter((transport) => !transport.closed)
      .map((transport) => ({
        id: transport.id,
        role: transport.role,
        primary: transport.primary,
        channels: transport.channels.size + (transport.sftpActive ? 1 : 0),
        pendingChannels: transport.pendingChannels,
        channelBudget: transport.channelBudget,
        refusedChannels: this.refusedChannels.get(transport.id) ?? 0,
      }))
      .sort((a, b) => a.id - b.id)
  }

  registerPrimary(client: Client): void {
    this.registerTransport('control', client, true)
  }

  retireClient(client: Client): void {
    const transport = this.transportForClient(client)
    if (transport) this.retireTransport(transport)
  }

  async openChannel(
    role: SshTransportRole,
    open: (client: Client) => Promise<ClientChannel>,
    signal?: AbortSignal,
    channelOpenAttempts = SSH_CHANNEL_OPEN_ATTEMPTS,
  ): Promise<ClientChannel> {
    const { value: channel, reservation } = await this.openWithChannelRetry(
      role,
      (transport) => open(transport.client),
      signal,
      channelOpenAttempts,
    )
    this.activateChannel(reservation, channel)
    return channel
  }

  async openSftp(): Promise<SFTPWrapper> {
    const { value: session, reservation } = await this.openWithChannelRetry(
      'control',
      (transport) =>
        new Promise<SFTPWrapper>((resolve, reject) => {
          try {
            transport.client.sftp((error, value) =>
              error ? reject(error) : resolve(value),
            )
          } catch (error) {
            reject(asError(error))
          }
        }),
    )
    reservation.release()
    const { transport } = reservation
    if (transport.idleTimer) clearTimeout(transport.idleTimer)
    transport.idleTimer = undefined
    transport.sftpActive = true
    session.once('close', () => {
      transport.sftpActive = false
      this.scheduleTransportIdle(transport)
    })
    return session
  }

  onChannelTransportFailure(channel: ClientChannel, callback: () => void): Disposer {
    const transport = [...this.transports].find((candidate) =>
      candidate.channels.has(channel),
    )
    if (!transport || transport.closed) {
      callback()
      return () => undefined
    }
    transport.failureListeners.add(callback)
    return () => {
      transport.failureListeners.delete(callback)
    }
  }

  dispose(): ReadonlySet<Client> {
    const transports = [...this.transports]
    const clients = new Set(transports.map((transport) => transport.client))
    for (const transport of transports) {
      transport.closed = true
      if (transport.idleTimer) clearTimeout(transport.idleTimer)
      for (const fail of transport.failureListeners) fail()
      transport.failureListeners.clear()
    }
    this.transports.clear()
    for (const channel of this.channels) channel.close()
    this.channels.clear()
    this.refusedChannels.clear()
    this.transportGrowthTail = Promise.resolve()
    return clients
  }

  private registerTransport(
    role: SshTransportRole,
    client: Client,
    primary: boolean,
  ): SshTransport {
    const existing = this.transportForClient(client)
    if (existing) return existing
    const transport: SshTransport = {
      id: this.nextTransportId++,
      role,
      client,
      primary,
      channels: new Set(),
      failureListeners: new Set(),
      pendingChannels: 0,
      channelBudget:
        role === 'control'
          ? SSH_CONTROL_CHANNEL_BUDGET
          : role === 'tunnel'
            ? SSH_TUNNEL_CHANNEL_BUDGET
            : SSH_TERMINAL_CHANNEL_BUDGET,
      sftpActive: false,
      closed: false,
    }
    this.transports.add(transport)
    return transport
  }

  private transportForClient(client: Client): SshTransport | undefined {
    return [...this.transports].find(
      (transport) => transport.client === client && !transport.closed,
    )
  }

  private transportLoad(transport: SshTransport): number {
    return (
      transport.channels.size + transport.pendingChannels + (transport.sftpActive ? 1 : 0)
    )
  }

  private availableTransport(
    role: SshTransportRole,
    excluded: ReadonlySet<number>,
  ): SshTransport | undefined {
    return [...this.transports]
      .filter(
        (transport) =>
          !transport.closed &&
          transport.role === role &&
          !excluded.has(transport.id) &&
          this.transportLoad(transport) < transport.channelBudget,
      )
      .sort((a, b) => this.transportLoad(a) - this.transportLoad(b) || a.id - b.id)[0]
  }

  private reserveOnTransport(transport: SshTransport): SshTransportReservation {
    if (transport.idleTimer) {
      clearTimeout(transport.idleTimer)
      transport.idleTimer = undefined
    }
    transport.pendingChannels++
    let released = false
    return {
      transport,
      release: () => {
        if (released) return
        released = true
        transport.pendingChannels = Math.max(0, transport.pendingChannels - 1)
        this.scheduleTransportIdle(transport)
      },
    }
  }

  private async reserveTransport(
    role: SshTransportRole,
    excluded: ReadonlySet<number> = new Set(),
  ): Promise<SshTransportReservation> {
    const primary = await this.owner.connected()
    this.registerTransport('control', primary, true)
    const available = this.availableTransport(role, excluded)
    if (available) return this.reserveOnTransport(available)

    let resolveResult!: (reservation: SshTransportReservation) => void
    let rejectResult!: (error: Error) => void
    const result = new Promise<SshTransportReservation>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const grow = async (): Promise<void> => {
      try {
        const reused = this.availableTransport(role, excluded)
        if (reused) {
          resolveResult(this.reserveOnTransport(reused))
          return
        }
        const live = [...this.transports].filter((transport) => !transport.closed)
        const roleCount = live.filter((transport) => transport.role === role).length
        if (
          live.length >= SSH_MAX_PHYSICAL_TRANSPORTS ||
          (role === 'control' && roleCount >= SSH_MAX_CONTROL_TRANSPORTS) ||
          (role === 'tunnel' && roleCount >= SSH_MAX_TUNNEL_TRANSPORTS)
        ) {
          throw sshCapacityError(role)
        }
        this.owner.assertTransportGrowthAllowed(role)
        let transport: SshTransport
        try {
          const client = await this.owner.openAuxiliaryTransport(role)
          transport = this.registerTransport(role, client, false)
        } catch (error) {
          throw new Error(
            `SSH ${role} capacity could not grow; existing sessions remain connected: ${asError(error).message}`,
            { cause: error },
          )
        }
        resolveResult(this.reserveOnTransport(transport))
      } catch (error) {
        rejectResult(asError(error))
      }
    }
    const queued = this.transportGrowthTail.then(grow, grow)
    this.transportGrowthTail = queued.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async openWithChannelRetry<T>(
    role: SshTransportRole,
    open: (transport: SshTransport) => Promise<T>,
    signal?: AbortSignal,
    attempts = SSH_CHANNEL_OPEN_ATTEMPTS,
  ): Promise<{ value: T; reservation: SshTransportReservation }> {
    const excluded = new Set<number>()
    for (let attempt = 0; attempt < attempts; attempt++) {
      throwIfAborted(signal, this.owner.lifecycleSignal())
      const reservation = await this.reserveTransport(role, excluded)
      try {
        const value = await open(reservation.transport)
        return { value, reservation }
      } catch (error) {
        reservation.release()
        if (!isChannelOpenFailure(error) || attempt + 1 >= attempts) {
          throw error
        }
        this.noteChannelRefusal(reservation.transport)
        if (attempt > 0) excluded.add(reservation.transport.id)
        await abortableDelay(25 * 2 ** attempt, signal, this.owner.lifecycleSignal())
      }
    }
    throw sshCapacityError(role)
  }

  private activateChannel(
    reservation: SshTransportReservation,
    channel: ClientChannel,
  ): void {
    reservation.release()
    const { transport } = reservation
    if (transport.closed) {
      channel.close()
      return
    }
    if (transport.idleTimer) {
      clearTimeout(transport.idleTimer)
      transport.idleTimer = undefined
    }
    transport.channels.add(channel)
    this.channels.add(channel)
    let released = false
    channel.once('close', () => {
      if (released) return
      released = true
      transport.channels.delete(channel)
      this.channels.delete(channel)
      this.scheduleTransportIdle(transport)
    })
  }

  private noteChannelRefusal(transport: SshTransport): void {
    this.refusedChannels.set(
      transport.id,
      Math.min(1_000, (this.refusedChannels.get(transport.id) ?? 0) + 1),
    )
  }

  private scheduleTransportIdle(transport: SshTransport): void {
    if (
      transport.primary ||
      transport.closed ||
      transport.idleTimer ||
      this.transportLoad(transport) !== 0
    ) {
      return
    }
    transport.idleTimer = setTimeout(() => {
      transport.idleTimer = undefined
      if (transport.closed || this.transportLoad(transport) !== 0) return
      this.retireTransport(transport)
      try {
        transport.client.end()
      } catch {
        // Idle retirement is best-effort; the transport is already unregistered.
      }
    }, SSH_TRANSPORT_IDLE_GRACE_MS)
  }

  private retireTransport(transport: SshTransport): void {
    if (transport.closed) return
    transport.closed = true
    if (transport.idleTimer) clearTimeout(transport.idleTimer)
    transport.idleTimer = undefined
    transport.sftpActive = false
    this.transports.delete(transport)
    for (const fail of transport.failureListeners) fail()
    transport.failureListeners.clear()
    for (const channel of transport.channels) this.channels.delete(channel)
    transport.channels.clear()
  }
}

function isChannelOpenFailure(value: unknown): boolean {
  return value instanceof Error && /\bchannel open failure\b/i.test(value.message)
}

function sshCapacityError(role: SshTransportRole): Error {
  return new Error(
    `SSH ${role} capacity is full (${SSH_MAX_PHYSICAL_TRANSPORTS} transport limit); existing sessions remain connected`,
  )
}

function abortableDelay(
  ms: number,
  ...signals: Array<AbortSignal | undefined>
): Promise<void> {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (activeSignals.some((signal) => signal.aborted)) {
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      for (const signal of activeSignals) signal.removeEventListener('abort', abort)
    }
    const finish = (): void => {
      cleanup()
      resolve()
    }
    const abort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(finish, ms)
    for (const signal of activeSignals) {
      signal.addEventListener('abort', abort, { once: true })
    }
  })
}

function throwIfAborted(...signals: Array<AbortSignal | undefined>): void {
  if (signals.some((signal) => signal?.aborted)) throw abortError()
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
