import type { HostPath } from '../../shared/host-path'

/** Leaves space for the complete bridge envelope, correlation and bounded warnings. */
export const DELIVERY_VALUE_BYTES = 6144
export function deliveryValue<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > DELIVERY_VALUE_BYTES)
    throw new Error('Complete delivery metadata exceeds its public response bound')
  return value
}
/** Admit only operations whose later complete recovery facts remain representable. */
export function proveDeliveryRecoveryEnvelope(
  operation: string,
  installation: string,
  paths: readonly HostPath[],
): void {
  deliveryValue({
    token: 'x'.repeat(80),
    operation,
    installation,
    phase: 'completed',
    completion: 'unproven',
    outcome: 'completed',
    replayed: false,
    objects: paths.map((path) => ({
      path,
      state: 'unverifiable',
      identity: 'x'.repeat(256),
      recordedIdentity: 'x'.repeat(256),
      fingerprint: 'x'.repeat(64),
    })),
    resolution: 'x'.repeat(240),
    reason: 'x'.repeat(240),
  })
}
export function deliveryPage<T>(
  values: readonly T[],
  value: unknown,
): { entries: readonly T[]; nextOffset: number | null } {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > values.length
  )
    throw new Error('Invalid delivery metadata offset')
  const offset = value as number
  let end = Math.min(values.length, offset + 16)
  for (;;) {
    const result = {
      entries: values.slice(offset, end),
      nextOffset: end < values.length ? end : null,
    }
    if (Buffer.byteLength(JSON.stringify(result)) <= DELIVERY_VALUE_BYTES) return result
    if (end <= offset + 1)
      throw new Error('One complete delivery metadata entry exceeds its bound')
    end--
  }
}

export function deliveryReason(reason: unknown): string {
  if (!(reason instanceof Error))
    return 'Delivery did not complete; inspect exact recorded objects'
  let result = '',
    bytes = 0
  for (const character of reason.message) {
    const code = character.codePointAt(0)!,
      printable = code < 32 || code === 34 || code === 92 ? ' ' : character
    const size = Buffer.byteLength(printable)
    if (bytes + size > 240) break
    result += printable
    bytes += size
  }
  return result
}
