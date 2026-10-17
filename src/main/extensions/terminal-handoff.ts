import { dialog, BrowserWindow, webContents } from 'electron'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ExtensionActionOwner } from './action-owner'
import type { ExtensionActivation } from './activation'
import type { ExtensionGuestAuthority } from './guest-authority'
import type { AdmittedExtensionContext } from './context-owner'
import type { ExtensionConnectorApprovalOwner } from './connector-approval'
import { canonicalExecutablePath } from './connector-approval'
import { connectorArguments } from '../../shared/extensions/connectors'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import {
  EXTENSION_LIMITS,
  type ExtensionInvocation,
} from '../../shared/extensions/contract'
import type {
  TerminalCommandHandoffOwner,
  TerminalCommandOutcome,
} from '../terminal/command-handoff-owner'

export interface TerminalHandoffCaller {
  readonly owner: RendererOwner
  readonly view: string
  readonly activation: ExtensionActivation
  readonly authority: ExtensionGuestAuthority
  readonly context?: AdmittedExtensionContext
}
interface LaunchDecision {
  readonly command: string
  readonly destination: string
  readonly details: string
}
export type ConfirmTerminalLaunch = (
  decision: LaunchDecision,
  signal: AbortSignal,
  owner: RendererOwner,
) => Promise<boolean>

/** Native launch decision grants exactly one command/destination, never whole guest authority. */
export const confirmTerminalLaunch: ConfirmTerminalLaunch = async (
  decision,
  signal,
  owner,
) => {
  signal.throwIfAborted()
  const contents = webContents.fromId(owner.id)
  const window = contents ? BrowserWindow.fromWebContents(contents) : undefined
  if (!window || window.isDestroyed())
    throw new Error('Terminal launch window was revoked')
  const result = await dialog.showMessageBox(window, {
    signal,
    type: 'question',
    buttons: ['Cancel', 'Open new terminal'],
    defaultId: 0,
    cancelId: 0,
    title: 'Open a command in a new terminal',
    message: decision.command,
    detail: `${decision.destination}\n\nThe command runs once, then an ordinary shell remains under your control. Native execution has your host account's authority.\n\n${decision.details}`,
  })
  signal.throwIfAborted()
  return result.response === 1
}

/** Public command data adapts admitted action provenance to the existing terminal owner. */
export class ExtensionTerminalHandoff {
  private readonly used = new Map<string, () => void>()
  constructor(
    private readonly approvals: ExtensionConnectorApprovalOwner,
    private readonly terminals: TerminalCommandHandoffOwner,
    private readonly actions: Pick<ExtensionActionOwner, 'provenance' | 'authority'>,
    private readonly confirm: ConfirmTerminalLaunch = confirmTerminalLaunch,
  ) {}

  async start(
    caller: TerminalHandoffCaller,
    value: unknown,
    invocation: ExtensionInvocation | undefined,
    current: () => void,
    signal: AbortSignal,
  ): Promise<TerminalCommandOutcome> {
    current()
    signal.throwIfAborted()
    if (!invocation || !this.actions.provenance(caller.view, invocation.id))
      throw new Error('A current explicit action is required for a terminal handoff')
    for (const [id, check] of this.used) {
      try {
        check()
      } catch {
        this.used.delete(id)
      }
    }
    if (this.used.has(invocation.id))
      throw new Error('This action already requested its terminal')
    if (this.used.size >= 16) throw new Error('Terminal action admission is full')
    this.used.set(invocation.id, current)
    const input = extensionObject(value),
      connector = extensionText(input['connector'], 'connector', 80),
      workspace = extensionText(input['workspace'], 'workspace', 160)
    const args = connectorArguments(input['args'])
    const approval = this.approvals.get(caller.activation, connector)
    const context = caller.context,
      root = context?.root
    if (
      !approval ||
      approval.declaration.context !== 'workspace' ||
      !root ||
      workspace !== context.value.workspace?.id ||
      root.hostId !== approval.host ||
      approval.host !== 'local'
    )
      throw new Error(
        'Select the exact local workspace and approve its installed workspace connector',
      )
    const authority = this.actions.authority(caller.view, invocation.id)
    const assert = () => {
      current()
      signal.throwIfAborted()
      if (!context.current() || !this.approvals.current(caller.activation, approval))
        throw new Error('Terminal command approval or destination changed')
      authority?.assertCapability('terminal.start', approval.host, workspace)
      caller.authority
        .forAction(invocation.action)
        ?.assertCapability('terminal.start', approval.host, workspace)
    }
    const host = this.approvals.hosts.hostById(approval.host)
    if (!host) throw new Error('Terminal host is unavailable')
    const revalidate = async () => {
      assert()
      const canonical = await canonicalExecutablePath(host, approval.executable)
      assert()
      if (canonical !== approval.canonicalExecutable)
        throw new Error('Installed terminal command changed; approve it again')
    }
    const command = {
      executable: approval.canonicalExecutable,
      args: [...approval.configuration.args, ...args],
      environment: { ...approval.configuration.env },
    }
    return this.terminals.request({
      owner: caller.owner,
      workspaceId: workspace,
      root,
      command,
      current: assert,
      revalidate,
      signal,
      decisionTimeoutMs:
        caller.activation.revision.manifest.actions?.find(
          (action) => action.id === invocation.action,
        )?.timeoutMs ?? EXTENSION_LIMITS.actionTimeoutMs,
      prepare: async (decisionSignal) => {
        await revalidate()
        decisionSignal.throwIfAborted()
        if (invocation.caller === 'agent') {
          if (!['standing', 'interactive'].includes(invocation.authorization))
            throw new Error(
              'Agent terminal handoff needs admitted standing or interactive authorization',
            )
        } else if (
          !(await this.confirm(
            {
              command: `Run ${command.executable.split('/').at(-1)} once in a new terminal`,
              destination: `${root.hostId}: ${root.path}`,
              details: JSON.stringify(
                {
                  executable: command.executable,
                  arguments: command.args,
                  configuration: command.environment,
                  workspace,
                },
                null,
                2,
              ),
            },
            decisionSignal,
            caller.owner,
          ))
        )
          return false
        await revalidate()
        decisionSignal.throwIfAborted()
        return true
      },
    })
  }
}
