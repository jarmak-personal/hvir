import type { ExtensionActionAuthority } from './action-owner'

export interface ExtensionViewAuthority extends ExtensionActionAuthority {
  readonly key: string
  readonly signal: AbortSignal
  current(): void
}
/** Main-only restrictions survive missing invocation IDs and intersect when a view is reused. */
export class ExtensionGuestAuthority {
  get restricted(): boolean {
    return this.authorities.size > 0
  }
  private readonly authorities = new Map<
    string,
    { authority: ExtensionViewAuthority; release(): void }
  >()
  add(authority: ExtensionViewAuthority | undefined, revoke: () => void): void {
    if (!authority || this.authorities.has(authority.key)) return
    if (this.authorities.size >= 16)
      throw new Error('Extension view origin capacity is full')
    authority.current()
    const cancelled = (): void => revoke()
    authority.signal.addEventListener('abort', cancelled, { once: true })
    this.authorities.set(authority.key, {
      authority,
      release: () => authority.signal.removeEventListener('abort', cancelled),
    })
    if (authority.signal.aborted) revoke()
  }
  current(): boolean {
    try {
      for (const { authority } of this.authorities.values()) {
        authority.signal.throwIfAborted()
        authority.current()
      }
      return true
    } catch {
      return false
    }
  }
  view(): ExtensionViewAuthority | undefined {
    const authorities = [...this.authorities.values()].map((entry) => entry.authority)
    if (!authorities.length) return undefined
    return {
      key: authorities.map((authority) => authority.key).join('|'),
      signal: AbortSignal.any(authorities.map((authority) => authority.signal)),
      current: () => {
        if (!this.current()) throw new Error('Extension forward origin was revoked')
      },
      assertCapability: (capability, host, workspace) =>
        this.assertCapability(capability, host, workspace),
      forAction: (action) => this.forAction(action)!,
    }
  }
  assertCapability(capability: string, host: string, workspace?: string): void {
    for (const { authority } of this.authorities.values())
      authority.assertCapability(capability, host, workspace)
  }
  forAction(action: string): ExtensionActionAuthority | undefined {
    if (!this.authorities.size) return undefined
    const children = [...this.authorities.values()].map(
      ({ authority }) => authority.forAction?.(action) ?? authority,
    )
    return {
      view: this.view(),
      authorizeAction: async (binding, current, signal) => {
        let result: 'standing' | 'interactive' = 'standing'
        for (const child of children)
          if (
            child.authorizeAction &&
            (await child.authorizeAction(binding, current, signal)) === 'interactive'
          )
            result = 'interactive'
        return result
      },
      assertCapability: (capability, host, workspace) =>
        children.forEach((authority) =>
          authority.assertCapability(capability, host, workspace),
        ),
      forAction: (next) => this.forAction(next)!,
    }
  }
  dispose(): void {
    for (const entry of this.authorities.values()) entry.release()
    this.authorities.clear()
  }
}
