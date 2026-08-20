import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

const CAPTURES = [
  { name: 'harness-settings-normal-dark.png', width: 1280, height: 800, theme: 'dark' },
  { name: 'harness-settings-normal-light.png', width: 1280, height: 800, theme: 'light' },
  { name: 'harness-settings-compact-dark.png', width: 640, height: 720, theme: 'dark' },
  { name: 'harness-settings-compact-light.png', width: 640, height: 720, theme: 'light' },
] as const

/** Opt-in visual acceptance for the closed smoke fixture; never runs in ordinary CI. */
export async function captureHarnessSettingsVisuals(
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
    throw new Error('Harness settings capture directory must be a bounded absolute path')
  }
  const originalSize = win.getContentSize()
  const originalTheme = await currentTheme(win)
  const written: HostPath[] = []
  try {
    await openHarnessSettings(win)
    for (const capture of CAPTURES) {
      win.setContentSize(capture.width, capture.height)
      await setTheme(win, capture.theme)
      await setDisclosureState(win, capture.theme === 'light')
      const image = await win.webContents.capturePage()
      const path = joinHostPath(outputDirectory, capture.name)
      await host.writeFile(path, image.toPNG())
      written.push(path)
    }
  } finally {
    await closeHarnessSettings(win)
    await setTheme(win, originalTheme)
    win.setContentSize(originalSize[0]!, originalSize[1]!)
  }
  return written
}

async function openHarnessSettings(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      document.querySelector('.settings-toggle')?.click();
      const open = () => {
        const dialog = document.querySelector('.settings-dialog');
        const harnesses = [...(dialog?.querySelectorAll(
          '.settings-section-index button'
        ) || [])].find((button) => button.textContent?.trim() === 'Harnesses');
        if (dialog && harnesses) {
          harnesses.click();
          return requestAnimationFrame(() => {
            const editor = document.querySelector('.settings-profile-editor');
            if (editor) return resolve(true);
            requestAnimationFrame(open);
          });
        }
        requestAnimationFrame(open);
      };
      open();
    })
  `)
}

async function closeHarnessSettings(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const close = [...document.querySelectorAll('.settings-dialog button')]
        .find((button) => button.textContent?.trim() === 'Close settings');
      close?.click();
    })()
  `)
}

async function currentTheme(win: BrowserWindow): Promise<'dark' | 'light'> {
  const theme: unknown = await win.webContents.executeJavaScript(
    `document.documentElement.dataset.theme`,
  )
  return theme === 'light' ? 'light' : 'dark'
}

async function setTheme(win: BrowserWindow, theme: 'dark' | 'light'): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      if (document.documentElement.dataset.theme !== ${JSON.stringify(theme)}) {
        document.querySelector('.theme-toggle')?.click();
      }
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}

async function setDisclosureState(
  win: BrowserWindow,
  openAdvanced: boolean,
): Promise<void> {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const details = [...document.querySelectorAll('.settings-profile-disclosure')];
      details.forEach((detail, index) => { detail.open = ${openAdvanced} && index === 0; });
      document.querySelector('.settings-profile-editor')?.scrollTo(0, 0);
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })
  `)
}
