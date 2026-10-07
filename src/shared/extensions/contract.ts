import type { HostPath } from '../host-path'
import type { PresentationColorToken } from '../presentation/tokens'
/** Public, process-independent extension contract. No workbench IPC is an author API. */
export const EXTENSION_CONTRACT = '1.0'
export const EXTENSION_CAPABILITIES = [
  'presentation.read',
  'viewer.open-own',
  'context.read',
  'contributions.read',
  'contributions.publish',
  'actions.invoke',
  'terminal.start',
  'connector.execute',
  'connector.output',
  'connector.status',
  'connector.connect',
  'source.status',
  'source.request',
  'source.select',
  'source.read',
  'source.asset',
  'source.render',
  'source.reveal',
  'delivery.capture',
  'delivery.manifest',
  'delivery.preview',
  'delivery.apply',
  'delivery.status',
  'delivery.domain',
  'delivery.reconcile',
  'delivery.cleanup',
] as const
export type ExtensionCapability = (typeof EXTENSION_CAPABILITIES)[number]

export const EXTENSION_LIMITS = {
  installations: 32,
  archiveBytes: 20 * 1024 * 1024,
  archiveTimeoutMs: 10_000,
  retainedRevisions: 96,
  retainedBytes: 128 * 1024 * 1024,
  revisionsPerInstallation: 3,
  files: 256,
  depth: 12,
  fileBytes: 2 * 1024 * 1024,
  packageBytes: 16 * 1024 * 1024,
  manifestBytes: 32 * 1024,
  warnings: 16,
  viewsPerExtension: 8,
  views: 32,
  messageBytes: 16 * 1024,
  requestsPerView: 8,
  requestsPerExtension: 16,
  requests: 64,
  messagesPerSecond: 30,
  requestTimeoutMs: 10_000,
  railItems: 8,
  actions: 8,
  sessions: 128,
  contextBytes: 7 * 1024,
  actionBytes: 8 * 1024,
  actionsPerExtension: 4,
  actionsPending: 16,
  actionTimeoutMs: 120_000,
  actionMaximumMs: 180_000,
  presentationBytes: 16 * 1024,
  presentationTotalBytes: 256 * 1024,
} as const

export interface ExtensionContribution {
  readonly id: string
  readonly title: string
  readonly entry: string
  readonly placement: 'application' | 'workspace'
  readonly navigation?: 'top' | 'left'
  readonly navigationIcon?: string
  readonly representations: readonly ['view']
}

export interface ExtensionManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly contract: string
  readonly minimumHvir?: string
  readonly requiredCapabilities: readonly string[]
  readonly optionalCapabilities: readonly string[]
  readonly access: readonly import('./source-access').ExtensionSourceDeclaration[]
  readonly views: readonly ExtensionContribution[]
  /** Optional ordinary application view shown only after explicit installation. */
  readonly landing?: string
  readonly railItems?: readonly ExtensionRailItem[]
  readonly actions?: readonly ExtensionAction[]
  readonly updater?: string
  readonly connectors?: readonly import('./connectors').ExtensionConnectorDeclaration[]
}

export interface ExtensionPresentation {
  readonly appearance: 'light' | 'dark'
  readonly colors: Readonly<Record<PresentationColorToken, string>>
  readonly fontFamily: string
  readonly monospaceFontFamily: string
  readonly interfaceScale: number
  readonly width: number
  readonly height: number
}

export type ExtensionRequest =
  | { readonly kind: 'hello'; readonly contract: string }
  | {
      readonly kind: 'request'
      readonly id: string
      readonly capability: string
      readonly input?: unknown
      readonly actionId?: string
    }
  | { readonly kind: 'cancel'; readonly id: string }
  | {
      readonly kind: 'action-result'
      readonly id: string
      readonly value?: unknown
      readonly error?: string
    }

export type ExtensionReply =
  | {
      readonly kind: 'hello'
      readonly contract: string
      readonly capabilities: readonly string[]
      readonly presentation: ExtensionPresentation
      readonly warnings: readonly string[]
    }
  | {
      readonly kind: 'result'
      readonly id: string
      readonly ok: true
      readonly value: unknown
      readonly warnings: readonly string[]
    }
  | {
      readonly kind: 'result'
      readonly id: string
      readonly ok: false
      readonly error: string
      readonly warnings: readonly string[]
    }
  | { readonly kind: 'presentation'; readonly presentation: ExtensionPresentation }
  | { readonly kind: 'context'; readonly context: ExtensionContext }
  | { readonly kind: 'contributions'; readonly values: readonly ExtensionItemValue[] }
  | { readonly kind: 'action'; readonly invocation: ExtensionInvocation }
  | { readonly kind: 'action-cancelled'; readonly id: string }
  | { readonly kind: 'revoked' }

export interface ExtensionGuestBridge {
  /** Negotiate before requesting any capability. */
  send(message: ExtensionRequest): void
  onMessage(callback: (message: ExtensionReply) => void): () => void
}

export interface ExtensionRailItem {
  readonly id: string
  readonly placement: 'header' | 'session'
  readonly icon: string
  readonly tooltip: string
  readonly label?: string
  readonly kind: 'control' | 'observation'
  readonly click: { readonly view: string; readonly placement: 'popup' | 'viewer' }
}
export interface ExtensionAction {
  readonly id: string
  readonly title: string
  readonly view: string
  readonly agents: boolean
  readonly description?: string
  readonly inputSchema?: import('./action-input').ExtensionActionInputSchema
  readonly timeoutMs?: number
  readonly effects: { readonly delete: boolean; readonly replace: boolean }
}
export interface ExtensionWorkspaceContext {
  readonly id: string
  readonly name: string
  readonly host: string
  /** Registered root metadata confers no file or execution authority. */
  readonly root?: HostPath
}
export interface ExtensionSessionContext {
  /** Exact live spawn identity, never a persisted terminal id or recycled projection handle. */
  readonly id: string
  readonly title: string
  readonly workspace: ExtensionWorkspaceContext
}
export interface ExtensionContext {
  readonly surface: 'viewer' | 'left' | 'top' | 'popup' | 'updater'
  readonly visible: boolean
  readonly workspace?: ExtensionWorkspaceContext
  readonly session?: ExtensionSessionContext
  readonly sessions?: readonly ExtensionSessionContext[]
  /** Bounded contribution input is data, never read or action authority. */
  readonly input?: unknown
}
export interface ExtensionItemValue {
  readonly item: string
  readonly session?: string
  readonly icon?: string
  readonly label?: string
  readonly tooltip?: string
  readonly availability?: 'current' | 'stale' | 'disconnected' | 'failed'
  readonly observedAt?: number
}
export interface ExtensionInvocation {
  readonly id: string
  readonly action: string
  readonly input: unknown
  readonly context: ExtensionContext
  readonly caller: 'human' | 'agent' | 'guest'
  readonly authorization: 'interactive' | 'standing' | 'unapproved'
}
