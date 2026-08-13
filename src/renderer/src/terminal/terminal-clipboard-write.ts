import { decodeClipboardOsc, type ClipboardOscWrite } from './terminal-clipboard-osc'

/**
 * OSC 52 lets the program on the far end of the PTY place text on the
 * application host's clipboard, which is how a copy in a remote tmux reaches
 * the local machine. Deciding whether to honor the sequence and what text it
 * means is policy; the clipboard itself is a main-process resource, so only the
 * decoded text crosses IPC to be written there.
 */
export function writeClipboardFromOsc(event: ClipboardOscWrite): void {
  const decision = decodeClipboardOsc(event)
  if (decision.kind === 'refused') return
  window.hvir.send('terminal:clipboard-write', { text: decision.text })
}
