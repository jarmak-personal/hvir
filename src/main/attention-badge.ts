/** Quiet OS-level aggregation for actionable terminal attention. */
export class AttentionBadge {
  private readonly owners = new Map<string, { count: number; focused: boolean }>()
  private lastRendered = -1
  private failed = false

  constructor(private readonly setBadgeCount: (count: number) => boolean | void) {}

  update(ownerId: number, count: number, ownerGeneration = 0): void {
    const key = ownerKey(ownerId, ownerGeneration)
    const current = this.owners.get(key) ?? { count: 0, focused: false }
    this.owners.set(key, { ...current, count: cleanCount(count) })
    this.render()
  }

  setFocused(ownerId: number, focused: boolean, ownerGeneration = 0): void {
    const key = ownerKey(ownerId, ownerGeneration)
    const current = this.owners.get(key) ?? { count: 0, focused: false }
    this.owners.set(key, { ...current, focused })
    this.render()
  }

  remove(ownerId: number, ownerGeneration?: number): void {
    if (ownerGeneration === undefined) {
      for (const key of this.owners.keys()) {
        if (key.startsWith(`${ownerId}:`)) this.owners.delete(key)
      }
    } else {
      this.owners.delete(ownerKey(ownerId, ownerGeneration))
    }
    this.render()
  }

  clear(): void {
    this.owners.clear()
    this.render()
  }

  private render(): void {
    const focused = [...this.owners.values()].some((owner) => owner.focused)
    const count = focused
      ? 0
      : Math.min(
          99,
          [...this.owners.values()].reduce((total, owner) => total + owner.count, 0),
        )
    if (count === this.lastRendered) return
    this.lastRendered = count
    if (this.failed) return
    try {
      if (this.setBadgeCount(count) === false) this.failed = true
    } catch (error) {
      this.failed = true
      console.warn('[attention] OS badge unavailable', error)
    }
  }
}

function ownerKey(ownerId: number, ownerGeneration: number): string {
  return `${ownerId}:${ownerGeneration}`
}

function cleanCount(value: number): number {
  if (!Number.isSafeInteger(value)) return 0
  return Math.max(0, Math.min(99, value))
}
