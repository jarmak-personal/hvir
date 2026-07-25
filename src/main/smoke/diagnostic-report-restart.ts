import { clipboard, type BrowserWindow } from 'electron'

import { DIAGNOSTIC_REPORT_NOTICE } from '../../shared'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'

const PHASE_VARIABLE = 'HVIR_SMOKE_DIAGNOSTIC_REPORT_PHASE'
const OCCURRENCE_ID = '019c0000-0000-7000-8000-000000000244'

/** Packaged-only two-phase fixture over one retained app-data root. */
export async function verifyDiagnosticRestart(
  win: BrowserWindow,
  diagnostics: Pick<
    RuntimeDiagnostics,
    'recordApplication' | 'recordWindowHealth' | 'dispose'
  >,
): Promise<boolean> {
  const phase = process.env[PHASE_VARIABLE]
  if (!phase) return false
  if (phase === 'preceding') {
    diagnostics.recordWindowHealth({
      kind: 'renderer-unresponsive',
      ownerId: win.webContents.id,
      ownerGeneration: 1,
      occurrenceId: OCCURRENCE_ID,
    })
    diagnostics.recordWindowHealth({
      kind: 'workbench-health-recovered',
      ownerId: win.webContents.id,
      ownerGeneration: 1,
      occurrenceId: OCCURRENCE_ID,
      outcome: 'reload-selected',
    })
    diagnostics.recordApplication('application-shutdown-starting')
    diagnostics.recordApplication('application-shutdown-completed')
    await diagnostics.dispose()
    console.log('[smoke] packaged preceding diagnostic lifetime retained')
    console.log('HVIR_SMOKE_OK')
    return true
  }
  if (phase !== 'current') {
    throw new Error(`Unknown ${PHASE_VARIABLE} value: ${phase}`)
  }

  clipboard.clear()
  const preview = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      document.querySelector('.workbench-health-toggle')?.click();
      const openReport = () => {
        const prepare = [...document.querySelectorAll('.workbench-health-dialog button')]
          .find((button) => button.textContent?.trim() === 'Prepare diagnostic report');
        if (prepare) {
          prepare.click();
          return inspectReport();
        }
        if (Date.now() > deadline) return reject(new Error('report preparation control missing'));
        setTimeout(openReport, 20);
      };
      const inspectReport = () => {
        const dialog = document.querySelector('.diagnostic-report-dialog');
        const preview = dialog?.querySelector('.diagnostic-report-preview')?.textContent || '';
        const scopes = dialog?.querySelector('.diagnostic-report-evidence-scopes')?.textContent || '';
        if (
          preview.includes('"preceding-lifetime"') &&
          preview.includes('"current-lifetime"') &&
          preview.includes('"renderer-unresponsive"') &&
          preview.includes('"workbench-health-recovered"') &&
          scopes.includes('Current lifetime') &&
          scopes.includes('Preceding lifetime')
        ) {
          const copy = [...dialog.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Copy exact artifact');
          copy?.click();
          return inspectCopied(preview);
        }
        if (Date.now() > deadline) {
          return reject(new Error('cross-restart diagnostic preview missing: ' + preview));
        }
        setTimeout(inspectReport, 20);
      };
      const inspectCopied = (preview) => {
        const dialog = document.querySelector('.diagnostic-report-dialog');
        const status = dialog?.querySelector('[role="status"]')?.textContent || '';
        if (status.includes('Exact reviewed artifact copied')) {
          const remove = [...dialog.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === 'Delete temporary report');
          remove?.click();
          return resolve(preview);
        }
        if (Date.now() > deadline) return reject(new Error('cross-restart report copy missing'));
        setTimeout(() => inspectCopied(preview), 20);
      };
      openReport();
    })
  `)) as string
  const copied = clipboard.readText()
  const artifact = JSON.parse(copied) as {
    report?: {
      notice?: string
      diagnostics?: {
        scopes?: {
          currentLifetime?: { availability?: string; eventCount?: number }
          precedingLifetime?: { availability?: string; eventCount?: number }
        }
        events?: Array<{ scope?: string; kind?: string; occurredAt?: string }>
      }
    }
  }
  const report = artifact.report
  const events = report?.diagnostics?.events ?? []
  const preceding = events.filter((event) => event.scope === 'preceding-lifetime')
  const current = events.filter((event) => event.scope === 'current-lifetime')
  if (
    report?.notice !== DIAGNOSTIC_REPORT_NOTICE ||
    report.diagnostics?.scopes?.precedingLifetime?.availability !== 'included' ||
    report.diagnostics.scopes.currentLifetime?.availability !== 'included' ||
    report.diagnostics.scopes.precedingLifetime.eventCount !== preceding.length ||
    report.diagnostics.scopes.currentLifetime.eventCount !== current.length ||
    preceding.filter((event) => event.kind === 'application-starting').length !== 1 ||
    !preceding.some((event) => event.kind === 'renderer-unresponsive') ||
    !preceding.some((event) => event.kind === 'workbench-health-recovered') ||
    !current.some((event) => event.kind === 'application-starting')
  ) {
    throw new Error(`Cross-restart report scopes were incorrect: ${copied}`)
  }
  for (let index = 1; index < events.length; index++) {
    if (
      Date.parse(events[index - 1]?.occurredAt ?? '') >
      Date.parse(events[index]?.occurredAt ?? '')
    ) {
      throw new Error('Cross-restart report events were not chronological')
    }
  }
  if (JSON.stringify(report, null, 2) !== preview) {
    throw new Error('Cross-restart clipboard report differed from the exact preview')
  }
  console.log(
    '[smoke] packaged preceding + current lifetimes previewed and copied exactly',
  )
  console.log('HVIR_SMOKE_OK')
  return true
}
