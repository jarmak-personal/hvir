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

/** Capture an already prepared feature state; restore appearance and extent. */
export async function captureActivePresentationVisuals(
  win: BrowserWindow,
  host: Pick<ProjectHost, 'writeFile'>,
  name:
    | 'graph'
    | 'diff'
    | 'review-rendered'
    | 'review-source'
    | 'review-moved'
    | 'state-feedback',
): Promise<void> {
  const output = process.env['HVIR_PRESENTATION_CAPTURE_DIRECTORY']
  if (!output) return
  if (!output.startsWith('/') || output === '/')
    throw new Error('Invalid capture directory')
  const size = win.getContentSize()
  const theme: unknown = await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )
  const reviewState: unknown = name.startsWith('review-')
    ? await win.webContents.executeJavaScript(`(() => {
        const comment = document.querySelector('.document-review-inline .document-review-comment');
        return { body: comment?.querySelector('.document-review-comment-body')?.textContent,
          moved: comment?.classList.contains('review-anchor-moved') };
      })()`)
    : undefined
  try {
    win.setContentSize(1280, 800)
    for (const appearance of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        if (document.documentElement.dataset.theme !== ${JSON.stringify(appearance)}) document.querySelector('.theme-toggle').click();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`)
      if (name.startsWith('review-'))
        await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const expected = ${JSON.stringify(reviewState)};
          const poll = () => {
            const comment = document.querySelector('.document-review-inline .document-review-comment');
            if (comment instanceof HTMLElement && comment.getBoundingClientRect().height > 0 &&
                comment.querySelector('.document-review-comment-body')?.textContent === expected.body &&
                comment.classList.contains('review-anchor-moved') === expected.moved)
              return requestAnimationFrame(() => requestAnimationFrame(resolve));
            if (Date.now() > deadline) return reject(new Error('Themed review capture card not ready'));
            setTimeout(poll, 25);
          }; poll();
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

/** Closed style fixture for signals not all reachable in one native workflow.
 * Actual review workflow captures above remain distinct from this cascade evidence.
 */
export async function captureStatePresentationVisuals(
  win: BrowserWindow,
  host: ProjectHost,
): Promise<void> {
  if (!process.env['HVIR_PRESENTATION_CAPTURE_DIRECTORY']) return
  await win.webContents.executeJavaScript(`(() => {
    const fixture = document.createElement('section');
    fixture.id = 'hvir-presentation-state-capture';
    fixture.style.cssText = 'position:fixed;inset:80px 80px;z-index:10000;overflow:auto;padding:24px;background:var(--viewer-bg);color:var(--text);font-family:var(--hvir-interface-font);font-size:13px';
    fixture.innerHTML = '<h2>Closed Chromium state fixture</h2>' +
      '<p>Review markers: current / moved / stale</p><div style="display:flex;gap:28px;padding:20px 60px">' +
      ['', 'review-anchor-moved', 'review-anchor-stale'].map(state => '<div class="review-block" style="width:110px"><button class="review-block-badge ' + state + '">1</button><span class="cm-review-marker ' + state + '">1</span><span class="cm-review-anchor ' + state + '">reviewed text</span></div>').join('') + '</div>' +
      '<section class="workbench-health-dialog"><div class="workbench-health-heading"><h2>Workbench health</h2><span class="workbench-health-evidence">Available</span></div><ul class="workbench-health-list"><li class="workbench-health-item"><strong>Ordinary incident</strong><code>closed-fixture</code></li><li class="workbench-health-item critical"><strong>Critical incident</strong><code>closed-fixture</code></li><li class="workbench-health-item resolved"><strong>Resolved incident</strong><code>closed-fixture</code></li></ul></section>' +
      '<section class="terminal-move-dialog" style="position:static;margin-top:24px"><h2>Move terminal</h2><p><i class="terminal-move-live-dot"></i> Live terminal</p><div class="terminal-move-continuity"><span class="terminal-move-continuity-mark">✓</span><p><strong>Same terminal process</strong><span>Original launch directory remains unchanged</span></p></div><div class="terminal-move-warning"><span class="terminal-move-warning-mark">!</span><p><strong>Workspace changes</strong><span>Closed fixture warning</span></p></div></section>';
    document.body.append(fixture);
  })()`)
  try {
    await captureActivePresentationVisuals(win, host, 'state-feedback')
  } finally {
    await win.webContents.executeJavaScript(
      `document.getElementById('hvir-presentation-state-capture')?.remove()`,
    )
  }
}
