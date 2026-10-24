import type { ViewerFindQuery } from './viewer-find'

export type FindWorkerRequest =
  | { readonly type: 'chunk'; readonly content: string }
  | {
      readonly type: 'search'
      readonly document: number
      readonly query: ViewerFindQuery
    }

export type FindWorkerResponse =
  | { readonly type: 'matches'; readonly document: number; readonly ranges: Uint32Array }
  | { readonly type: 'done'; readonly document: number }
