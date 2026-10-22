import { createServer } from 'node:http'
import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { closeWebPaneSmokeServer } from './web-pane-boundary'

/** Real App activation paths must replace the selected report without withdrawing it. */
export async function verifyAgentReportNavigation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  ports: {
    readonly openFile: () => Promise<unknown>
    readonly openExtension: () => Promise<unknown>
    readonly click: (name: string) => Promise<void>
    readonly wait: (
      predicate: () => boolean | Promise<boolean>,
      label: string,
    ) => Promise<void>
  },
): Promise<void> {
  const dom = async (expression: string): Promise<boolean> =>
    Boolean(await win.webContents.executeJavaScript(expression))
  const selectReport = async (): Promise<void> => {
    await win.webContents.executeJavaScript(
      `document.querySelector('.viewer-group-primary .agent-report-tab button:not(.tab-close)').click()`,
    )
    await ports.wait(
      () =>
        dom(
          "Boolean(document.querySelector('.viewer-group-primary .agent-report-view')?.checkVisibility())",
        ),
      'report selected for navigation',
    )
  }
  const replacedBy = (selector: string, label: string): Promise<void> =>
    ports.wait(
      () =>
        dom(`!document.querySelector('.agent-report-view') &&
          Boolean(document.querySelector(${JSON.stringify(selector)})?.checkVisibility()) &&
          Boolean(document.querySelector('.agent-report-tab:not(.active)'))`),
      label,
    )
  await ports.openFile()
  await replacedBy('.viewer-body .mode-control', 'CLI document replaces report')
  const fileState = `JSON.stringify({
    mode: document.querySelector('.viewer-group-primary .viewer-body .mode-control .active')?.textContent,
    commands: document.querySelectorAll('.viewer-group-primary .find-popover, .viewer-group-primary .go-to-line-popover').length
  })`
  const before = (await win.webContents.executeJavaScript(fileState)) as string
  await selectReport()
  await win.webContents.executeJavaScript(`(() => {
    const mod = navigator.platform.includes('Mac') ? {metaKey: true} : {ctrlKey: true};
    for (const options of [{key: 'm', shiftKey: true, ...mod}, {key: 'f', ...mod}, {key: 'g', ctrlKey: true}])
      window.dispatchEvent(new KeyboardEvent('keydown', {...options, bubbles: true, cancelable: true}));
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`)
  if ((await win.webContents.executeJavaScript(fileState)) !== before)
    throw new Error('Report shortcuts changed the hidden file viewer')

  await win.webContents.executeJavaScript(
    `document.querySelector('nav[aria-label="Project views"] button:last-child').click()`,
  )
  await ports.click('History')
  await ports.wait(
    () =>
      dom(`(() => {const button = document.querySelector('.git-open-graph');
        if (!button?.checkVisibility()) return false; button.click(); return true;})()`),
    'open full graph from project rail',
  )
  await replacedBy(
    '.viewer-group-primary .git-graph-view',
    'graph activation replaces report',
  )
  await selectReport()
  await ports.openExtension()
  await replacedBy(
    '.viewer-group-primary .extension-view:not([hidden])',
    'CLI extension view replaces report',
  )
  await selectReport()

  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Report navigation</title>Report navigation')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing web fixture')
    const terminal = supervisor
      .list()
      .find((entry) => entry.ownerId === win.webContents.id)
    if (!terminal) throw new Error('Missing report navigation terminal')
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `printf '\\033[2J\\033[H%s\\n' 'http://127.0.0.1:${address.port}/report-navigation'\r`,
      terminal.ownerGeneration,
    )
    await ports.wait(
      () =>
        dom(`(() => {
        if (document.querySelector('.viewer-group-primary .web-pane-tab.active')) return true;
        const canvas = document.querySelector('.terminal-deck:not([hidden]) .terminal-surface.active canvas');
        if (!canvas) return false;
        const rect = canvas.getBoundingClientRect(), mac = navigator.platform.includes('Mac');
        for (const type of ['mousemove', 'mousedown', 'mouseup', 'click'])
          canvas.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true,
            clientX: rect.left + 24, clientY: rect.top + 8, button: 0,
            buttons: type === 'mousedown' ? 1 : 0, ctrlKey: !mac, metaKey: mac}));
        return false;
      })()`),
      'terminal link activates web view',
    )
    await replacedBy(
      '.viewer-group-primary .workspace-view:not(.web-view-hidden) .web-pane',
      'web activation replaces report',
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('.viewer-group-primary .web-pane-tab .tab-close').click()`,
    )
    await ports.wait(
      () => dom("!document.querySelector('.web-pane-tab')"),
      'close navigation web view',
    )
  } finally {
    await closeWebPaneSmokeServer(server)
  }
  await selectReport()
}
