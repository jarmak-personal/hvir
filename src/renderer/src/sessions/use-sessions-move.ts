import { useEffect, useRef, useState } from 'react'
import type {
  SessionsProjectionRow,
  SessionsProjectionSnapshot,
  TerminalMovePlan,
} from '../../../shared'
import type { SessionsCommandPort, SessionsMoveChoice } from './sessions-command-port'

export function useSessionsMove(
  commands: SessionsCommandPort | undefined,
  row: SessionsProjectionRow | undefined,
  snapshot: SessionsProjectionSnapshot,
  foreground: boolean,
) {
  const [targets, setTargets] = useState<readonly SessionsMoveChoice[]>()
  const [pending, setPending] = useState<{
    row: SessionsProjectionRow
    plan: TerminalMovePlan
  }>()
  const [feedback, setFeedback] = useState<string>()
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | undefined>(undefined)
  const cancel = (): void => {
    request.current?.abort()
    request.current = undefined
    setTargets(undefined)
    setPending(undefined)
    setBusy(false)
  }
  useEffect(() => {
    request.current?.abort()
    request.current = undefined
    setTargets(undefined)
    setPending(undefined)
    setBusy(false)
  }, [foreground, row?.handle, row?.workspace.id, row?.livePty?.handle])
  useEffect(() => {
    if (!targets) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setTargets(undefined)
        event.preventDefault()
      }
    }
    document.addEventListener('keydown', close, true)
    return () => document.removeEventListener('keydown', close, true)
  }, [targets])
  useEffect(
    () => () => {
      request.current?.abort()
    },
    [],
  )
  const run = async (
    action: (signal: AbortSignal) => Promise<void>,
    propagate = false,
  ): Promise<void> => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setFeedback(undefined)
    try {
      await action(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted)
        setFeedback(
          error instanceof Error ? error.message : 'The workspace could not be changed.',
        )
      if (propagate && !controller.signal.aborted) throw error
    } finally {
      if (request.current === controller) setBusy(false)
    }
  }
  return {
    targets,
    pending,
    feedback,
    busy,
    cancel,
    open: () => {
      if (!commands || !row || !foreground || busy) return
      setFeedback(undefined)
      try {
        const choices = commands.moveChoices(row, snapshot)
        if (choices.length === 0)
          setFeedback('No other open workspaces are available in this project.')
        else setTargets(targets ? undefined : choices)
      } catch (error) {
        setFeedback(
          error instanceof Error ? error.message : 'The session is no longer available.',
        )
      }
    },
    plan: (targetId: string) => {
      if (!commands || !row || busy) return
      setTargets(undefined)
      void run(async (signal) => {
        const plan = await commands.planMove(row, snapshot, targetId, signal)
        signal.throwIfAborted()
        setPending({ row, plan })
      })
    },
    confirm: async () => {
      if (!commands || !pending || busy) return
      await run(async (signal) => {
        await commands.move(pending.row, pending.plan, signal)
        signal.throwIfAborted()
        setPending(undefined)
      }, true)
    },
  }
}
