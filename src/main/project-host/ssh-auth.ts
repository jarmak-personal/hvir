export interface SshPrompt {
  readonly hostId: string
  readonly kind:
    'password' | 'passphrase' | 'keyboard-interactive' | 'host-key' | 'host-key-changed'
  readonly title: string
  readonly instructions?: string
  readonly fingerprint?: string
  readonly previousFingerprint?: string
  readonly prompts: readonly { readonly text: string; readonly echo: boolean }[]
}

/** Presentation port for one revocable SSH connection generation. */
export interface SshAuthPrompter {
  prompt(request: SshPrompt, signal: AbortSignal): Promise<readonly string[] | undefined>
}
