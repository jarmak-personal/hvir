export interface ViewerCommandTarget {
  readonly goToLine: () => void
}

export type RegisterViewerCommandTarget = (
  tabId: string,
  target: ViewerCommandTarget,
) => () => void

/** Routes viewer-only commands to one mounted tab without storing UI events in the tab model. */
export class ViewerCommandTargets {
  readonly #targets = new Map<string, ViewerCommandTarget>()

  register(tabId: string, target: ViewerCommandTarget): () => void {
    this.#targets.set(tabId, target)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#targets.get(tabId) === target) this.#targets.delete(tabId)
    }
  }

  goToLine(tabId: string | undefined): void {
    if (tabId) this.#targets.get(tabId)?.goToLine()
  }
}
