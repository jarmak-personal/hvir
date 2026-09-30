import { useEffect, useRef, useState } from 'react'
import type {
  HarnessProfile,
  SessionsProjectionSnapshot,
  SessionsProjectHandle,
  SessionsTerminalHandle,
} from '../../../shared'
import type { SessionsCommandPort, SessionsLaunchChoices } from './sessions-command-port'

export function useSessionsLaunch(
  commands: SessionsCommandPort | undefined,
  snapshot: SessionsProjectionSnapshot,
  foreground: boolean,
  onStarted: (handle: SessionsTerminalHandle) => void,
) {
  const [menu, setMenu] = useState<{
    projectName: string
    choices?: SessionsLaunchChoices
  }>()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string>()
  const request = useRef<AbortController | undefined>(undefined)
  const starting = useRef(false)
  const cancel = (): void => {
    request.current?.abort()
    request.current = undefined
    setMenu(undefined)
    setBusy(false)
    setFeedback(undefined)
  }
  useEffect(() => {
    if (foreground) return
    request.current?.abort()
    request.current = undefined
    setMenu(undefined)
    setBusy(false)
    setFeedback(undefined)
  }, [foreground])
  useEffect(
    () => () => {
      request.current?.abort()
    },
    [],
  )
  const run = async (action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (starting.current) return
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
          error instanceof Error ? error.message : 'The session could not be started.',
        )
    } finally {
      if (request.current === controller) setBusy(false)
    }
  }
  return {
    menu,
    busy,
    feedback,
    cancel,
    open: (project: SessionsProjectHandle, projectName: string) => {
      if (!commands || !foreground) return
      void run(async (signal) => {
        setMenu({ projectName })
        const choices = await commands.launchChoices(project, snapshot, signal)
        signal.throwIfAborted()
        setMenu({ projectName, choices })
      })
    },
    refresh: () => {
      if (!menu?.choices) return
      void run(async (signal) => {
        const choices = await menu.choices!.refresh(signal)
        signal.throwIfAborted()
        setMenu({ ...menu, choices })
      })
    },
    start: (profile: HarnessProfile) => {
      if (!menu?.choices || busy || starting.current) return
      void run(async (signal) => {
        starting.current = true
        try {
          const handle = await menu.choices!.start(profile, signal)
          signal.throwIfAborted()
          setMenu(undefined)
          onStarted(handle)
        } finally {
          starting.current = false
        }
      })
    },
  }
}
