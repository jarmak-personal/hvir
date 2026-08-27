import { useEffect, useRef, useSyncExternalStore } from 'react'

import type { SessionsProjectionSnapshot } from '../../../shared'
import {
  SessionsTerminalDetailController,
  createSessionsTerminalResolutionPort,
} from './sessions-terminal-detail-controller'
import type { SessionsTerminalSurfacePort } from './sessions-terminal-surface'

export function useSessionsTerminalDetail({
  surface,
  snapshot,
  foreground,
}: {
  readonly surface: SessionsTerminalSurfacePort
  readonly snapshot: SessionsProjectionSnapshot
  readonly foreground: boolean
}) {
  const reference = useRef<SessionsTerminalDetailController | undefined>(undefined)
  reference.current ??= new SessionsTerminalDetailController(
    createSessionsTerminalResolutionPort(window.hvir),
    surface,
    window,
  )
  const controller = reference.current
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )
  useEffect(
    () => controller.synchronize(snapshot, foreground),
    [controller, foreground, snapshot],
  )
  useEffect(() => () => controller.dispose(), [controller])
  return { controller, state }
}
