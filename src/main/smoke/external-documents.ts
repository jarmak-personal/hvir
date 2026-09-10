import { randomBytes } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { hostPath, type HostPath, type ProjectState } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { sendRendererEvent } from '../renderer-event-delivery'

export interface ExternalDocumentProjectState {
  get(): ProjectState
  set(state: ProjectState): ProjectState
}

/** Real terminal activation → preload/main/ProjectHost → worker and Chromium display. */
export async function verifyExternalDocuments(
  win: BrowserWindow,
  host: ProjectHost,
  supervisor: PtySupervisor,
  projectState: ExternalDocumentProjectState,
): Promise<void> {
  // The fixture lives outside temporary roots; OSC links fit narrow terminal panes.
  const home = await host.exec('sh', ['-c', 'printf %s "$HOME"'])
  const root = hostPath(
    host.hostId,
    `${home.stdout}/.hvir-${randomBytes(8).toString('hex')}`,
  )
  await host.exec('mkdir', ['--', root.path])
  try {
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/plan.md`),
      '# External plan\n\n[HTML report](report.html)\n\n![pixel](pixel.png)\n\n![denied](../private/chart.png)',
    )
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/report.html`),
      '<h1>External HTML</h1>',
    )
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/pixel.png`),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZekAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    await host.writeFile(
      hostPath(host.hostId, `${root.path}/code.ts`),
      'const first = 1\nconst second = 2\n',
    )
    win.setContentSize(800, 800)
    await ensureExplicitBareShellLaunch(win, supervisor)
    console.log('[smoke] external document terminal ready')
    const terminal = supervisor
      .list()
      .find((entry) => entry.ownerId === win.webContents.id)
    if (!terminal) throw new Error('External document source terminal missing')
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/plan.md`),
    )
    console.log('[smoke] external Markdown activated')
    await win.webContents
      .executeJavaScript(
        `
      (async () => {
        const wait = (read, phase) => new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const poll = () => {
            if (read()) return resolve();
            if (Date.now() > deadline) return reject(new Error('External document ' + phase + ' unavailable'));
            setTimeout(poll, 25);
          }; poll();
        });
        await wait(() => document.querySelector('.markdown-body h1')?.textContent === 'External plan' && document.querySelector('.markdown-body img')?.naturalWidth === 1, 'Markdown/image');
        await wait(() => document.querySelector('.markdown-image-unavailable'), 'denied image');
        if (!document.querySelector('.view-controls')?.textContent.includes('outside project')) throw new Error('External location status missing');
        const source = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'source');
        source.click();
        await wait(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'false', 'read-only source');
        const diff = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'diff');
        if (!diff?.disabled || document.querySelector('.blame-toggle')) throw new Error('External source exposed Git controls');
        const rendered = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent === 'rendered');
        rendered.click();
        await wait(() => document.querySelector('.markdown-body a'), 'rendered link');
        document.querySelector('.markdown-body a').click();
        await wait(() => document.querySelector('iframe.html-preview'), 'HTML preview');
        const preview = document.querySelector('iframe.html-preview');
        if (preview.getAttribute('sandbox') !== 'allow-scripts') throw new Error('External HTML sandbox changed');
        return preview.src;
      })()
    `,
      )
      .then(async (url: string) => {
        const frame = await new Promise<Electron.WebFrameMain>((resolve, reject) => {
          const deadline = Date.now() + 15000
          const poll = (): void => {
            const found = win.webContents.mainFrame.frames.find(
              (candidate) => candidate.url === url,
            )
            if (found) resolve(found)
            else if (Date.now() > deadline)
              reject(new Error('External HTML frame unavailable'))
            else setTimeout(poll, 25)
          }
          poll()
        })
        await frame.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
          if (Date.now() > deadline) return reject(new Error('External HTML content unavailable'));
          if (document.querySelector('h1')?.textContent !== 'External HTML') return setTimeout(poll, 25);
          if (typeof require !== 'undefined' || typeof window.hvir !== 'undefined') return reject(new Error('External preview acquired workbench authority'));
          resolve();
        }; poll();
      })`)
        await win.webContents.executeJavaScript(
          `document.querySelector('.viewer-tab.active .tab-close').click()`,
        )
        await requireReleasedPreview(win, url)
      })
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/code.ts`),
    )
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        const code = document.querySelector('.cm-content');
        if (code?.textContent.includes('const second') && code.getAttribute('contenteditable') === 'false') return resolve();
        if (Date.now() > deadline) return reject(new Error('Outside-project code source unavailable'));
        setTimeout(poll, 25);
      }; poll();
    })`)
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/pixel.png`),
    )
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        if (document.querySelector('.image-view img')?.naturalWidth === 1) return resolve();
        if (Date.now() > deadline) return reject(new Error('Outside-project image viewer unavailable'));
        setTimeout(poll, 25);
      }; poll();
    })`)
    console.log('[smoke] external HTML released; activating missing document')
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/missing.md`),
    )
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        if (document.querySelector('.viewer-empty.error')) return resolve();
        if (Date.now() > deadline) return reject(new Error('External missing-file error unavailable'));
        setTimeout(poll, 25);
      }; poll();
    })`)
    // Reopen HTML through the real terminal/viewer path, then deliver a same-root
    // disconnect through production IPC. This exercises App's actual state fanout.
    await activateTerminalDocument(
      win,
      supervisor,
      terminal,
      hostPath(host.hostId, `${root.path}/report.html`),
    )
    const previewUrl = (await win.webContents
      .executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = () => {
        const preview = document.querySelector('iframe.html-preview');
        if (preview) return resolve(preview.src);
        if (Date.now() > deadline) return reject(new Error('External disconnect preview unavailable'));
        setTimeout(poll, 25);
      }; poll();
    })`)) as string
    const connected = projectState.get()
    const publishState = (state: ProjectState): void =>
      sendRendererEvent(win.webContents, 'project:state', projectState.set(state))
    try {
      publishState({
        ...connected,
        connectionState: 'disconnected',
        projects: connected.projects.map((project) =>
          project.id === connected.activeProjectId
            ? { ...project, connectionState: 'disconnected' }
            : project,
        ),
      })
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const poll = () => {
          const externalTabs = [...document.querySelectorAll('.viewer-tab .tab-main')]
            .some((tab) => tab.getAttribute('title')?.startsWith(${JSON.stringify(root.path + '/')}));
          if (!externalTabs && !document.querySelector('iframe.html-preview')) return resolve();
          if (Date.now() > deadline) return reject(new Error('Same-root disconnect retained external viewer state'));
          setTimeout(poll, 25);
        }; poll();
      })`)
      await requireReleasedPreview(win, previewUrl)
    } finally {
      publishState(connected)
    }
    console.log(
      '[smoke] external documents OK (terminal activation, Markdown/image, read-only source, HTML sandbox/release, missing file, same-root disconnect)',
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
  const quoted = `'${('file://' + path.path).replaceAll("'", "'\\''")}'`
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `printf '\\033[2J\\033[H\\033]8;;%s\\007document\\033]8;;\\007\\n' ${quoted}\r`,
  )
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      if (Date.now() > deadline) return reject(new Error('External terminal link activation unavailable'));
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

/** Renderer release is asynchronous; wait for the protocol's observable revocation. */
async function requireReleasedPreview(win: BrowserWindow, url: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const response = await win.webContents.session.fetch(url)
    await response.body?.cancel()
    if (response.status === 404) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('External preview retained content after revocation')
}
