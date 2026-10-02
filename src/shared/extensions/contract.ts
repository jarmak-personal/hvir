/** Public, process-independent extension contract. No workbench IPC is an author API. */
export const EXTENSION_CONTRACT = '1.0'
export const EXTENSION_CAPABILITIES = ['presentation.read', 'viewer.open-own'] as const
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
  viewsPerExtension: 4,
  views: 16,
  messageBytes: 16 * 1024,
  requestsPerView: 8,
  requestsPerExtension: 16,
  requests: 64,
  messagesPerSecond: 30,
  requestTimeoutMs: 10_000,
} as const

export interface ExtensionContribution {
  readonly id: string
  readonly title: string
  readonly entry: string
  readonly placement: 'application'
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
  readonly access: readonly []
  readonly views: readonly ExtensionContribution[]
}

export interface ExtensionPresentation {
  readonly appearance: 'light' | 'dark'
  readonly colors: Readonly<
    Record<'background' | 'surface' | 'text' | 'muted' | 'accent', string>
  >
  readonly fontFamily: string
  readonly fontSize: number
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
    }
  | { readonly kind: 'cancel'; readonly id: string }

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
  | { readonly kind: 'revoked' }

export interface ExtensionGuestBridge {
  /** Negotiate before requesting any capability. */
  send(message: ExtensionRequest): void
  onMessage(callback: (message: ExtensionReply) => void): () => void
}
