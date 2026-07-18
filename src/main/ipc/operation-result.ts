import type { OperationResult } from '../../shared'

export async function operationResult<T>(
  operation: () => Promise<T>,
): Promise<OperationResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (reason) {
    return { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
  }
}
