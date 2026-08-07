import { useEffect, useRef } from 'react'

import type {
  KeybindingAction,
  KeybindingContext,
  KeybindingMap,
  WebPaneCommandAction,
} from '../../../shared'
import { keybindingAvailableInContext } from '../../../shared'
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
    const perform = (
      action: WebPaneCommandAction,
      paneId?: string,
      context?: KeybindingContext,
    ): boolean => {
      if (document.querySelector('[aria-modal="true"]')) return false
      return dispatchWorkbenchCommand(action, paneId, portsRef.current, context)
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const action = (Object.entries(keybindings) as [KeybindingAction, string][]).find(
        ([, binding]) => matchesKeybinding(event, binding),
      )?.[0]
      if (!action) return
      const context: KeybindingContext =
        event.target instanceof Element && event.target.closest('.terminal-panel')
          ? 'terminal'
          : event.target instanceof Element && event.target.closest('.web-pane')
            ? 'web-pane'
            : 'workbench'
      if (!keybindingAvailableInContext(action, context)) return
      if (!perform(action, undefined, context)) return
      event.preventDefault()
      // Ghostty owns a target-level key listener. Once a terminal-scoped
      // workbench command is claimed, keep that same stroke out of the PTY.
      if (context === 'terminal') event.stopPropagation()
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
