import { createHash } from 'node:crypto'
import {
  AGENT_LIMITS,
  agentFailure,
  agentOutput,
  type AgentRequest,
  type AgentResponse,
} from '../../shared/agent/contract'
import { parseAgentCommand, type ParsedAgentCommand } from '../../shared/agent/commands'
import { hostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ExtensionContextOwner } from '../extensions/context-owner'
import type { ExtensionActivation } from '../extensions/activation'
import type {
  ExtensionActionOwner,
  ExtensionActionGuestPort,
} from '../extensions/action-owner'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { ProjectHost } from '../project-host/project-host'
import { authorizeAgentDocument } from '../viewer/document-read-authority'
import type { AgentConnection } from './socket-server'
import type { LocalAgentAccessOwner } from './access-owner'
import type { AgentForwardScopeOwner } from './forward-scope'
import type { ExtensionViewAuthority } from '../extensions/guest-authority'
import type { ExtensionActionAuthority } from '../extensions/action-owner'
import type { AgentReportOwner } from '../viewer/agent-report-owner'

export interface AgentWorkbenchPorts {
  readonly forwardScopes?: AgentForwardScopeOwner
  readonly reference?: (command: ParsedAgentCommand) => Promise<AgentResponse>
  readonly contexts: () => ExtensionContextOwner | undefined
  readonly activeInstallations: () => readonly ExtensionActivation[]
  readonly activeInstallation: (id: string) => ExtensionActivation | undefined
  readonly openView: ExtensionActionGuestPort['open']
  readonly invokeAction: ExtensionActionOwner['invoke']
  readonly access: LocalAgentAccessOwner
  readonly reports: AgentReportOwner
  readonly presentationOwner: () => RendererOwner
  readonly assertOwner: (owner: RendererOwner) => void
  readonly host: (id: string) => ProjectHost | undefined
  readonly openDocument: (
    owner: RendererOwner,
    document: { workspace: string; root: HostPath; path: HostPath },
  ) => void
}
/** Commands adapt existing capability owners; parser/reference contain no live authorization. */
export class AgentWorkbenchCommandOwner {
  constructor(private readonly ports: AgentWorkbenchPorts) {}
  async run(request: AgentRequest, connection: AgentConnection): Promise<AgentResponse> {
    let command: ParsedAgentCommand
    try {
      command = parseAgentCommand(request.argv)
    } catch (reason) {
      return agentFailure(
        'invalid-command',
        connection.origin === 'ssh-forward'
          ? `${message(reason)}. Extension authoring runs on the local machine; SSH agents use live workbench commands`
          : message(reason),
        64,
      )
    }
    if (connection.origin === 'ssh-forward' && !this.ports.forwardScopes)
      return agentFailure('unavailable', 'SSH agent scope is unavailable')
    if (
      ['help', 'commands', 'guide'].includes(command.name) &&
      connection.origin === 'application-local'
    )
      return agentFailure(
        'client-reference',
        'Static reference commands are answered by hvir-agent without a live connection',
        64,
      )
    try {
      if (connection.origin === 'ssh-forward') connection.current()
      if (
        connection.origin === 'ssh-forward' &&
        ['help', 'commands', 'guide'].includes(command.name)
      ) {
        const admitted = this.ports.access.admit(
          this.ports.forwardScopes!.signal(connection),
        )
        admitted.current()
        if (!this.ports.reference)
          throw new Error(
            'Installed live reference is unavailable; authoring runs on the local machine',
          )
        const reference = await this.ports.reference(command)
        admitted.current()
        connection.current()
        return reference
      }
      if (command.name === 'instances')
        return agentOutput({
          instance: this.ports.access.instance,
          ...(connection.origin === 'application-local'
            ? { endpoint: this.ports.access.endpoint }
            : { host: connection.host, generation: connection.generation }),
        })
      const admitted = this.ports.access.admit(
        this.ports.forwardScopes?.signal(connection) ?? connection.signal,
      )
      admitted.current()
      const contexts = this.ports.contexts()
      if (!contexts) throw new Error('Workspace context is unavailable')
      const explicitTarget =
        command.flags['workspace'] !== undefined || command.flags['session'] !== undefined
      const workspace =
        command.flags['workspace'] ??
        (explicitTarget ? undefined : request.defaults.workspace)
      const session =
        command.flags['session'] ??
        (explicitTarget ? undefined : request.defaults.session)
      // Validate stale defaults even for metadata discovery; never silently discard them.
      const owner = session
        ? contexts.sessionOwner(session)
        : this.ports.presentationOwner()
      if (!owner) throw new Error('Session context is stale or unavailable')
      const target = contexts.admit(owner, {
        surface: 'viewer',
        ...(workspace ? { workspaceId: workspace } : {}),
        ...(session ? { sessionId: session } : {}),
      })
      this.ports.forwardScopes?.assertTarget(connection, target.root?.hostId)
      const current = (): void => {
        this.ports.forwardScopes?.assertTarget(connection, target.root?.hostId)
        admitted.current()
        this.ports.assertOwner(owner)
        if (!target.current()) throw new Error('Agent target was revoked')
      }
      current()
      if (command.name === 'workspaces')
        return agentOutput(
          this.page(
            command,
            contexts
              .workspaces()
              .filter(
                (entry) =>
                  connection.origin === 'application-local' ||
                  entry.host === connection.host,
              ),
            connection,
          ),
        )
      if (command.name === 'sessions')
        return agentOutput(
          this.page(
            command,
            contexts
              .sessionsForAgents()
              .filter(
                (entry) =>
                  (!workspace || entry.workspace.id === workspace) &&
                  (connection.origin === 'application-local' ||
                    entry.workspace.host === connection.host),
              ),
            connection,
          ),
        )
      if (['views', 'actions'].includes(command.name)) {
        const entries = this.ports
          .activeInstallations()
          .flatMap<unknown>((activation) => {
            try {
              this.ports.access.assertExtension(activation.installationId)
            } catch {
              return []
            }
            if (command.name === 'views')
              return activation.revision.manifest.views.map((view) => ({
                installation: activation.installationId,
                id: view.id,
                title: view.title,
                placement: view.placement,
              }))
            return (activation.revision.manifest.actions ?? [])
              .filter((action) => action.agents)
              .map((action) => ({
                installation: activation.installationId,
                id: action.id,
                title: action.title,
                effects: action.effects,
              }))
          })
        return agentOutput(this.page(command, entries, connection))
      }
      if (command.name === 'report') {
        if (!target.root || !target.value.workspace)
          throw new Error('Report requires an explicit workspace')
        const format = command.flags['format'] ?? 'markdown'
        if (!['text', 'markdown'].includes(format))
          return agentFailure(
            'invalid-format',
            'Report format must be text or markdown',
            64,
          )
        current()
        const report = this.ports.reports.publish(
          target.value.workspace.id,
          target.root,
          command.flags['title'] ?? 'Agent report',
          format as 'text' | 'markdown',
          request.stdin,
          command.flags['handle'],
        )
        // Publication is complete and retained. Later cancellation never claims rollback.
        return agentOutput({ report })
      }
      if (command.name === 'open') {
        if (!target.root || !target.value.workspace || !command.flags['path'])
          throw new Error('Document opening requires an explicit workspace and --path')
        const host = this.ports.host(target.root.hostId)
        if (!host || host.connectionState !== 'connected')
          throw new Error('Document host is disconnected')
        const requested = command.flags['path'].startsWith('/')
          ? hostPath(target.root.hostId, command.flags['path'])
          : joinHostPath(target.root, command.flags['path'])
        const path = await authorizeAgentDocument(host, target.root, requested, current)
        current()
        this.ports.openDocument(owner, {
          workspace: target.value.workspace.id,
          root: target.root,
          path,
        })
        return agentOutput({
          document: { workspace: target.value.workspace.id, path, opened: true },
        })
      }
      const installation = command.flags['extension']
      if (!installation) throw new Error('Select --extension INSTALLATION')
      this.ports.access.assertExtension(installation)
      const activation = this.ports.activeInstallation(installation)
      if (!activation) throw new Error('Extension is disabled or unavailable')
      const extensionSignal = AbortSignal.any([
        admitted.signal,
        this.ports.access.extensionSignal(installation),
      ])
      const extensionCurrent = (): void => {
        extensionSignal.throwIfAborted()
        current()
        this.ports.access.assertExtension(installation)
        if (this.ports.activeInstallation(installation) !== activation)
          throw new Error('Extension activation was revoked')
      }
      if (command.name === 'view') {
        const view = command.flags['view']
        if (!view) throw new Error('Select --view VIEW')
        const opened = await this.ports.openView(
          owner,
          installation,
          view,
          {
            context: {
              surface: 'viewer',
              workspaceId: target.value.workspace?.id,
              sessionId: session,
            },
            focus: false,
            authority: this.viewAuthority(
              connection,
              installation,
              activation.revision.hash,
              target.value.workspace?.id,
            ),
          },
          extensionCurrent,
        )
        extensionCurrent()
        if (!opened) throw new Error('Extension view is unavailable')
        return agentOutput({ view: { id: opened.id, title: opened.title, installation } })
      }
      const actionId = command.flags['action'],
        action = activation.revision.manifest.actions?.find(
          (entry) => entry.id === actionId && entry.agents,
        )
      if (!action) throw new Error('Action is unavailable to agents')
      if (command.name === 'action')
        return agentOutput({ untrusted: true, declaration: action, installation })
      if (command.name !== 'run') throw new Error('Command is unavailable')
      const serialized = command.flags['input'] ?? 'null'
      if (Buffer.byteLength(serialized) > 8192)
        throw new Error('Action input exceeds its bound')
      const input: unknown = JSON.parse(serialized)
      // Input/context are captured once, before confirmation; the decision is never a caller claim.
      const authorization = await this.ports.access.authorizeAction(
        {
          installation,
          title: `${activation.revision.manifest.name}: ${action.title}`,
          input: serialized,
          workspace: target.value.workspace?.id,
          session,
          effects: action.effects,
        },
        extensionCurrent,
        extensionSignal,
      )
      extensionCurrent()
      const value = await this.ports.invokeAction(
        owner,
        activation,
        action.id,
        input,
        {
          surface: 'viewer',
          workspaceId: target.value.workspace?.id,
          sessionId: session,
        },
        'agent',
        authorization,
        extensionCurrent,
        extensionSignal,
        this.actionAuthority(
          connection,
          installation,
          activation.revision.hash,
          action.id,
          target.value.workspace?.id,
        ),
      )
      extensionCurrent()
      return agentOutput({ value })
    } catch (reason) {
      return agentFailure(
        connection.signal.aborted ? 'interrupted' : 'unavailable',
        message(reason),
        connection.signal.aborted ? 75 : 69,
      )
    }
  }
  private viewAuthority(
    connection: AgentConnection,
    installation: string,
    revision: string,
    workspace?: string,
  ): ExtensionViewAuthority | undefined {
    if (connection.origin === 'application-local') return undefined
    const signal = AbortSignal.any([
      this.ports.forwardScopes!.viewSignal(connection),
      this.ports.access.admit(connection.lifetime ?? connection.signal).signal,
      this.ports.access.extensionSignal(installation),
    ])
    return {
      key: `${connection.host}:${connection.generation}:${installation}:${workspace ?? ''}`,
      signal,
      current: () => {
        signal.throwIfAborted()
        connection.current()
        this.ports.access.assertExtension(installation)
      },
      assertCapability: (_capability, host, destination) => {
        signal.throwIfAborted()
        this.ports.forwardScopes!.assertTarget(connection, host)
        if (destination && destination !== workspace)
          throw new Error('SSH view cannot change its admitted destination')
      },
      forAction: (action) =>
        this.actionAuthority(connection, installation, revision, action, workspace)!,
    }
  }
  private actionAuthority(
    connection: AgentConnection,
    installation: string,
    revision: string,
    action: string,
    workspace?: string,
  ): ExtensionActionAuthority | undefined {
    if (connection.origin === 'application-local') return undefined
    return {
      view: this.viewAuthority(connection, installation, revision, workspace),
      authorizeAction: (binding, current, signal) =>
        this.ports.access.authorizeAction(
          { installation, ...binding, workspace },
          current,
          AbortSignal.any([signal, this.ports.forwardScopes!.viewSignal(connection)]),
        ),
      assertCapability: (capability, host, destination) =>
        this.ports.forwardScopes!.assertCapability(
          connection,
          { installation, revision, action, workspace },
          capability,
          host,
          destination,
        ),
      forAction: (next) =>
        this.actionAuthority(connection, installation, revision, next, workspace)!,
    }
  }
  private page(
    command: ParsedAgentCommand,
    values: readonly unknown[],
    connection: AgentConnection,
  ): { items: readonly unknown[]; nextCursor?: string } {
    const filter = command.flags['filter']?.toLowerCase() ?? ''
    const filtered = values.filter(
      (value) => !filter || JSON.stringify(value).toLowerCase().includes(filter),
    )
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          this.ports.access.instance,
          connection.origin === 'ssh-forward'
            ? [connection.host, connection.generation]
            : 'local',
          command.name,
          filter,
          filtered,
        ]),
      )
      .digest('hex')
      .slice(0, 24)
    const limit = Number(command.flags['limit'] ?? AGENT_LIMITS.pageSize)
    if (!Number.isInteger(limit) || limit < 1 || limit > AGENT_LIMITS.pageSize)
      throw new Error('Page limit must be 1–32')
    let offset = 0
    if (command.flags['cursor']) {
      const [signature, index] = command.flags['cursor'].split(':')
      offset = Number(index)
      if (
        signature !== identity ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > filtered.length
      )
        throw new Error('Discovery cursor is stale or invalid')
    }
    return {
      items: filtered.slice(offset, offset + limit),
      ...(offset + limit < filtered.length
        ? { nextCursor: `${identity}:${offset + limit}` }
        : {}),
    }
  }
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Agent operation unavailable'
}
