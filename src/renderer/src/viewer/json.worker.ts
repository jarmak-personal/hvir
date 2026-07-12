import type {
  JsonNodeDescriptor,
  JsonNodeKind,
  JsonWorkerRequest,
  JsonWorkerResponse,
} from './json-protocol'

const documents = new Map<number, unknown>()

self.onmessage = (event: MessageEvent<JsonWorkerRequest>): void => {
  const request = event.data
  try {
    if (request.type === 'parse') {
      const value: unknown = JSON.parse(request.json)
      documents.set(request.documentId, value)
      post({
        type: 'parsed',
        requestId: request.requestId,
        root: describe('root', [], value),
      })
      return
    }
    if (request.type === 'dispose') {
      documents.delete(request.documentId)
      post({ type: 'disposed', requestId: request.requestId })
      return
    }

    const root = documents.get(request.documentId)
    if (!documents.has(request.documentId)) throw new Error('JSON document expired')
    const parent = resolvePath(root, request.path)
    if (parent === null || typeof parent !== 'object') {
      throw new Error('JSON node has no children')
    }
    const offset = Math.max(0, Math.floor(request.offset))
    const limit = Math.max(1, Math.min(500, Math.floor(request.limit)))
    const arrayParent: readonly unknown[] | undefined = Array.isArray(parent)
      ? parent
      : undefined
    const objectParent = arrayParent ? undefined : (parent as Record<string, unknown>)
    const objectKeys = objectParent ? Object.keys(objectParent) : undefined
    const total = arrayParent?.length ?? objectKeys?.length ?? 0
    const keys = arrayParent
      ? Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) =>
          String(offset + index),
        )
      : (objectKeys?.slice(offset, offset + limit) ?? [])
    const children = keys.map((key) => {
      const value = arrayParent ? arrayParent[Number(key)] : objectParent?.[key]
      return describe(key, [...request.path, key], value)
    })
    post({
      type: 'children',
      requestId: request.requestId,
      children,
      total,
    })
  } catch (error) {
    post({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function describe(
  label: string,
  path: readonly string[],
  value: unknown,
): JsonNodeDescriptor {
  const kind = kindOf(value)
  if (kind === 'array') {
    return { label, path, kind, count: (value as unknown[]).length }
  }
  if (kind === 'object') {
    return {
      label,
      path,
      kind,
      count: Object.keys(value as Record<string, unknown>).length,
    }
  }
  return {
    label,
    path,
    kind,
    value: value as string | number | boolean | null,
  }
}

function kindOf(value: unknown): JsonNodeKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  throw new Error(`Unsupported JSON value: ${typeof value}`)
}

function resolvePath(root: unknown, path: readonly string[]): unknown {
  let value = root
  for (const part of path) {
    if (value === null || typeof value !== 'object') {
      throw new Error('Invalid JSON node path')
    }
    value = Array.isArray(value)
      ? value[Number(part)]
      : (value as Record<string, unknown>)[part]
  }
  return value
}

function post(response: JsonWorkerResponse): void {
  self.postMessage(response)
}
