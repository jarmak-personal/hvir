/* global TextEncoder */
const maximum = 4 * 1024 * 1024
const resultFields = [
  'receipt',
  'outcome',
  'host',
  'code',
  'signal',
  'truncated',
  'reason',
  'stdoutBytes',
  'stderrBytes',
]
/** Read one complete UTF-8 stream. The caller retains release and domain interpretation. */
export async function readConnectorOutput(
  client,
  result,
  { stream = 'stdout', maxBytes = maximum, signal } = {},
) {
  if (
    !['stdout', 'stderr'].includes(stream) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > maximum ||
    !result ||
    typeof result.receipt !== 'string' ||
    !result.receipt ||
    !['completed', 'interrupted-uncertain'].includes(result.outcome) ||
    typeof result.host !== 'string' ||
    typeof result.truncated !== 'boolean' ||
    !(result.code === null || Number.isSafeInteger(result.code)) ||
    !(result.signal === null || typeof result.signal === 'string') ||
    !['stdoutBytes', 'stderrBytes'].every(
      (key) => Number.isSafeInteger(result[key]) && result[key] >= 0,
    ) ||
    result.stdoutBytes + result.stderrBytes > maximum
  )
    throw new Error('Invalid connector output result or read bound')
  // Snapshot the expected metadata so caller mutation cannot weaken page checks.
  const expected = Object.fromEntries(resultFields.map((key) => [key, result[key]]))
  const size = expected[`${stream}Bytes`]
  if (size > maxBytes)
    throw new Error('Complete connector output exceeds the supported bound')
  const encoder = new TextEncoder(),
    parts = []
  let offset = 0
  for (;;) {
    signal?.throwIfAborted()
    const page = await client.request(
      'connector.output',
      {
        receipt: expected.receipt,
        stream,
        offset,
      },
      signal,
    )
    signal?.throwIfAborted()
    if (
      !page ||
      typeof page.data !== 'string' ||
      !page.result ||
      !resultFields.every((key) => page.result[key] === expected[key])
    )
      throw new Error('Connector output page does not match its receipt')
    const bytes = encoder.encode(page.data).byteLength
    const end = offset + bytes
    if (
      end > size ||
      end > maxBytes ||
      (page.nextOffset === null
        ? end !== size
        : !Number.isSafeInteger(page.nextOffset) ||
          page.nextOffset !== end ||
          end <= offset ||
          end >= size)
    )
      throw new Error(
        'Connector output page is incomplete or did not advance by UTF-8 bytes',
      )
    parts.push(page.data)
    if (page.nextOffset === null) return parts.join('')
    offset = page.nextOffset
  }
}
