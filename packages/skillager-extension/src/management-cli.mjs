import { readConnectorOutput } from '../../../src/shared/extensions/connector-output.mjs'
import { MANAGEMENT_LIMITS, boundedManagementJson } from './management-contract.mjs'
import { deferReadFrequency } from './bridge.mjs'
import { connectorSetupError } from './library-first-use.mjs'

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
      current()
      pending = undefined
      observePending(undefined)
    },
    async run(
      args,
      operation,
      retryReadFrequency = true,
      validateCompletion,
      captureOutput,
    ) {
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
          return this.run(args, undefined, false, validateCompletion, captureOutput)
        }
        if (result.outcome === 'not-started') {
          if (operation) {
            pending = undefined
            observePending(undefined)
          }
          throw connectorSetupError(
            result.reason,
            `Operation did not start (${result.reason ?? 'admission refused'}). ${context?.workspace ? 'Connect Skillager for this project (project-cli); library-cli approval is separate.' : 'Connect Skillager for your library (library-cli).'} Retry only by explicit choice.`,
          )
        }
        if (result.outcome !== 'completed' || !result.receipt || result.truncated)
          throw new Error(
            `Operation ${result.outcome}; complete native effects are unknown. Reconcile this operation explicitly.`,
          )
        let output, error
        try {
          output = await readConnectorOutput(client, result, {
            maxBytes: MANAGEMENT_LIMITS.responseBytes,
          })
          error = await readConnectorOutput(client, result, {
            stream: 'stderr',
            maxBytes: MANAGEMENT_LIMITS.responseBytes,
          })
        } catch (reason) {
          if (!operation) throw reason
          throw new Error(
            'Complete operation output could not be read; use the public Skillager CLI and reconcile explicitly.',
            { cause: reason },
          )
        }
        if (operation) retainOutput({ code: result.code, stdout: output, stderr: error })
        current()
        const diagnostic =
          error.length > 600 ? `${error.slice(0, 300)}…${error.slice(-300)}` : error
        const summary = error.length > 180 ? `…${error.slice(-179)}` : error
        if (!validateCompletion && result.code !== 0) {
          const failure = new Error(
            `Skillager exit ${result.code ?? 'unknown'}${summary ? `: ${summary}` : ''}. ${operation ? 'Submitted effects require reconciliation.' : 'No mutation was requested.'}`,
          )
          if (!operation)
            failure.cli = {
              outcome: result.outcome,
              code: result.code,
              stdout: output.length <= 4096 ? output : undefined,
            }
          throw failure
        }
        let value
        try {
          value = boundedManagementJson(JSON.parse(output))
        } catch (cause) {
          if (!(cause instanceof SyntaxError)) throw cause
          const failure = new Error(
            `Skillager exit ${result.code ?? 'unknown'} returned invalid JSON${summary ? `: ${summary}` : '.'}`,
            { cause },
          )
          failure.nativeExit = result.code
          failure.nativeStderr = diagnostic
          throw failure
        }
        if (validateCompletion) validateCompletion(value, result.code, summary)
        return captureOutput ? await captureOutput(value, result.receipt) : value
      } finally {
        if (result?.receipt)
          await client
            .request('connector.output', { receipt: result.receipt, release: true })
            .catch(() => {})
      }
    },
  }
}
