import type { ViewerFindRange } from './viewer-find'

/** Fixed-size transferable pages keep dense results compact and navigation constant-time. */
export const FIND_MATCH_PAGE_SIZE = 4096

export class FindMatchIndex {
  readonly #pages: Uint32Array[] = []
  #length = 0

  get length(): number {
    return this.#length
  }

  append(page: Uint32Array): void {
    this.#pages.push(page)
    this.#length += page.length / 2
  }

  at(index: number): ViewerFindRange {
    const page = this.#pages[Math.floor(index / FIND_MATCH_PAGE_SIZE)]!
    const offset = (index % FIND_MATCH_PAGE_SIZE) * 2
    return { from: page[offset]!, to: page[offset + 1]! }
  }

  firstEndingAfter(position: number): number {
    let low = 0
    let high = this.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.at(mid).to <= position) low = mid + 1
      else high = mid
    }
    return low
  }
}
