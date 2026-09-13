import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostPath } from '../../../shared/host-path'
import {
  SKILLAGER_REFRESH_MS,
  type SkillagerAgent,
  type SkillagerConnection,
  type SkillagerResult,
} from '../../../shared/skillager'
import type {
  SkillagerProjectObservation,
  SkillagerProjectSetup,
} from '../../../shared/skillager-project'
import type { PreparedTerminalSession } from '../terminal/terminal-workspace-model'
import type { TerminalInitialStart } from '../terminal/terminal-runtime-options'

export type SkillagerSetupTerminal = (
  root: HostPath,
  session: PreparedTerminalSession,
  signal: AbortSignal,
) => Promise<void>

/** Project reads and interactive handoffs exist only under this feature's visible demand. */
export function useSkillagerProject(options: {
  readonly connection?: SkillagerConnection
  readonly root?: HostPath
  readonly agent: SkillagerAgent
  readonly demand: boolean
  readonly openTerminal?: SkillagerSetupTerminal
}) {
  const current = useRef(options)
  current.current = options
  const sequence = useRef(0),
    setupSequence = useRef(0),
    generation = useRef(0)
  const pending = useRef<AbortController>(undefined)
  const exitListener = useRef<(() => void) | undefined>(undefined)
  const [read, setRead] = useState<{
    loading: boolean
    result?: SkillagerResult<SkillagerProjectObservation>
  }>({ loading: false })
  const [starting, setStarting] = useState(false)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string>()
  const cancel = useCallback(() => {
    const requestId = ++sequence.current
    void window.hvir
      .invoke('skillager:cancel', { kind: 'project', requestId })
      .catch(() => undefined)
  }, [])
  const refresh = useCallback(async () => {
    const { connection, root, agent, demand } = current.current
    if (!connection || !root || !demand || root.hostId !== 'local') return
    const requestId = ++sequence.current,
      at = generation.current
    setRead((value) => ({ ...value, loading: true }))
    try {
      const result = await window.hvir.invoke('skillager:project-metadata', {
        connectionId: connection.connectionId,
        workspaceRoot: root,
        agent,
        requestId,
      })
      if (at === generation.current && requestId === sequence.current) {
        setRead({ loading: false, result })
        if (result.ok) setRunning(result.value.setupRunning)
      }
    } catch {
      if (at === generation.current && requestId === sequence.current)
        setRead({
          loading: false,
          result: {
            ok: false,
            reason: 'unavailable',
            message: 'Project metadata is unavailable. Refresh to check again.',
          },
        })
    }
  }, [])

  useEffect(() => {
    generation.current++
    pending.current?.abort()
    exitListener.current?.()
    exitListener.current = undefined
    cancel()
    setRead({ loading: false })
    setStarting(false)
    setRunning(false)
    setMessage(undefined)
    return () => {
      pending.current?.abort()
      exitListener.current?.()
      cancel()
    }
  }, [
    options.connection?.connectionId,
    options.root?.hostId,
    options.root?.path,
    options.agent,
    cancel,
  ])

  useEffect(() => {
    if (!options.demand || options.root?.hostId !== 'local') {
      cancel()
      setRead((value) => ({ ...value, loading: false }))
      return
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), SKILLAGER_REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      cancel()
    }
  }, [
    options.demand,
    options.root?.hostId,
    options.root?.path,
    options.connection?.connectionId,
    options.agent,
    refresh,
    cancel,
  ])

  const setup = useCallback(async () => {
    const { connection, root, agent, demand, openTerminal } = current.current
    if (
      !connection ||
      !root ||
      root.hostId !== 'local' ||
      !demand ||
      !openTerminal ||
      pending.current ||
      running
    )
      return
    const controller = new AbortController(),
      at = generation.current
    pending.current = controller
    setStarting(true)
    setMessage(undefined)
    let setupId: string | undefined
    let detachExit: (() => void) | undefined
    const releaseExit = (): void => {
      detachExit?.()
      if (exitListener.current === detachExit) exitListener.current = undefined
      detachExit = undefined
    }
    const release = (): void => {
      if (setupId)
        void window.hvir
          .invoke('skillager:release-project-setup', { setupId })
          .catch(() => undefined)
    }
    controller.signal.addEventListener('abort', release, { once: true })
    const finish = (error?: string, handedOff = false): void => {
      if (pending.current === controller) pending.current = undefined
      controller.signal.removeEventListener('abort', release)
      if (!handedOff) releaseExit()
      if (at === generation.current) {
        setStarting(false)
        if (handedOff) setRunning(true)
        if (error) setMessage(error)
      }
    }
    try {
      const result = await window.hvir.invoke('skillager:prepare-project-setup', {
        connectionId: connection.connectionId,
        workspaceRoot: root,
        agent,
        requestId: ++setupSequence.current,
      })
      if (!result.ok) throw new Error(result.message)
      setupId = result.value.setupId
      if (controller.signal.aborted || at !== generation.current) {
        release()
        finish()
        return
      }
      exitListener.current?.()
      const unsubscribeExit = window.hvir.on('pty:exit', (event) => {
        if (event.id !== result.value.sessionId || at !== generation.current) return
        releaseExit()
        setRunning(false)
        void refresh()
      })
      detachExit = () => {
        void unsubscribeExit()
      }
      exitListener.current = detachExit
      await openTerminal(
        root,
        {
          id: result.value.sessionId,
          profile: result.value.profile,
          title: 'Skillager setup',
          initialStart: initialSetupStart(result.value, controller, release, finish),
        },
        controller.signal,
      )
    } catch (error) {
      release()
      finish(
        error instanceof Error ? error.message : 'The setup terminal could not start.',
      )
    }
  }, [refresh, running])

  return { ...read, refresh, setup, starting, running, message }
}

function initialSetupStart(
  setup: SkillagerProjectSetup,
  controller: AbortController,
  release: () => void,
  finish: (error?: string, handedOff?: boolean) => void,
): TerminalInitialStart {
  let attempted = false,
    handedOff = false
  return {
    start: async (request) => {
      if (attempted || controller.signal.aborted)
        throw new Error('Select Set up in terminal again to start a new setup.')
      attempted = true
      try {
        const result = await window.hvir.invoke('skillager:start-project-setup', {
          setupId: setup.setupId,
          cols: request.cols,
          rows: request.rows,
          position: request.position,
        })
        if (!result.ok) throw new Error(result.message)
        if (controller.signal.aborted) finish()
        else {
          handedOff = true
          finish(undefined, true)
        }
        // A disposed runtime still needs the successful identity to terminate its late PTY.
        return result.value
      } catch (error) {
        release()
        finish(
          error instanceof Error ? error.message : 'The setup terminal could not start.',
        )
        throw error
      }
    },
    cancel: () => {
      if (!handedOff) {
        controller.abort()
        release()
        finish()
      }
    },
  }
}
