import {
  asHostId,
  hostPath,
  type HostPath,
  type TerminalAdapterId,
  type TerminalLayoutEntry,
  type TerminalRecoverySession,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const FILE_VERSION = 1
const TERMINAL_ID = /^[a-zA-Z0-9-]{1,80}$/
const MAX_SESSIONS = 500
const MAX_TITLE_LENGTH = 512

interface StoredTerminalSession {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly harnessSessionId?: string
  readonly hostId: string
  readonly projectRoot: HostPath
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
  readonly updatedAt: number
}

interface StoredFile {
  readonly version: typeof FILE_VERSION
  readonly sessions: readonly StoredTerminalSession[]
}

export interface RecordTerminalSpawn {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly harnessSessionId?: string
  readonly projectRoot: HostPath
  readonly cwd: HostPath
  readonly title: string
  readonly position: number
  readonly active: boolean
}

export interface AuthorizeTerminalResume {
  readonly id: string
  readonly adapterId: TerminalAdapterId
  readonly harnessSessionId: string
  readonly projectRoot: HostPath
  readonly cwd: HostPath
}

export interface TerminalSessionStore {
  list(projectRoot: HostPath): readonly TerminalRecoverySession[]
  recordSpawn(spawn: RecordTerminalSpawn): Promise<void>
  recordIdentity(id: string, harnessSessionId: string): Promise<void>
  updateLayout(
    projectRoot: HostPath,
    layout: readonly TerminalLayoutEntry[],
  ): Promise<void>
  forget(projectRoot: HostPath, id: string): Promise<void>
  authorizeResume(request: AuthorizeTerminalResume): boolean
  flush(): Promise<void>
}

export class TerminalSessionRegistry implements TerminalSessionStore {
  private readonly sessions = new Map<string, StoredTerminalSession>()
  private readonly forgotten = new Set<string>()
  private readonly pendingIdentities = new Map<string, string>()
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly host: ProjectHost,
    private readonly file: HostPath,
    sessions: readonly StoredTerminalSession[],
  ) {
    for (const session of sessions.slice(-MAX_SESSIONS)) {
      this.sessions.set(session.id, session)
    }
  }

  static async load(host: ProjectHost, file: HostPath): Promise<TerminalSessionRegistry> {
    let sessions: StoredTerminalSession[] = []
    try {
      const value: unknown = JSON.parse(await host.readTextFile(file))
      if (isRecord(value) && value['version'] === FILE_VERSION) {
        const rawSessions = value['sessions']
        if (Array.isArray(rawSessions)) {
          sessions = rawSessions
            .map(parseStoredSession)
            .filter((session): session is StoredTerminalSession => Boolean(session))
        }
      }
    } catch {
      sessions = []
    }
    return new TerminalSessionRegistry(host, file, sessions)
  }

  list(projectRoot: HostPath): readonly TerminalRecoverySession[] {
    return [...this.sessions.values()]
      .filter((session) => hostPathEquals(session.projectRoot, projectRoot))
      .sort(
        (left, right) =>
          left.position - right.position || left.updatedAt - right.updatedAt,
      )
      .map(({ projectRoot: _projectRoot, ...session }) => session)
  }

  recordSpawn(spawn: RecordTerminalSpawn): Promise<void> {
    if (this.forgotten.has(spawn.id)) {
      this.pendingIdentities.delete(spawn.id)
      return Promise.resolve()
    }
    const harnessSessionId =
      spawn.harnessSessionId ?? this.pendingIdentities.get(spawn.id)
    this.pendingIdentities.delete(spawn.id)
    const now = Date.now()
    this.sessions.set(spawn.id, {
      id: spawn.id,
      adapterId: spawn.adapterId,
      harnessSessionId,
      hostId: spawn.cwd.hostId,
      projectRoot: spawn.projectRoot,
      cwd: spawn.cwd,
      title: cleanTitle(spawn.title),
      position: cleanPosition(spawn.position),
      active: spawn.active,
      updatedAt: now,
    })
    return this.persist()
  }

  recordIdentity(id: string, harnessSessionId: string): Promise<void> {
    if (
      this.forgotten.has(id) ||
      !TERMINAL_ID.test(id) ||
      !isHarnessSessionId(harnessSessionId)
    ) {
      return Promise.resolve()
    }
    const current = this.sessions.get(id)
    if (!current) {
      if (this.pendingIdentities.size >= MAX_SESSIONS) {
        const oldest = this.pendingIdentities.keys().next().value
        if (oldest !== undefined) this.pendingIdentities.delete(oldest)
      }
      this.pendingIdentities.set(id, harnessSessionId)
      return Promise.resolve()
    }
    this.sessions.set(id, {
      ...current,
      harnessSessionId,
      updatedAt: Date.now(),
    })
    return this.persist()
  }

  updateLayout(
    projectRoot: HostPath,
    layout: readonly TerminalLayoutEntry[],
  ): Promise<void> {
    let changed = false
    for (const item of layout.slice(0, MAX_SESSIONS)) {
      const current = this.sessions.get(item.id)
      if (!current || !hostPathEquals(current.projectRoot, projectRoot)) continue
      const next = {
        ...current,
        title: cleanTitle(item.title),
        position: cleanPosition(item.position),
        active: item.active,
        updatedAt: Date.now(),
      }
      this.sessions.set(item.id, next)
      changed = true
    }
    return changed ? this.persist() : Promise.resolve()
  }

  forget(projectRoot: HostPath, id: string): Promise<void> {
    const current = this.sessions.get(id)
    if (current && !hostPathEquals(current.projectRoot, projectRoot)) {
      return Promise.resolve()
    }
    this.forgotten.add(id)
    this.pendingIdentities.delete(id)
    if (!current) return Promise.resolve()
    this.sessions.delete(id)
    return this.persist()
  }

  authorizeResume(request: AuthorizeTerminalResume): boolean {
    const stored = this.sessions.get(request.id)
    return Boolean(
      stored &&
      stored.adapterId === request.adapterId &&
      stored.harnessSessionId === request.harnessSessionId &&
      hostPathEquals(stored.projectRoot, request.projectRoot) &&
      hostPathEquals(stored.cwd, request.cwd),
    )
  }

  flush(): Promise<void> {
    return this.pendingWrite
  }

  private persist(): Promise<void> {
    const snapshot: StoredFile = {
      version: FILE_VERSION,
      sessions: [...this.sessions.values()].slice(-MAX_SESSIONS),
    }
    const write = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.host.writeFile(this.file, JSON.stringify(snapshot, null, 2)))
    this.pendingWrite = write
    return write
  }
}

function parseStoredSession(value: unknown): StoredTerminalSession | undefined {
  if (!isRecord(value)) return undefined
  const id = value['id']
  const adapterId = value['adapterId']
  const harnessSessionId = value['harnessSessionId']
  const hostId = value['hostId']
  const projectRoot = parsePath(value['projectRoot'])
  const cwd = parsePath(value['cwd'])
  const title = value['title']
  const position = value['position']
  const active = value['active']
  const updatedAt = value['updatedAt']
  if (
    typeof id !== 'string' ||
    !TERMINAL_ID.test(id) ||
    !isAdapterId(adapterId) ||
    (harnessSessionId !== undefined &&
      (typeof harnessSessionId !== 'string' || !isHarnessSessionId(harnessSessionId))) ||
    typeof hostId !== 'string' ||
    !projectRoot ||
    !cwd ||
    projectRoot.hostId !== hostId ||
    cwd.hostId !== hostId ||
    typeof title !== 'string' ||
    title.length > MAX_TITLE_LENGTH ||
    typeof position !== 'number' ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position >= MAX_SESSIONS ||
    typeof active !== 'boolean' ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0
  ) {
    return undefined
  }
  return {
    id,
    adapterId,
    harnessSessionId,
    hostId,
    projectRoot,
    cwd,
    title,
    position,
    active,
    updatedAt,
  }
}

function parsePath(value: unknown): HostPath | undefined {
  if (!isRecord(value)) return undefined
  const hostId = value['hostId']
  const path = value['path']
  if (
    typeof hostId !== 'string' ||
    hostId.length === 0 ||
    hostId.length > 255 ||
    /\s/.test(hostId) ||
    hasControlCharacter(hostId) ||
    typeof path !== 'string' ||
    !path.startsWith('/')
  ) {
    return undefined
  }
  return hostPath(asHostId(hostId), path)
}

function isAdapterId(value: unknown): value is TerminalAdapterId {
  return value === 'plain-shell' || value === 'claude-code' || value === 'codex'
}

function cleanTitle(value: string): string {
  const title = [...value]
    .map((character) => (hasControlCharacter(character) ? ' ' : character))
    .join('')
    .trim()
  return title.slice(0, MAX_TITLE_LENGTH) || 'Terminal'
}

function isHarnessSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function cleanPosition(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(MAX_SESSIONS - 1, Math.floor(value)))
}

function hostPathEquals(left: HostPath, right: HostPath): boolean {
  return left.hostId === right.hostId && left.path === right.path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
