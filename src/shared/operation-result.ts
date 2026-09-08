export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export function unwrapOperation<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
