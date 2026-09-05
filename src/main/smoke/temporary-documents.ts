import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { hostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'

/** Real terminal activation → preload/main/ProjectHost → worker and Chromium display. */
export async function verifyTemporaryDocuments(
  win: BrowserWindow,
  host: ProjectHost,
  supervisor: PtySupervisor,
): Promise<void> {
  const root = hostPath(host.hostId, `/tmp/hvir-smoke-document-${randomUUID()}`)
  await host.exec('mkdir', ['--', root.path])
  try {
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/plan.md`),
      '# Temporary plan\n\n[HTML report](report.html)\n\n![pixel](pixel.png)',
    )
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/report.html`),
      '<h1>Temporary HTML</h1>',
    )
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/pixel.png`),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZekAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    await ensureExplicitBareShellLaunch(win, supervisor)
    const terminal = supervisor
      .list()
      .find((entry) => entry.ownerId === win.webContents.id)
    if (!terminal) throw new Error('Temporary document source terminal missing')
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/plan.md`),
    )
    await win.webContents
      .executeJavaScript(
        `
      (async () => {
        const wait = (read) => new Promise((resolve) => {
          const poll = () => read() ? resolve() : setTimeout(poll, 25); poll();
        });
        await wait(() => document.querySelector('.markdown-body h1')?.textContent === 'Temporary plan' && document.querySelector('.markdown-body img')?.naturalWidth === 1);
        const source = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'source');
        source.click();
        await wait(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false');
        const diff = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'diff');
        if (!diff?.disabled || document.querySelector('.blame-toggle')) throw new Error('Temporary source exposed Git controls');
        const rendered = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'rendered');
        rendered.click();
        await wait(() => document.querySelector('.markdown-body a'));
        document.querySelector('.markdown-body a').click();
        await wait(() => document.querySelector('iframe.html-preview'));
        const preview = document.querySelector('iframe.html-preview');
        if (preview.getAttribute('sandbox') !== 'allow-scripts') throw new Error('Temporary HTML sandbox changed');
        return preview.src;
      })()
    `,
      )
      .then(async (url: string) => {
        const frame = await new Promise<Electron.WebFrameMain>((resolve) => {
          const poll = (): void => {
            const found = win.webContents.mainFrame.frames.find(
              (candidate) => candidate.url === url,
            )
            if (found) resolve(found)
            else setTimeout(poll, 25)
          }
          poll()
        })
        await frame.executeJavaScript(`new Promise((resolve, reject) => {
        const poll = () => {
          if (document.querySelector('h1')?.textContent !== 'Temporary HTML') return setTimeout(poll, 25);
          if (typeof require !== 'undefined' || typeof window.hvir !== 'undefined') return reject(new Error('Temporary preview acquired workbench authority'));
          resolve();
        }; poll();
      })`)
        await win.webContents.executeJavaScript(
          `document.querySelector('.viewer-tab.active .tab-close').click()`,
        )
        const response = await win.webContents.session.fetch(url)
        if (response.status !== 404)
          throw new Error('Closed temporary preview retained content')
      })
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/missing.md`),
    )
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const poll = () => document.querySelector('.viewer-empty.error') ? resolve() : setTimeout(poll, 25); poll();
    })`)
    console.log(
      '[smoke] temporary documents OK (terminal activation, Markdown/image, read-only source, HTML sandbox/release, missing file)',
    )
  } finally {
    await host.exec('rm', ['-rf', '--', root.path])
  }
}

async function activateTerminalDocument(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminal: ReturnType<PtySupervisor['list']>[number],
  path: HostPath,
): Promise<void> {
  // The path is generated by this fixture; shell quoting still remains explicit.
  const quoted = `'${path.path.replaceAll("'", "'\\''")}'`
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `printf '\\033[2J\\033[H%s\\n' ${quoted}\r`,
  )
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const poll = () => {
      const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent;
      if (title === ${JSON.stringify(path.path.split('/').at(-1))}) return resolve();
      const canvas = document.querySelector('.terminal-deck:not([hidden]) .terminal-surface.active canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) canvas.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: rect.left + 24, clientY: rect.top + 8,
          button: 0, buttons: type === 'mousedown' ? 1 : 0,
          ctrlKey: !navigator.platform.includes('Mac'), metaKey: navigator.platform.includes('Mac'),
        }));
      }
      setTimeout(poll, 50);
    }; poll();
  })`)
}
