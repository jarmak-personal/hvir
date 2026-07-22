import {
  DIAGNOSTIC_REPORT_NOTICE,
  DIAGNOSTIC_REPORT_VERSION,
  MAX_DIAGNOSTIC_REPORT_DROPPED_COUNTS,
  MAX_DIAGNOSTIC_REPORT_EVENTS,
  isDiagnosticReport,
  type DiagnosticReport,
  type DiagnosticReportDroppedCount,
  type DiagnosticReportEvent,
  type WorkbenchHealthSnapshot,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { DiagnosticRecentSnapshot } from './diagnostic-intake'

export interface DiagnosticReportApplicationFacts {
  readonly version: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly platform: DiagnosticReport['application']['platform']
  readonly architecture: DiagnosticReport['application']['architecture']
  readonly mode: DiagnosticReport['application']['mode']
}

/** Builds the closed report envelope from already-sanitized snapshot ports. */
export function buildDiagnosticReport(input: {
  readonly reportId: string
  readonly createdAt: string
  readonly application: DiagnosticReportApplicationFacts
  readonly owner: RendererOwner
  readonly diagnostics: DiagnosticRecentSnapshot
  readonly health: WorkbenchHealthSnapshot
}): DiagnosticReport | undefined {
  const report: DiagnosticReport = {
    version: DIAGNOSTIC_REPORT_VERSION,
    reportId: input.reportId,
    notice: DIAGNOSTIC_REPORT_NOTICE,
    createdAt: input.createdAt,
    application: input.application,
    renderer: {
      ownerId: input.owner.id,
      ownerGeneration: input.owner.generation,
      surface: 'workbench-health',
    },
    diagnostics: {
      schemaVersion: 1,
      events: input.diagnostics.events
        .slice(-MAX_DIAGNOSTIC_REPORT_EVENTS)
        .map((event): DiagnosticReportEvent => ({
          kind: event.kind,
          owner: event.owner,
          ownerGeneration: event.ownerGeneration,
          severity: event.severity,
          occurredAt: event.occurredAt,
          correlation: event.correlation,
        })),
      dropped: input.diagnostics.dropped
        .slice(-MAX_DIAGNOSTIC_REPORT_DROPPED_COUNTS)
        .map((entry): DiagnosticReportDroppedCount => ({ ...entry })),
    },
    health: input.health,
  }
  return isDiagnosticReport(report) ? report : undefined
}

export function safeVersion(value: string | undefined): string {
  return value && /^[0-9A-Za-z.+-]{1,64}$/.test(value) ? value : 'unknown'
}

export function reportPlatform(
  value: NodeJS.Platform,
): DiagnosticReport['application']['platform'] {
  if (value === 'darwin') return 'macos'
  if (value === 'linux') return 'linux'
  if (value === 'win32') return 'windows'
  return 'other'
}

export function reportArchitecture(
  value: NodeJS.Architecture,
): DiagnosticReport['application']['architecture'] {
  return value === 'arm64' || value === 'x64' ? value : 'other'
}
