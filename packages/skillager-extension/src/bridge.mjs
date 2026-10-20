import { connectorSetupError } from './library-first-use.mjs'
import { readConnectorOutput } from '../../../src/shared/extensions/connector-output.mjs'
import { CONNECTOR_LIMITS } from '../../../src/shared/extensions/connectors.ts'
export { guestClient } from '../../../src/shared/extensions/guest-client.mjs'
export async function runCli(client, args, context, retryFrequency = true) {
  const workspace = context?.workspace
  if (workspace && workspace.host !== 'local')
    throw new Error(
      'SSH project presence is unknown. The personal library remains local; no remote Skillager command is run.',
    )
  const result = await client.request('connector.execute', {
    connector: workspace ? 'project-cli' : 'library-cli',
    host: 'local',
    ...(workspace ? { workspace: workspace.id } : {}),
    args,
  })
  if (await deferReadFrequency(client, result, retryFrequency)) {
    return runCli(client, args, context, false)
  }
  let text = '',
    error = ''
  try {
    if (result.receipt) {
      text = await readConnectorOutput(client, result)
      error = await readConnectorOutput(client, result, { stream: 'stderr' })
    }
    if (result.outcome !== 'completed' || result.code !== 0 || result.truncated)
      throw Object.assign(
        connectorSetupError(
          result.outcome === 'not-started' ? result.reason : undefined,
          result.outcome === 'not-started' && result.reason === 'unapproved'
            ? 'Connect the installed Skillager CLI to browse skills. Program approval is separate from file reading.'
            : result.outcome === 'not-started' &&
                ['frequency', 'capacity'].includes(result.reason)
              ? result.reason === 'frequency'
                ? 'Refresh deferred by the source refresh frequency limit; freshness unavailable.'
                : 'Refresh deferred by execution capacity; freshness unavailable.'
              : `Skillager ${result.outcome}: ${result.reason ?? `exit ${result.code ?? 'unknown'}`}${error ? ` · ${error.slice(0, 300)}` : ''}`,
        ),
        {
          cli: {
            outcome: result.outcome,
            code: result.code,
            stdout: text.length <= 4096 && !result.truncated ? text : undefined,
            stderr: error.slice(-4096),
          },
        },
      )
    return text
  } finally {
    if (result.receipt)
      await client
        .request('connector.output', { receipt: result.receipt, release: true })
        .catch(() => {})
  }
}

/** Only a never-started observation may defer once; mutation owners never call this. */
export async function deferReadFrequency(client, result, permitted) {
  if (
    permitted &&
    result.outcome === 'not-started' &&
    result.reason === 'frequency' &&
    Number.isSafeInteger(result.retryAfterMs) &&
    result.retryAfterMs >= 1 &&
    result.retryAfterMs <= CONNECTOR_LIMITS.refreshIntervalMs &&
    typeof client.delay === 'function' &&
    client.visible === true
  ) {
    // The remaining start-to-start interval reserves no admission or authority.
    // Reobserve once; no cached freshness, implicit body access or mutation replay.
    await client.delay(result.retryAfterMs)
    if (!client.alive) throw new Error('This operation is no longer admitted')
    if (!client.visible) throw new Error('This observation is hidden')
    return true
  }
  return false
}
