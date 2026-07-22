import { clipboard, nativeImage, type BrowserWindow } from 'electron'

import { DIAGNOSTIC_REPORT_NOTICE } from '../../shared'

const SENTINEL = '/secret/project TOKEN=hvir-health-smoke'

/** Real Electron event wiring plus renderer presentation for a console-only load fault. */
export async function verifyWorkbenchHealthFault(win: BrowserWindow): Promise<string> {
  const responsiveness = await verifyResponsivenessDiagnostics(win)
  win.webContents.emit('did-fail-load', {}, -105, SENTINEL, `file://${SENTINEL}`, true)
  const opened = (await win.webContents.executeJavaScript(
    waitForHealthLabel('1 unresolved fault'),
  )) as string
  if (opened.includes(SENTINEL))
    throw new Error('Health affordance exposed fault context')

  win.webContents.emit('did-finish-load')
  await win.webContents.executeJavaScript(waitForHealthLabel('no unresolved faults'))
  clipboard.clear()
  const reviewed = (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      let pixelSentinel;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const text = document.querySelector('.workbench-health-dialog')?.textContent || '';
        if (text.includes('Workbench document failed to load') && text.includes('resolved')) {
          const prepare = [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Prepare diagnostic report');
          prepare?.click();
          inspectReport(text);
        } else if (Date.now() > deadline) {
          reject(new Error('resolved workbench health history missing'));
        } else {
          setTimeout(inspect, 20);
        }
      };
      const inspectReport = (history) => {
        const dialog = document.querySelector('.diagnostic-report-dialog');
        const preview = dialog?.querySelector('.diagnostic-report-preview')?.textContent || '';
        if (!dialog || !preview.includes('renderer-responsiveness-episode') ||
            !preview.includes('main-document-load-failed') ||
            !preview.includes('workbench-health-recovered')) {
          if (Date.now() > deadline) return reject(new Error('diagnostic report preview missing'));
          return setTimeout(() => inspectReport(history), 20);
        }
        const noImageInitially = !dialog.querySelector('img');
        const tree = document.querySelector('.tree-panel');
        const treeRect = tree?.getBoundingClientRect();
        if (treeRect) {
          pixelSentinel = document.createElement('div');
          pixelSentinel.textContent = ${JSON.stringify(SENTINEL)};
          pixelSentinel.style.cssText = [
            'position:fixed',
            'pointer-events:none',
            'z-index:2147483647',
            'background:rgb(237,17,91)',
            'color:rgb(255,255,255)',
            'width:24px',
            'height:24px',
            'overflow:hidden',
            'left:' + (treeRect.x + Math.max(0, treeRect.width / 2 - 12)) + 'px',
            'top:' + (treeRect.y + Math.max(0, treeRect.height / 2 - 12)) + 'px'
          ].join(';');
          document.body.append(pixelSentinel);
        }
        const sentinelRect = pixelSentinel?.getBoundingClientRect();
        const rect = sentinelRect ? {
          x: sentinelRect.x,
          y: sentinelRect.y,
          width: sentinelRect.width,
          height: sentinelRect.height
        } : undefined;
        const capture = [...dialog.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Capture masked screenshot');
        capture?.click();
        inspectCapture(history, preview, noImageInitially, rect);
      };
      const inspectCapture = (history, preview, noImageInitially, rect) => {
        const dialog = document.querySelector('.diagnostic-report-dialog');
        const image = dialog?.querySelector('img');
        const status = dialog?.querySelector('[role="status"]')?.textContent || '';
        if (!image || !status.includes('Screenshot included')) {
          if (Date.now() > deadline) return reject(new Error('masked screenshot missing'));
          return setTimeout(
            () => inspectCapture(history, preview, noImageInitially, rect),
            20
          );
        }
        pixelSentinel?.remove();
        const masked = dialog?.querySelector('.diagnostic-report-image dl')?.textContent || '';
        const copy = [...dialog.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Copy exact artifact');
        copy?.click();
        inspectCopy({ history, preview, noImageInitially, rect, masked, src: image.src });
      };
      const inspectCopy = (result) => {
        const dialog = document.querySelector('.diagnostic-report-dialog');
        const status = dialog?.querySelector('[role="status"]')?.textContent || '';
        if (!status.includes('Exact reviewed artifact copied.')) {
          if (Date.now() > deadline) return reject(new Error('diagnostic report copy missing'));
          return setTimeout(() => inspectCopy(result), 20);
        }
        const remove = [...dialog.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Delete temporary report');
        remove?.click();
        const inspectDeleted = () => {
          if (!document.querySelector('.diagnostic-report-dialog')) return resolve(result);
          if (Date.now() > deadline) return reject(new Error('temporary report was not deleted'));
          setTimeout(inspectDeleted, 20);
        };
        inspectDeleted();
      };
      inspect();
    })
  `)) as {
    history: string
    preview: string
    noImageInitially: boolean
    rect?: { x: number; y: number; width: number; height: number }
    masked: string
    src: string
  }
  const copied = clipboard.readText()
  if (`${reviewed.history}${reviewed.preview}${copied}`.includes(SENTINEL)) {
    throw new Error('Reviewed diagnostic artifact exposed fault context')
  }
  if (!reviewed.noImageInitially) throw new Error('Diagnostic screenshot was automatic')
  if (!reviewed.masked.includes('project-navigation')) {
    throw new Error('Project navigation was not included in the capture mask inventory')
  }
  const artifact = JSON.parse(copied) as {
    report?: { notice?: string }
    screenshot?: { dataUrl?: string }
  }
  if (artifact.report?.notice !== DIAGNOSTIC_REPORT_NOTICE) {
    throw new Error('Clipboard report omitted its untrusted-material delimiter')
  }
  if (JSON.stringify(artifact.report, null, 2) !== reviewed.preview) {
    throw new Error('Clipboard report differed from the exact structured preview')
  }
  if (artifact.screenshot?.dataUrl !== reviewed.src) {
    throw new Error('Clipboard image differed from the exact image preview')
  }
  const events = (artifact.report as { diagnostics?: { events?: unknown[] } }).diagnostics
    ?.events
  const episode = events?.find(
    (event) =>
      typeof event === 'object' &&
      event !== null &&
      'kind' in event &&
      event.kind === 'renderer-responsiveness-episode',
  ) as { count?: number; timing?: string; classification?: string } | undefined
  if (
    episode?.count !== 2 ||
    episode.timing !== '200-499ms' ||
    episode.classification !== 'unattributed'
  ) {
    throw new Error(`Responsiveness aggregate was not exact: ${JSON.stringify(episode)}`)
  }
  assertMaskedPixel(win, reviewed)
  await deleteResponsivenessEvidence(win)
  await deleteLocalDiagnosticEvidence(win)
  return `${responsiveness}; resolved fault previewed, masked, copied exactly, and all local evidence deleted`
}

async function verifyResponsivenessDiagnostics(win: BrowserWindow): Promise<string> {
  return (await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        return reject(new Error('pinned Chromium Long Tasks API unavailable'));
      }
      document.querySelector('.workbench-health-toggle')?.click();
      const waitForStart = () => {
        const dialog = document.querySelector('.workbench-health-dialog');
        const start = [...(dialog?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === 'Start responsiveness diagnostics');
        if (start) {
          start.click();
          return waitForIndicator();
        }
        if (Date.now() > deadline) return reject(new Error('diagnostic start missing'));
        setTimeout(waitForStart, 20);
      };
      const waitForIndicator = () => {
        if (document.querySelector('.responsiveness-diagnostics-indicator')) {
          return setTimeout(firstFault, 1200);
        }
        if (Date.now() > deadline) return reject(new Error('diagnostic indicator missing'));
        setTimeout(waitForIndicator, 20);
      };
      const block = (duration) => {
        const started = performance.now();
        while (performance.now() - started < duration) { /* deterministic fixture */ }
      };
      const firstFault = () => {
        block(120);
        setTimeout(() => {
          block(220);
          waitForObservation();
        }, 50);
      };
      const waitForObservation = () => {
        const text = document.querySelector('.responsiveness-diagnostics-panel')?.textContent || '';
        if (text.includes('2 observations')) {
          const stop = [...document.querySelectorAll('.responsiveness-diagnostics-panel button')]
            .find((button) => button.textContent?.trim() === 'Stop and retain evidence');
          stop?.click();
          return waitForComplete();
        }
        if (Date.now() > deadline) return reject(new Error('Long Tasks observation missing: ' + text));
        setTimeout(waitForObservation, 20);
      };
      const waitForComplete = () => {
        const text = document.querySelector('.responsiveness-diagnostics-panel')?.textContent || '';
        const health = document.querySelector('.workbench-health-toggle')
          ?.getAttribute('aria-label') || '';
        if (text.includes('1 bounded aggregate retained for Preview')) {
          if (!health.includes('no unresolved faults')) {
            return reject(new Error('Long Tasks changed workbench health: ' + health));
          }
          [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close')?.click();
          return resolve('opt-in Long Tasks aggregate retained without health status');
        }
        if (Date.now() > deadline) return reject(new Error('diagnostic stop missing: ' + text));
        setTimeout(waitForComplete, 20);
      };
      waitForStart();
    })
  `)) as string
}

async function deleteResponsivenessEvidence(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const panel = document.querySelector('.responsiveness-diagnostics-panel');
        const remove = [...(panel?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === 'Delete evidence');
        if (remove) {
          remove.click();
          return waitForIdle();
        }
        if (Date.now() > deadline) return reject(new Error('responsiveness delete missing'));
        setTimeout(inspect, 20);
      };
      const waitForIdle = () => {
        const text = document.querySelector('.responsiveness-diagnostics-panel')?.textContent || '';
        if (text.includes('Start responsiveness diagnostics')) {
          [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close')?.click();
          return resolve();
        }
        if (Date.now() > deadline) return reject(new Error('responsiveness evidence remained'));
        setTimeout(waitForIdle, 20);
      };
      inspect();
    })
  `)
}

async function deleteLocalDiagnosticEvidence(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      document.querySelector('.workbench-health-toggle')?.click();
      const inspect = () => {
        const storage = document.querySelector('.workbench-health-storage');
        const text = storage?.textContent || '';
        const remove = [...(storage?.querySelectorAll('button') || [])]
          .find((button) => button.textContent?.trim() === 'Delete local evidence');
        if (text.includes('256 events') && text.includes('4 × 1 MiB') &&
            text.includes('runtime-diagnostics.jsonl') && remove) {
          remove.click();
          return waitForDeleted();
        }
        if (Date.now() > deadline) {
          return reject(new Error('local diagnostic evidence controls missing: ' + text));
        }
        setTimeout(inspect, 20);
      };
      const waitForDeleted = () => {
        const storage = document.querySelector('.workbench-health-storage');
        const status = storage?.querySelector('[role="status"]')?.textContent || '';
        if (status.includes('Local diagnostic evidence deleted')) {
          [...document.querySelectorAll('.workbench-health-dialog button')]
            .find((button) => button.textContent?.trim() === 'Close')?.click();
          return resolve();
        }
        if (Date.now() > deadline) {
          return reject(new Error('local diagnostic evidence remained: ' + status));
        }
        setTimeout(waitForDeleted, 20);
      };
      inspect();
    })
  `)
}

function assertMaskedPixel(
  win: BrowserWindow,
  reviewed: {
    rect?: { x: number; y: number; width: number; height: number }
    src: string
  },
): void {
  if (!reviewed.rect) throw new Error('Project navigation capture target was missing')
  const image = nativeImage.createFromDataURL(reviewed.src)
  const size = image.getSize(1)
  const viewport = win.getContentBounds()
  const x = Math.floor(
    (reviewed.rect.x + reviewed.rect.width / 2) * (size.width / viewport.width),
  )
  const y = Math.floor(
    (reviewed.rect.y + reviewed.rect.height / 2) * (size.height / viewport.height),
  )
  const offset = (y * size.width + x) * 4
  const pixel = image.toBitmap({ scaleFactor: 1 }).subarray(offset, offset + 4)
  if (
    pixel.length !== 4 ||
    pixel[0] !== 32 ||
    pixel[1] !== 32 ||
    pixel[2] !== 32 ||
    pixel[3] !== 255
  ) {
    throw new Error(
      `Owned project navigation pixels were not masked (${[...pixel].join(',')} at ${x},${y}; image ${size.width}x${size.height}; viewport ${viewport.width}x${viewport.height}; target ${JSON.stringify(reviewed.rect)})`,
    )
  }
}

function waitForHealthLabel(expected: string): string {
  return `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const inspect = () => {
        const label = document.querySelector('.workbench-health-toggle')?.getAttribute('aria-label') || '';
        if (label.includes(${JSON.stringify(expected)})) resolve(label);
        else if (Date.now() > deadline) reject(new Error('workbench health affordance missing: ' + label));
        else setTimeout(inspect, 20);
      };
      inspect();
    })
  `
}
