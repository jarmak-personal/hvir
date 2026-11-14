import type { TerminalLinkActivation } from './terminal-pane'
import { normalizeTerminalWebTarget } from '../../../shared/terminal-link-targets'
import type { HostPath } from '../../../shared/host-path'
import {
  resolveTerminalFileTarget,
  type ResolvedTerminalFileTarget,
} from '../../../shared/terminal-link-targets'

export * from '../../../shared/terminal-link-targets'

/** Surface invalid explicit links at activation, never while scanning output. */
export function activateTerminalFileTarget(
  target: string,
  root: HostPath,
  open: (target: ResolvedTerminalFileTarget) => void,
): void {
  const resolved = resolveTerminalFileTarget(target, root)
  if (resolved) open(resolved)
  else window.alert('Cannot open file link: invalid path or another host')
}

/** Preserve the originating native host while web panes keep their existing workspace fallback. */
export function activateTerminalLink(
  activation: TerminalLinkActivation,
  terminalId: string,
  fallbackRoot: HostPath,
  openPath: (target: ResolvedTerminalFileTarget) => void,
  openWeb: (target: { terminalId: string; workspaceRoot: HostPath; url: string }) => void,
): void {
  const workspaceRoot = activation.workspaceRoot ?? fallbackRoot
  if (activation.kind === 'file') {
    activateTerminalFileTarget(activation.target, workspaceRoot, openPath)
    return
  }
  const url = normalizeTerminalWebTarget(activation.target)
  if (url) openWeb({ terminalId, workspaceRoot, url })
}
