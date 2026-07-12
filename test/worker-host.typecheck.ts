import type { WorkerClient } from '../src/main/worker-host'
import {
  ECHO_REQUEST_TYPE,
  type EchoResult,
  type EchoWorkerProtocol,
} from '../src/shared'

/** Compile-time regression check for the worker protocol map. */
export function assertEchoWorkerTypes(client: WorkerClient<EchoWorkerProtocol>): void {
  const result: Promise<EchoResult> = client.request(ECHO_REQUEST_TYPE, { text: 'hello' })
  void result

  // @ts-expect-error unknown worker operation
  void client.request('not-echo', { text: 'hello' })
  // @ts-expect-error wrong payload for the echo operation
  void client.request(ECHO_REQUEST_TYPE, { value: 'hello' })
}
