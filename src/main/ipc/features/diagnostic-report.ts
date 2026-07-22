import {
  isCaptureDiagnosticReportRequest,
  isCreateDiagnosticReportRequest,
  isDiagnosticReportIdRequest,
  type DiagnosticReportActionResult,
  type DiagnosticReportStateResult,
} from '../../../shared'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type ReportIpcDeps = Pick<IpcDeps, 'diagnosticReports'>

export function registerDiagnosticReportIpc(
  ipc: IpcRegistrar,
  deps: ReportIpcDeps,
): void {
  ipc.handle('diagnostic-report:create', (request, context) => {
    const owner = context.owner()
    return isCreateDiagnosticReportRequest(request)
      ? deps.diagnosticReports.create(owner, request.reportId)
      : invalidState()
  })
  ipc.handle('diagnostic-report:capture', (request, context) => {
    const owner = context.owner()
    return isCaptureDiagnosticReportRequest(request)
      ? deps.diagnosticReports.capture(owner, request.reportId, request.masks)
      : invalidState()
  })
  ipc.handle('diagnostic-report:copy', (request, context) =>
    reportAction(request, context.owner(), deps, 'copy'),
  )
  ipc.handle('diagnostic-report:save', (request, context) =>
    reportAction(request, context.owner(), deps, 'save'),
  )
  ipc.handle('diagnostic-report:cancel', (request, context) =>
    reportAction(request, context.owner(), deps, 'cancel'),
  )
  ipc.handle('diagnostic-report:delete', (request, context) =>
    reportAction(request, context.owner(), deps, 'delete'),
  )
}

function reportAction(
  request: unknown,
  owner: Parameters<ReportIpcDeps['diagnosticReports']['copy']>[0],
  deps: ReportIpcDeps,
  action: 'copy' | 'save' | 'cancel' | 'delete',
): DiagnosticReportActionResult | Promise<DiagnosticReportActionResult> {
  if (!isDiagnosticReportIdRequest(request)) return invalidAction()
  return deps.diagnosticReports[action](owner, request.reportId)
}

function invalidState(): DiagnosticReportStateResult {
  return { ok: false, reason: 'invalid-request' }
}

function invalidAction(): DiagnosticReportActionResult {
  return { ok: false, reason: 'invalid-request' }
}
