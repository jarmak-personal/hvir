import type { ExtensionConnectorResult } from '../../src/shared/extensions/connectors'

/** Immediate public connector boundary for package workflow tests. Native paging has owner tests. */
export function connectorOutputFixture() {
  const receipts = new Map<
    string,
    { result: ExtensionConnectorResult; stdout: string; stderr: string }
  >()
  return {
    complete(value: object, stdout: string, stderr = '') {
      const result = {
        host: 'local',
        signal: null,
        truncated: false,
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        ...value,
      } as ExtensionConnectorResult
      receipts.set(result.receipt!, { result, stdout, stderr })
      return result
    },
    read(input: Record<string, unknown>) {
      const receipt = receipts.get(String(input['receipt']))
      if (input['release']) {
        receipts.delete(String(input['receipt']))
        return null
      }
      if (!receipt) throw new Error('Unknown fixture native receipt')
      return {
        data: input['stream'] === 'stderr' ? receipt.stderr : receipt.stdout,
        nextOffset: null,
        result: receipt.result,
      }
    },
  }
}
