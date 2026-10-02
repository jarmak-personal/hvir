import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { BrowserWindow } from 'electron'

/** Opt-in captures contain only the smoke's closed repository fixtures. */
export async function capturePresentationVisuals(
  win: BrowserWindow,
  host: ProjectHost,
): Promise<void> {
  const output = process.env['HVIR_PRESENTATION_CAPTURE_DIRECTORY']
  if (!output) return
  if (!output.startsWith('/') || output === '/')
    throw new Error('Invalid capture directory')
  await host
    .createDirectoryExclusive(localPath(output), { mode: 0o755 })
    .catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await host.stat(localPath(output))).type !== 'dir')
        throw new Error('Capture output is not a directory')
    })
  const size = win.getContentSize()
  const theme: unknown = await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )
  const selected: unknown = await win.webContents.executeJavaScript(
    `document.querySelector('.viewer-tab.active .tab-main')?.getAttribute('title')`,
  )
  const navigation: unknown = await win.webContents.executeJavaScript(
    `document.querySelector('.rail-nav button.active')?.textContent?.trim()`,
  )
  const settingsSection: unknown = await win.webContents.executeJavaScript(
    `document.querySelector('.settings-section-index button[aria-current="page"]')?.getAttribute('aria-controls')`,
  )
  if (settingsSection)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.settings-dialog button')].find(button => button.textContent?.trim() === 'Close settings').click()`,
    )
  const surfaces = [
    ['markdown', 'rendered.md', '.markdown-body'],
    ['csv', 'rendered.csv', '.csv-view'],
    ['image', 'rendered-image.svg', '.image-view img'],
    ['json', 'package.json', '.json-tree'],
  ] as const
  try {
    win.setContentSize(1280, 800)
    for (const appearance of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`
        new Promise(resolve => {
          if (document.documentElement.dataset.theme !== ${JSON.stringify(appearance)})
            document.querySelector('.theme-toggle').click();
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        })
      `)
      for (const [name, file, ready] of surfaces) {
        await win.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const row = [...document.querySelectorAll('.file-row')].find(node =>
              node.querySelector('.tree-file-name')?.textContent?.trim() === ${JSON.stringify(file)});
            if (!row) return reject(new Error('Capture fixture absent'));
            row.click();
            const deadline = Date.now() + 10000;
            const poll = () => {
              const surface = document.querySelector(${JSON.stringify(ready)});
              const tab = document.querySelector('.viewer-tab.active .tab-name');
              if (surface && tab?.textContent?.trim() === ${JSON.stringify(file)})
                return requestAnimationFrame(() => requestAnimationFrame(resolve));
              if (Date.now() > deadline) return reject(new Error('Capture surface not ready'));
              setTimeout(poll, 25);
            };
            poll();
          })
        `)
        if (name === 'markdown')
          console.log(
            '[smoke] presentation computed',
            appearance,
            await win.webContents.executeJavaScript(
              `(() => { const tab = document.querySelector('.viewer-tab.active'), nav = document.querySelector('.rail-nav button.active'); return [tab,nav].map(node => { const css = getComputedStyle(node); return {class:node.className,border:css.borderTop,bottom:css.borderBottom,background:css.backgroundColor,color:css.color,font:css.fontSize}; }); })()`,
            ),
          )
        await host.writeFile(
          joinHostPath(localPath(output), `${name}-${appearance}.png`),
          (await win.webContents.capturePage()).toPNG(),
        )
      }
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.rail-nav button')].find(button => button.textContent?.trim().startsWith('Git'))?.click()`,
      )
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const poll = () => document.querySelector('.git-tabs') ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : Date.now() > deadline ? reject(new Error('Git capture not ready')) : setTimeout(poll, 25);
        poll();
      })`)
      await host.writeFile(
        joinHostPath(localPath(output), `git-${appearance}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.rail-nav button')].find(button => button.textContent?.trim() === 'Files')?.click()`,
      )
      await win.webContents.executeJavaScript(
        `document.querySelector('.settings-toggle').click()`,
      )

      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const poll = () => document.querySelector('.settings-dialog') ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : Date.now() > deadline ? reject(new Error('Settings capture not ready')) : setTimeout(poll, 25);
        poll();
      })`)
      await host.writeFile(
        joinHostPath(localPath(output), `settings-${appearance}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.settings-dialog button')].find(button => button.textContent?.trim() === 'Close settings').click()`,
      )
    }
  } finally {
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('.settings-dialog button')].find(button => button.textContent?.trim() === 'Close settings')?.click();
      [...document.querySelectorAll('.rail-nav button')].find(button => button.textContent?.trim() === ${JSON.stringify(navigation)})?.click();
    `)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.viewer-tab .tab-main')].find(tab => tab.getAttribute('title') === ${JSON.stringify(selected)})?.click()`,
    )
    await win.webContents.executeJavaScript(
      `if(document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.querySelector('.theme-toggle').click()`,
    )
    win.setContentSize(size[0]!, size[1]!)
    if (settingsSection) {
      await win.webContents
        .executeJavaScript(`document.querySelector('.settings-toggle').click(); new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const poll = () => { const section = document.querySelector('.settings-section-index button[aria-controls="' + ${JSON.stringify(settingsSection)} + '"]');
          if (section) { section.click(); return resolve(); }
          if (Date.now() > deadline) return reject(new Error('Settings capture restoration failed'));
          setTimeout(poll, 25);
        }; poll();
      })`)
    }
  }
}

/** Actual populated Sessions and terminal chrome, without the illustrative visual overlay. */
export async function captureSessionPresentationVisuals(
  win: BrowserWindow,
  host: ProjectHost,
): Promise<void> {
  const output = process.env['HVIR_PRESENTATION_CAPTURE_DIRECTORY']
  if (!output) return
  if (!output.startsWith('/') || output === '/')
    throw new Error('Invalid capture directory')
  await host
    .createDirectoryExclusive(localPath(output), { mode: 0o755 })
    .catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await host.stat(localPath(output))).type !== 'dir')
        throw new Error('Capture output is not a directory')
    })
  const size = win.getContentSize()
  const theme: unknown = await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )
  try {
    win.setContentSize(1280, 800)
    for (const appearance of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        if (document.documentElement.dataset.theme !== ${JSON.stringify(appearance)}) document.querySelector('.theme-toggle').click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`)
      await host.writeFile(
        joinHostPath(localPath(output), `terminal-${appearance}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
      await win.webContents.executeJavaScript(
        `document.querySelector('.sessions-destination').click()`,
      )
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const poll = () => document.querySelector('.sessions-overview .session-card') ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : Date.now() > deadline ? reject(new Error('Sessions capture not ready')) : setTimeout(poll, 25);
        poll();
      })`)
      await host.writeFile(
        joinHostPath(localPath(output), `sessions-${appearance}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
      await win.webContents.executeJavaScript(
        `document.querySelector('.project-tab .project-tab-main').click()`,
      )
    }
  } finally {
    await win.webContents.executeJavaScript(
      `document.querySelector('.project-tab .project-tab-main').click(); if(document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.querySelector('.theme-toggle').click()`,
    )
    win.setContentSize(size[0]!, size[1]!)
  }
}

/** Capture an already prepared ordinary graph or diff; restore appearance and extent. */
export async function captureActivePresentationVisuals(
  win: BrowserWindow,
  host: Pick<ProjectHost, 'writeFile'>,
  name: 'graph' | 'diff',
): Promise<void> {
  const output = process.env['HVIR_PRESENTATION_CAPTURE_DIRECTORY']
  if (!output) return
  if (!output.startsWith('/') || output === '/')
    throw new Error('Invalid capture directory')
  const size = win.getContentSize()
  const theme: unknown = await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )
  try {
    win.setContentSize(1280, 800)
    for (const appearance of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        if (document.documentElement.dataset.theme !== ${JSON.stringify(appearance)}) document.querySelector('.theme-toggle').click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`)
      await host.writeFile(
        joinHostPath(localPath(output), `${name}-${appearance}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
    }
  } finally {
    await win.webContents.executeJavaScript(
      `if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) document.querySelector('.theme-toggle').click()`,
    )
    win.setContentSize(size[0]!, size[1]!)
  }
}
