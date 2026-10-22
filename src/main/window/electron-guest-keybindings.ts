import type { WebContents } from 'electron'
import {
  keybindingAvailableInContext,
  matchesKeybinding,
  type KeybindingAction,
  type KeybindingMap,
} from '../../shared/keybindings'

/** Reserved workbench strokes cross a guest's document boundary at the Electron edge. */
export function installGuestWorkbenchKeys(
  guest: WebContents,
  ports: {
    readonly bindings: () => KeybindingMap
    readonly escapeFullPage?: () => boolean
    readonly command: (
      action: KeybindingAction | 'closeGuest' | 'escapeGuestFocus',
    ) => void
  },
): void {
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    const modifier = process.platform === 'darwin' ? input.meta : input.control
    let action: KeybindingAction | 'closeGuest' | 'escapeGuestFocus' | undefined
    if (modifier && input.key.toLowerCase() === 'w' && !input.alt && !input.shift)
      action = 'closeGuest'
    else if (input.key === 'Escape' && ports.escapeFullPage?.())
      action = 'escapeGuestFocus'
    else
      action = (Object.entries(ports.bindings()) as [KeybindingAction, string][]).find(
        ([candidate, binding]) =>
          keybindingAvailableInContext(candidate, 'web-pane') &&
          matchesKeybinding(
            {
              key: input.key,
              code: input.code,
              ctrlKey: input.control,
              metaKey: input.meta,
              altKey: input.alt,
              shiftKey: input.shift,
            },
            binding,
            process.platform === 'darwin',
          ),
      )?.[0]
    if (!action) return
    event.preventDefault()
    ports.command(action)
  })
}
