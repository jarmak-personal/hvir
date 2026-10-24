import { boundCsvTable, parseCsv } from './csv-parser'
import type { CsvWorkerRequest, CsvWorkerResponse } from './csv-protocol'

self.onmessage = (event: MessageEvent<CsvWorkerRequest>): void => {
  const request = event.data
  let response: CsvWorkerResponse
  try {
    response = {
      id: request.id,
      ok: true,
      table: boundCsvTable(parseCsv(request.source)),
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  self.postMessage(response)
}
