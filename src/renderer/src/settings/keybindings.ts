import {
  matchesKeybinding as matchesSharedKeybinding,
  type KeyboardStroke,
} from '../../../shared'

export {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  keybindingOverridesJson,
  parseKeybindingOverrides,
  type KeybindingAction,
  type KeybindingMap,
} from '../../../shared'

export function matchesKeybinding(
  event: KeyboardStroke,
  binding: string,
  mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform),
): boolean {
  return matchesSharedKeybinding(event, binding, mac)
}
