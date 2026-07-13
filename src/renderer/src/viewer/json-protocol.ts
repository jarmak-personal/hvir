export type JsonNodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export interface JsonNodeDescriptor {
  readonly label: string
  readonly path: readonly string[]
  readonly kind: JsonNodeKind
  readonly count?: number
  readonly value?: string | number | boolean | null
}

interface JsonWorkerParseInput {
  readonly type: 'parse'
  readonly documentId: number
  readonly source: string
  readonly format: 'json' | 'yaml'
}

interface JsonWorkerChildrenInput {
  readonly type: 'children'
  readonly documentId: number
  readonly path: readonly string[]
  readonly offset: number
  readonly limit: number
}

interface JsonWorkerDisposeInput {
  readonly type: 'dispose'
  readonly documentId: number
}

export type JsonWorkerRequestInput =
  JsonWorkerParseInput | JsonWorkerChildrenInput | JsonWorkerDisposeInput

export type JsonWorkerRequest = JsonWorkerRequestInput & { readonly requestId: number }

export type JsonWorkerResponse =
  | {
      readonly type: 'parsed'
      readonly requestId: number
      readonly root: JsonNodeDescriptor
    }
  | {
      readonly type: 'children'
      readonly requestId: number
      readonly children: readonly JsonNodeDescriptor[]
      readonly total: number
    }
  | { readonly type: 'disposed'; readonly requestId: number }
  | { readonly type: 'error'; readonly requestId: number; readonly message: string }
