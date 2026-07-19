import { useEffect, useRef } from 'react'

import type {
  KeybindingAction,
  KeybindingMap,
  WebPaneCommandAction,
} from '../../../shared'
import { matchesKeybinding } from '../settings/keybindings'
import {
  dispatchWorkbenchCommand,
  type WorkbenchCommandPorts,
} from './workbench-command-router'

export function useWorkbenchCommands(
  keybindings: KeybindingMap,
  ports: WorkbenchCommandPorts,
): void {
  const portsRef = useRef(ports)
  portsRef.current = ports

  useEffect(() => {
    const perform = (action: WebPaneCommandAction, paneId?: string): void => {
      if (document.querySelector('[aria-modal="true"]')) return
      dispatchWorkbenchCommand(action, paneId, portsRef.current)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const action = (Object.entries(keybindings) as [KeybindingAction, string][]).find(
        ([, binding]) => matchesKeybinding(event, binding),
      )?.[0]
      if (!action) return
      if (
        action === 'cycleViewMode' &&
        event.target instanceof Element &&
        event.target.closest('.terminal-panel')
      ) {
        return
      }
      event.preventDefault()
      perform(action)
    }
    window.hvir.send('web-pane:reserved-bindings', keybindings)
    const disposeCommand = window.hvir.on('web-pane:command', ({ action, paneId }) =>
      perform(action, paneId),
    )
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      void disposeCommand()
    }
  }, [keybindings])
}
