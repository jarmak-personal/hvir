import {
  hostPathEquals,
  isTerminalTitleText,
  type HostPath,
  type TerminalName,
} from '../../shared'
import type { OwnedTerminalSession } from './session-registry'

export async function renameTerminalSession(
  {
    id,
    root,
    expectedRevision,
    customName,
    assertCurrent,
  }: {
    readonly id: string
    readonly root: HostPath
    readonly expectedRevision: number
    readonly customName: string
    readonly assertCurrent: () => void
  },
  {
    sessions,
    pending,
    persist,
    publish,
  }: {
    readonly sessions: Map<string, OwnedTerminalSession>
    readonly pending: Map<string, TerminalName>
    readonly persist: () => Promise<void>
    readonly publish: () => void
  },
): Promise<OwnedTerminalSession> {
  assertCurrent()
  const prior = sessions.get(id)
  if (
    !prior ||
    !hostPathEquals(prior.workspaceRoot, root) ||
    (prior.nameRevision ?? 0) !== expectedRevision
  ) {
    throw new Error('The session or its name changed. Reopen Rename and try again.')
  }
  if (!isTerminalTitleText(customName, true)) throw new Error('Invalid session name')
  if (pending.has(id))
    throw new Error('A name is already being saved. Try again shortly.')
  pending.set(id, { customName: prior.customName, nameRevision: prior.nameRevision })
  const nameRevision = expectedRevision + 1
  sessions.set(id, {
    ...prior,
    customName: customName.trim() || undefined,
    nameRevision,
  })
  try {
    await persist()
    assertCurrent()
    const current = sessions.get(id)
    if (
      !current ||
      !hostPathEquals(current.workspaceRoot, root) ||
      current.nameRevision !== nameRevision
    ) {
      throw new Error('The session or its name changed before Rename completed.')
    }
    pending.delete(id)
    publish()
    return { ...current }
  } catch (error) {
    const current = sessions.get(id)
    if (current?.nameRevision === nameRevision) {
      sessions.set(id, {
        ...current,
        customName: prior.customName,
        nameRevision: prior.nameRevision,
      })
      await persist().catch(() => undefined)
    }
    pending.delete(id)
    publish()
    throw error
  }
}
