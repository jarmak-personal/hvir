/** Small ownership token for ignoring completions after reset or unmount. */
export class EffectGeneration {
  #current = 0

  begin(): number {
    this.#current += 1
    return this.#current
  }

  snapshot(): number {
    return this.#current
  }

  isCurrent(token: number): boolean {
    return token === this.#current
  }

  invalidate(token: number): void {
    if (this.isCurrent(token)) this.#current += 1
  }
}
