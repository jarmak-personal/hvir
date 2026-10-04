/* global TextEncoder */
import { MANAGEMENT_LIMITS, boundedManagementJson } from './management-contract.mjs'
import { deferReadFrequency } from './bridge.mjs'

async function completeOutput(client, receipt, stream) {
  let value = '',
    offset = 0,
    bytes = 0
  for (;;) {
    const page = await client.request('connector.output', { receipt, stream, offset })
    if (typeof page.data !== 'string') throw new Error('CLI output page is unavailable')
    bytes += new TextEncoder().encode(page.data).length
    if (bytes > MANAGEMENT_LIMITS.responseBytes)
      throw new Error(
        'Complete operation output exceeds the supported bound; use the public Skillager CLI and reconcile explicitly',
      )
    value += page.data
    if (page.nextOffset === null) return value
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)
      throw new Error('CLI output page did not advance')
    offset = page.nextOffset
  }
}
/** One admitted operation owns its descriptor until a verified result or explicit reconciliation. */
export function managementCli(
  client,
  context,
  observePending = () => {},
  retainOutput = () => {},
) {
  let pending
  function current() {
    if (!client.alive) throw new Error('This operation is no longer admitted')
    if (context?.workspace && context.workspace.host !== 'local')
      throw new Error('Select the exact local workspace; no SSH command was substituted')
  }
  return {
    get pending() {
      return pending
    },
    verified() {
      pending = undefined
      observePending(undefined)
    },
    async run(args, operation, retryReadFrequency = true, validateCompletion) {
      current()
      if (operation && pending)
        throw new Error('Reconcile the exact submitted operation before another mutation')
      if (operation) {
        const descriptor = Object.freeze({ ...operation, state: 'uncertain' })
        observePending(descriptor)
        pending = descriptor
      }
      let result
      try {
        result = await client.request('connector.execute', {
          connector: context?.workspace ? 'project-cli' : 'library-cli',
          host: 'local',
          ...(context?.workspace ? { workspace: context.workspace.id } : {}),
          args,
        })
        if (await deferReadFrequency(client, result, !operation && retryReadFrequency)) {
          current()
          return this.run(args, undefined, false)
        }
        if (result.outcome === 'not-started') {
          if (operation) {
            pending = undefined
            observePending(undefined)
          }
          throw new Error(
            `Operation did not start: ${result.reason ?? 'admission refused'}. Retry only by explicit choice.`,
          )
        }
        if (result.outcome !== 'completed' || !result.receipt || result.truncated)
          throw new Error(
            `Operation ${result.outcome}; complete native effects are unknown. Reconcile this operation explicitly.`,
          )
        const output = await completeOutput(client, result.receipt, 'stdout'),
          error = await completeOutput(client, result.receipt, 'stderr')
        if (operation) retainOutput({ code: result.code, stdout: output, stderr: error })
        current()
        if (!validateCompletion && result.code !== 0)
          throw new Error(
            `Skillager exit ${result.code ?? 'unknown'}${error ? `: ${error.slice(0, 300)}` : ''}. ${operation ? 'Submitted effects require reconciliation.' : 'No mutation was requested.'}`,
          )
        const value = boundedManagementJson(JSON.parse(output))
        if (validateCompletion) validateCompletion(value, result.code)
        return value
      } finally {
        if (result?.receipt)
          await client
            .request('connector.output', { receipt: result.receipt, release: true })
            .catch(() => {})
      }
    },
  }
}
