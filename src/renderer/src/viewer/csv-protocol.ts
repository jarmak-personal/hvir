import type { CsvTableData } from './csv-parser'

export interface CsvWorkerRequest {
  readonly id: number
  readonly source: string
}

export type CsvWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly table: CsvTableData }
  | { readonly id: number; readonly ok: false; readonly error: string }
