import type { HvirApi } from '../../shared'

declare global {
  interface Window {
    readonly hvir: HvirApi
  }
}

export {}
