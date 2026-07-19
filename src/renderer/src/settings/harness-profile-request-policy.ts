export type HarnessProfileRequestChannel =
  | 'load'
  | 'mutation'
  | 'preview'
  | `probe:${string}`
  | `browse:${string}`
  | `grant:${string}`

export interface HarnessProfileRequestToken {
  readonly workspace: number
  readonly selection: number
  readonly channel: HarnessProfileRequestChannel
  readonly request: number
}

export class HarnessProfileRequestPolicy {
  #workspace = 0
  #selection = 0
  readonly #requests = new Map<HarnessProfileRequestChannel, number>()

  switchWorkspace(): number {
    this.#workspace += 1
    this.#selection += 1
    this.#requests.clear()
    return this.#workspace
  }

  switchProfile(): number {
    this.#selection += 1
    this.invalidate('preview')
    return this.#selection
  }

  start(channel: HarnessProfileRequestChannel): HarnessProfileRequestToken {
    const request = (this.#requests.get(channel) ?? 0) + 1
    this.#requests.set(channel, request)
    return {
      workspace: this.#workspace,
      selection: this.#selection,
      channel,
      request,
    }
  }

  invalidate(channel: HarnessProfileRequestChannel): void {
    this.#requests.set(channel, (this.#requests.get(channel) ?? 0) + 1)
  }

  isCurrent(token: HarnessProfileRequestToken, selectionSensitive = false): boolean {
    return (
      token.workspace === this.#workspace &&
      (!selectionSensitive || token.selection === this.#selection) &&
      token.request === this.#requests.get(token.channel)
    )
  }
}
