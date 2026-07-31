import type {
  AssistantOutputEvent,
  HarnessProviderCapabilities,
  HostPath,
  TerminalIdentityStatus,
} from '../../../shared'
import { RichOutputCoordinator, type RichOutputSnapshot } from './rich-output-coordinator'
import { resolveTerminalFileTarget } from './terminal-file-link'

interface TerminalRichOutputRuntimeOptions {
  readonly activePtyId: () => string | undefined
  readonly workspaceRoot: () => HostPath
  readonly onChange: (snapshot: RichOutputSnapshot) => void
}

/** Adapts the generic rich coordinator to one terminal runtime's typed ports. */
export class TerminalRichOutputRuntime {
  private capabilities: HarnessProviderCapabilities
  private readonly coordinator: RichOutputCoordinator

  constructor(
    capabilities: HarnessProviderCapabilities,
    options: TerminalRichOutputRuntimeOptions,
  ) {
    this.capabilities = capabilities
    this.coordinator = new RichOutputCoordinator({
      setMode: (enabled) => {
        const id = options.activePtyId()
        return id
          ? window.hvir.invoke('pty:set-assistant-output-mode', { id, enabled })
          : Promise.resolve(false)
      },
      resolveFileLink: (target) => {
        if (!target.startsWith('file:')) return undefined
        const resolved = resolveTerminalFileTarget(
          target.slice('file:'.length),
          options.workspaceRoot(),
        )
        if (!resolved) return undefined
        const position =
          resolved.line === undefined
            ? ''
            : `:${resolved.line}${resolved.column === undefined ? '' : `:${resolved.column}`}`
        return { kind: 'file', target: `${resolved.path.path}${position}` }
      },
      onChange: options.onChange,
    })
  }

  snapshot(): RichOutputSnapshot {
    return this.coordinator.snapshot()
  }

  configure(
    capabilities: HarnessProviderCapabilities,
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus | undefined,
  ): void {
    this.capabilities = capabilities
    this.coordinator.configure(capabilities, harnessSessionId, identityStatus)
  }

  acceptIdentity(
    harnessSessionId: string | undefined,
    identityStatus: TerminalIdentityStatus,
  ): void {
    this.coordinator.configure(this.capabilities, harnessSessionId, identityStatus)
  }

  accept(event: AssistantOutputEvent): void {
    this.coordinator.accept(event)
  }

  setEnabled(enabled: boolean): Promise<boolean> {
    return this.coordinator.setEnabled(enabled)
  }

  setWidth(width: number): void {
    this.coordinator.setWidth(width)
  }

  reset(): void {
    this.coordinator.reset()
  }

  dispose(): void {
    this.coordinator.dispose()
  }
}
