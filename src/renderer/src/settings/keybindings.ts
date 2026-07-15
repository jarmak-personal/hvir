export const KEYBINDING_ACTIONS = [
  'cycleViewMode',
  'focusTerminal',
  'focusViewer',
  'focusTree',
  'toggleTerminalFocus',
  'nextWorkspace',
  'previousWorkspace',
] as const

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number]
export type KeybindingMap = Readonly<Record<KeybindingAction, string>>

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  cycleViewMode: 'Mod+Shift+M',
  focusTerminal: 'Mod+J',
  focusViewer: 'Mod+1',
  focusTree: 'Mod+0',
  toggleTerminalFocus: 'Mod+Shift+J',
  nextWorkspace: 'Mod+Alt+]',
  previousWorkspace: 'Mod+Alt+[',
}

interface KeyboardStroke {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

interface ParsedKeybinding {
  readonly key: string
  readonly mod: boolean
  readonly ctrl: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
}

export function parseKeybindingOverrides(value: unknown): KeybindingMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Keybindings must be a JSON object')
  }
  const overrides = value as Record<string, unknown>
  const unknown = Object.keys(overrides).find(
    (key) => !KEYBINDING_ACTIONS.includes(key as KeybindingAction),
  )
  if (unknown) throw new Error(`Unknown keybinding action: ${unknown}`)
  const bindings = { ...DEFAULT_KEYBINDINGS }
  for (const action of KEYBINDING_ACTIONS) {
    const candidate = overrides[action]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string') {
      throw new Error(`${action} must be a keybinding string`)
    }
    parseKeybinding(candidate)
    bindings[action] = candidate
  }
  return bindings
}

export function keybindingOverridesJson(bindings: KeybindingMap): string {
  return JSON.stringify(bindings, null, 2)
}

export function matchesKeybinding(
  event: KeyboardStroke,
  binding: string,
  mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform),
): boolean {
  const parsed = parseKeybinding(binding)
  const modDown = mac ? event.metaKey : event.ctrlKey
  return (
    event.key.toLowerCase() === parsed.key.toLowerCase() &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift &&
    event.ctrlKey === (parsed.ctrl || (parsed.mod && !mac)) &&
    event.metaKey === (parsed.meta || (parsed.mod && mac)) &&
    (!parsed.mod || modDown)
  )
}

function parseKeybinding(binding: string): ParsedKeybinding {
  const parts = binding
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const key = parts.at(-1)
  if (!key || parts.length < 2 || key.length > 12) {
    throw new Error(`Invalid keybinding: ${binding}`)
  }
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase())
  const allowed = new Set(['mod', 'ctrl', 'meta', 'alt', 'shift'])
  if (
    modifiers.some((modifier) => !allowed.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    throw new Error(`Invalid keybinding: ${binding}`)
  }
  return {
    key,
    mod: modifiers.includes('mod'),
    ctrl: modifiers.includes('ctrl'),
    meta: modifiers.includes('meta'),
    alt: modifiers.includes('alt'),
    shift: modifiers.includes('shift'),
  }
}
