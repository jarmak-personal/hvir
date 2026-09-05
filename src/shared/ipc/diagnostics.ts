import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type RenderContainmentDiagnosticBatch,
  type RendererDiagnosticSession,
} from '../diagnostics'
import { type WorkbenchHealthSnapshot } from '../workbench-health'
import {
  type DiagnosticEvidenceDeleteResult,
  type DiagnosticEvidenceState,
} from '../diagnostic-evidence'
import {
  type CaptureDiagnosticReportRequest,
  type CreateDiagnosticReportRequest,
  type DiagnosticReportActionResult,
  type DiagnosticReportIdRequest,
  type DiagnosticReportStateResult,
} from '../diagnostic-report'

export const diagnosticsIpc = {
  invoke: {
    'workbench-health:get': invoke<void, WorkbenchHealthSnapshot>(),
    'workbench-health:acknowledge': invoke<
      { readonly occurrenceId: string },
      WorkbenchHealthSnapshot
    >(),
    'diagnostic-evidence:get': invoke<void, DiagnosticEvidenceState>(),
    'diagnostic-evidence:delete': invoke<void, DiagnosticEvidenceDeleteResult>(),
    'diagnostic-report:create': invoke<
      CreateDiagnosticReportRequest,
      DiagnosticReportStateResult
    >(),
    'diagnostic-report:capture': invoke<
      CaptureDiagnosticReportRequest,
      DiagnosticReportStateResult
    >(),
    'diagnostic-report:copy': invoke<
      DiagnosticReportIdRequest,
      DiagnosticReportActionResult
    >(),
    'diagnostic-report:save': invoke<
      DiagnosticReportIdRequest,
      DiagnosticReportActionResult
    >(),
    'diagnostic-report:cancel': invoke<
      DiagnosticReportIdRequest,
      DiagnosticReportActionResult
    >(),
    'diagnostic-report:delete': invoke<
      DiagnosticReportIdRequest,
      DiagnosticReportActionResult
    >(),
  },
  send: {
    'diagnostics:render-containment': payload<RenderContainmentDiagnosticBatch>(),
  },
  event: {
    'diagnostics:session': payload<RendererDiagnosticSession>(),
    'workbench-health:state': payload<WorkbenchHealthSnapshot>(),
  },
} satisfies IpcFeatureContract
