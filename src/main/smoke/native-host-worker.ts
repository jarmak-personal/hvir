import { ECHO_REQUEST_TYPE, type EchoWorkerProtocol, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { WorkerClient } from '../worker-host'

/** Real host calls and independent utility process identity. */
export async function verifyNativeHostWorker(
  worker: WorkerClient<EchoWorkerProtocol>,
  host: ProjectHost,
  smokeRoot: HostPath,
): Promise<void> {
  const echo = await worker.request(ECHO_REQUEST_TYPE, { text: 'ping' })
  if (echo.text !== 'ping') throw new Error('native echo mismatch')
  if (echo.workerPid === process.pid) throw new Error('echo ran in the main process')
  const result = await host.exec('/bin/echo', ['hvir'])
  if (result.stdout.trim() !== 'hvir') throw new Error('native exec mismatch')
  await host.stat(smokeRoot)
}
