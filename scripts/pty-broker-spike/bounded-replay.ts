import type { BrokerReplayChunk } from './protocol.ts'

interface StoredChunk extends BrokerReplayChunk {
  readonly id: number
  readonly bytes: number
  active: boolean
}

interface SessionReplay {
  readonly chunks: StoredChunk[]
  bytes: number
  droppedBytes: number
}

export interface ReplaySnapshot {
  readonly chunks: readonly BrokerReplayChunk[]
  readonly bytes: number
  readonly droppedBytes: number
}

/**
 * One broker-wide replay owner. Per-session eviction happens before global
 * eviction, and both limits remove oldest complete chunks.
 */
export class BoundedReplayStore {
  readonly perSessionLimit: number
  readonly globalLimit: number
  private readonly sessions = new Map<string, SessionReplay>()
  private readonly globalOrder: StoredChunk[] = []
  private globalHead = 0
  private globalBytes = 0
  private nextId = 1

  constructor(perSessionLimit: number, globalLimit: number) {
    if (
      !Number.isSafeInteger(perSessionLimit) ||
      !Number.isSafeInteger(globalLimit) ||
      perSessionLimit < 1 ||
      globalLimit < perSessionLimit
    ) {
      throw new Error('Invalid replay limits')
    }
    this.perSessionLimit = perSessionLimit
    this.globalLimit = globalLimit
  }

  append(sessionId: string, sequence: number, data: string): void {
    let normalized = data
    let bytes = Buffer.byteLength(normalized, 'utf8')
    const session = this.session(sessionId)
    if (bytes > this.perSessionLimit) {
      const encoded = Buffer.from(normalized, 'utf8')
      normalized = encoded
        .subarray(encoded.length - this.perSessionLimit)
        .toString('utf8')
      bytes = Buffer.byteLength(normalized, 'utf8')
      while (bytes > this.perSessionLimit && normalized.length > 0) {
        normalized = normalized.slice(1)
        bytes = Buffer.byteLength(normalized, 'utf8')
      }
      session.droppedBytes += encoded.length - bytes
    }
    const chunk: StoredChunk = {
      id: this.nextId++,
      sequence,
      data: normalized,
      bytes,
      active: true,
    }
    session.chunks.push(chunk)
    session.bytes += bytes
    this.globalOrder.push(chunk)
    this.globalBytes += bytes
    this.enforceSession(session)
    this.enforceGlobal()
  }

  snapshot(sessionId: string, afterSequence = 0): ReplaySnapshot {
    const session = this.sessions.get(sessionId)
    if (!session) return { chunks: [], bytes: 0, droppedBytes: 0 }
    const chunks = session.chunks
      .filter((chunk) => chunk.active && chunk.sequence > afterSequence)
      .map(({ sequence, data }) => ({ sequence, data }))
    return {
      chunks,
      bytes: chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.data), 0),
      droppedBytes: session.droppedBytes,
    }
  }

  status(sessionId: string): { readonly bytes: number; readonly droppedBytes: number } {
    const session = this.sessions.get(sessionId)
    return session
      ? { bytes: session.bytes, droppedBytes: session.droppedBytes }
      : { bytes: 0, droppedBytes: 0 }
  }

  delete(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    for (const chunk of session.chunks) this.deactivate(chunk, session, false)
    this.sessions.delete(sessionId)
    this.compactGlobalOrder()
  }

  totalBytes(): number {
    return this.globalBytes
  }

  private session(sessionId: string): SessionReplay {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = { chunks: [], bytes: 0, droppedBytes: 0 }
      this.sessions.set(sessionId, session)
    }
    return session
  }

  private enforceSession(session: SessionReplay): void {
    while (session.bytes > this.perSessionLimit) {
      const chunk = session.chunks.shift()
      if (!chunk) break
      this.deactivate(chunk, session, true)
    }
  }

  private enforceGlobal(): void {
    while (this.globalBytes > this.globalLimit) {
      const chunk = this.nextGlobalChunk()
      if (!chunk) break
      const session = this.sessionContaining(chunk)
      if (!session) continue
      const index = session.chunks.findIndex((candidate) => candidate.id === chunk.id)
      if (index >= 0) session.chunks.splice(index, 1)
      this.deactivate(chunk, session, true)
    }
    this.compactGlobalOrder()
  }

  private nextGlobalChunk(): StoredChunk | undefined {
    while (this.globalHead < this.globalOrder.length) {
      const chunk = this.globalOrder[this.globalHead++]
      if (chunk?.active) return chunk
    }
    return undefined
  }

  private sessionContaining(chunk: StoredChunk): SessionReplay | undefined {
    for (const session of this.sessions.values()) {
      if (session.chunks.some((candidate) => candidate.id === chunk.id)) return session
    }
    return undefined
  }

  private deactivate(
    chunk: StoredChunk,
    session: SessionReplay,
    countAsDropped: boolean,
  ): void {
    if (!chunk.active) return
    chunk.active = false
    session.bytes -= chunk.bytes
    this.globalBytes -= chunk.bytes
    if (countAsDropped) session.droppedBytes += chunk.bytes
  }

  private compactGlobalOrder(): void {
    if (this.globalHead < 1024 || this.globalHead < this.globalOrder.length / 2) return
    this.globalOrder.splice(0, this.globalHead)
    this.globalHead = 0
  }
}
