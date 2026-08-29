import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

const CAPTURES = [
  { name: 'sessions-workspace-start.png', label: '1 · Workspace' },
  { name: 'sessions-overview.png', label: '2 · Sessions' },
  { name: 'sessions-interact.png', label: '3 · Interact' },
  { name: 'sessions-workspace-return.png', label: '4 · Workspace' },
] as const

/** Opt-in release visual capture from the closed Sessions fixture; never runs in CI. */
export async function captureSessionsVisuals(
  win: BrowserWindow,
  host: ProjectHost,
  outputDirectory: HostPath | undefined,
): Promise<readonly HostPath[]> {
  if (!outputDirectory) return []
  if (
    outputDirectory.hostId !== host.hostId ||
    !outputDirectory.path.startsWith('/') ||
    outputDirectory.path === '/'
  ) {
    throw new Error('Sessions capture directory must be a bounded absolute path')
  }
  const originalSize = win.getContentSize()
  const written: HostPath[] = []
  try {
    win.setContentSize(1280, 800)
    await installPrivacyTreatment(win)
    await capture(win, host, outputDirectory, CAPTURES[0], written)
    await openSessions(win)
    await capture(win, host, outputDirectory, CAPTURES[1], written)
    await interactWithLiveSession(win)
    await capture(win, host, outputDirectory, CAPTURES[2], written)
    await returnToWorkspace(win)
    await capture(win, host, outputDirectory, CAPTURES[3], written)
  } finally {
    await restoreWorkspace(win).catch(() => undefined)
    await removePrivacyTreatment(win).catch(() => undefined)
    win.setContentSize(originalSize[0]!, originalSize[1]!)
  }
  return written
}

async function capture(
  win: BrowserWindow,
  host: ProjectHost,
  outputDirectory: HostPath,
  capture: (typeof CAPTURES)[number],
  written: HostPath[],
): Promise<void> {
  await setCaptureLabel(win, capture.label)
  const image = await win.webContents.capturePage()
  const path = joinHostPath(outputDirectory, capture.name)
  await host.writeFile(path, image.toPNG())
  written.push(path)
}

async function installPrivacyTreatment(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      document.documentElement.dataset.hvirSessionsCapture = 'true';
      const style = document.createElement('style');
      style.id = 'hvir-sessions-capture-style';
      style.textContent = ${JSON.stringify(`
        html[data-hvir-sessions-capture='true'] * {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
        html[data-hvir-sessions-capture='true'] :is(
          .tree-panel .rail-content,
          .viewer-groups,
          .terminal-deck,
          .terminal-rail,
          .sessions-detail-terminal-container
        ) {
          position: relative !important;
          isolation: isolate;
        }
        html[data-hvir-sessions-capture='true'] :is(
          .tree-panel .rail-content,
          .viewer-groups,
          .terminal-deck,
          .terminal-rail,
          .sessions-detail-terminal-container
        ) > * {
          visibility: hidden !important;
        }
        html[data-hvir-sessions-capture='true'] :is(
          .tree-panel .rail-content,
          .viewer-groups,
          .terminal-deck,
          .terminal-rail,
          .sessions-detail-terminal-container
        )::after {
          position: absolute;
          z-index: 100;
          inset: 0;
          display: block;
          box-sizing: border-box;
          padding: 18px;
          overflow: hidden;
          background: #111318;
          color: #abb4c0;
          font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: pre-wrap;
          visibility: visible !important;
        }
        html[data-hvir-sessions-capture='true'] .tree-panel .rail-content::after {
          content: 'Synthetic workspace\\A\\A README.md\\A src/\\A docs/';
        }
        html[data-hvir-sessions-capture='true'] .viewer-groups::after {
          content: '# Session-aware workbench\\A\\A Explore the workspace while tasks continue in the background.\\A\\A Open Sessions whenever attention moves across projects.';
          padding: 42px;
          background: #15181e;
          color: #c7ced8;
          font: 15px/1.8 ui-sans-serif, system-ui, sans-serif;
        }
        html[data-hvir-sessions-capture='true'] .terminal-deck::after,
        html[data-hvir-sessions-capture='true'] .sessions-detail-terminal-container::after {
          content: '$ hvir task\\A Working in a synthetic fixture…';
        }
        html[data-hvir-sessions-capture='true'] .terminal-rail::after {
          content: 'Terminals\\A\\A ● Shell terminal\\A   working';
        }
        html[data-hvir-sessions-capture='true'] .sessions-detail-header p {
          display: none !important;
        }
        html[data-hvir-sessions-capture='true'] .session-kind.agent + h3 {
          font-size: 0 !important;
        }
        html[data-hvir-sessions-capture='true'] .session-kind.agent + h3::after {
          content: 'Agent session';
          font-size: calc(11px * var(--hvir-interface-scale));
        }
        #hvir-sessions-capture-label {
          position: fixed;
          z-index: 1000;
          right: 18px;
          bottom: 18px;
          padding: 8px 12px;
          border: 1px solid #52667d;
          border-radius: 999px;
          background: rgb(18 24 32 / 92%);
          box-shadow: 0 8px 30px rgb(0 0 0 / 35%);
          color: #edf3fa;
          font: 650 14px/1.2 ui-sans-serif, system-ui, sans-serif;
          letter-spacing: 0.01em;
        }
      `)};
      document.head.append(style);
      const label = document.createElement('div');
      label.id = 'hvir-sessions-capture-label';
      label.setAttribute('aria-hidden', 'true');
      document.body.append(label);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}

async function setCaptureLabel(win: BrowserWindow, label: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const element = document.querySelector('#hvir-sessions-capture-label');
      if (!(element instanceof HTMLElement)) {
        return reject(new Error('Sessions capture label was not installed'));
      }
      element.textContent = ${JSON.stringify(label)};
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}

async function openSessions(win: BrowserWindow): Promise<void> {
  await waitForState(
    win,
    `document.querySelector('.sessions-destination')?.click()`,
    `document.querySelectorAll('.sessions-overview .session-card').length >= 5`,
    'overview',
  )
}

async function interactWithLiveSession(win: BrowserWindow): Promise<void> {
  await waitForState(
    win,
    `
      const overview = document.querySelector('.sessions-overview');
      const card = overview && [...overview.querySelectorAll('.session-card')].find(
        (candidate) =>
          candidate.querySelector('.session-kind.shell') &&
          [...candidate.querySelectorAll('button')].some(
            (button) => button.textContent?.trim() === 'Interact'
          )
      );
      [...(card?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Interact')?.click();
    `,
    `Boolean(document.querySelector('.sessions-terminal-detail .terminal-engine-host'))`,
    'interactive detail',
  )
}

async function returnToWorkspace(win: BrowserWindow): Promise<void> {
  await waitForState(
    win,
    `
      [...document.querySelectorAll('.sessions-terminal-detail button')]
        .find((button) => button.textContent?.trim() === 'Go to workspace')?.click();
    `,
    `
      !document.querySelector('.sessions-overview') &&
      document.querySelector('.workbench') instanceof HTMLElement &&
      !document.querySelector('.workbench').hidden
    `,
    'workspace return',
  )
}

async function restoreWorkspace(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const detail = document.querySelector('.sessions-terminal-detail');
      if (detail) {
        [...detail.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === 'Go to workspace')?.click();
      } else if (document.querySelector('.sessions-overview')) {
        document.querySelector('.project-tab .project-tab-main')?.click();
      }
    })()
  `)
}

async function removePrivacyTreatment(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      delete document.documentElement.dataset.hvirSessionsCapture;
      document.querySelector('#hvir-sessions-capture-style')?.remove();
      document.querySelector('#hvir-sessions-capture-label')?.remove();
    })()
  `)
}

async function waitForState(
  win: BrowserWindow,
  action: string,
  condition: string,
  stage: string,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      ${action};
      const poll = () => {
        if (${condition}) {
          return requestAnimationFrame(() => requestAnimationFrame(resolve));
        }
        if (Date.now() > deadline) {
          return reject(new Error('Sessions visual capture timed out at ' + ${JSON.stringify(stage)}));
        }
        setTimeout(poll, 25);
      };
      poll();
    })
  `)
}
