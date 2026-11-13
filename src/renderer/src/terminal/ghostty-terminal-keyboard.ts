import { providerComposerKeySequence } from '../../../shared/composer-submit'
import type { ComposerSubmitMode, HarnessModifiedKeyProtocol } from '../../../shared'

export interface GhosttyKeyboardEvent {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

export interface GhosttyKeyboardOptions {
  /** The foreground harness's modified-key wire format. */
  readonly modifiedKeyProtocol: HarnessModifiedKeyProtocol
  readonly metaEnterAliasesControl: boolean
  readonly composerSubmitMode: ComposerSubmitMode
}

const DEFAULT_KEYBOARD_OPTIONS: GhosttyKeyboardOptions = {
  modifiedKeyProtocol: 'none',
  metaEnterAliasesControl: false,
  composerSubmitMode: 'enter',
}

const SHIFTED_SPECIAL_SEQUENCES: Readonly<Record<string, string>> = {
  Enter: '\x1b[27;2;13~',
  Tab: '\x1b[Z',
  Escape: '\x1b[27;2;27~',
  Home: '\x1b[1;2H',
  End: '\x1b[1;2F',
  Insert: '\x1b[2;2~',
  Delete: '\x1b[3;2~',
  PageUp: '\x1b[5;2~',
  PageDown: '\x1b[6;2~',
  F1: '\x1b[1;2P',
  F2: '\x1b[1;2Q',
  F3: '\x1b[13;2~',
  F4: '\x1b[1;2S',
  F5: '\x1b[15;2~',
  F6: '\x1b[17;2~',
  F7: '\x1b[18;2~',
  F8: '\x1b[19;2~',
  F9: '\x1b[20;2~',
  F10: '\x1b[21;2~',
  F11: '\x1b[23;2~',
  F12: '\x1b[24;2~',
}

/**
 * Restore terminal sequences that ghostty-web 0.4 drops or collapses before
 * its key encoder runs. Keep this adapter-specific until upstream handles the
 * same chords itself.
 */
export function ghosttyKeyboardOverride(
  event: GhosttyKeyboardEvent,
  options: GhosttyKeyboardOptions = DEFAULT_KEYBOARD_OPTIONS,
): string | undefined {
  const composer = providerComposerKeySequence(event, options)
  if (composer !== undefined) return composer

  if (event.ctrlKey || event.altKey || event.metaKey || !event.shiftKey) {
    return undefined
  }

  if (
    options.modifiedKeyProtocol !== 'modify-other-keys' &&
    (event.code === 'Enter' || event.code === 'Escape')
  ) {
    return undefined
  }

  return SHIFTED_SPECIAL_SEQUENCES[event.code]
}

/** Preserve the exact wire fallback while surfacing an explicit paste gesture. */
export function ghosttyClipboardPasteFallback(
  event: GhosttyKeyboardEvent,
): string | undefined {
  if (event.code !== 'KeyV' || !event.ctrlKey || event.metaKey || event.shiftKey) {
    return undefined
  }
  return event.altKey ? '\x1b\x16' : '\x16'
}
