import type { BrowserWindow } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

/** Opt-in owned-fixture consent captures; changing CSS presentation never responds to the proposal. */
export async function captureExtensionDecision(
  win: BrowserWindow,
  host: ProjectHost,
  decision: 'program' | 'read' | 'combined' | 'project-read',
  wait: (predicate: () => Promise<boolean>, label: string) => Promise<void>,
): Promise<void> {
  const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
  if (!directory) return
  if (!directory.startsWith('/') || directory === '/')
    throw new Error('Select an absolute owned extension visual directory')
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
    const dialog=document.querySelector('[aria-labelledby="${decision === 'read' ? 'source' : 'connection'}-confirmation-title"]');
    return !!dialog?.checkVisibility() && dialog.contains(document.activeElement);
  })()`)) === true,
    'trusted consent rendered with safe focus',
  )
  const output = localPath(directory)
  await host
    .createDirectoryExclusive(output, { mode: 0o755 })
    .catch(async (error: unknown) => {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await host.stat(output)).type !== 'dir'
      )
        throw error
    })
  const size = win.getContentSize()
  const original = (await win.webContents.executeJavaScript(
    `({theme:document.documentElement.dataset.theme,scale:document.documentElement.style.getPropertyValue('--hvir-interface-scale')})`,
  )) as { theme: string; scale: string }
  const facts: unknown[] = []
  try {
    for (const theme of ['dark', 'light'])
      for (const variant of ['ordinary', 'narrow-scaled']) {
        const scale = variant === 'ordinary' ? 1 : 1.3
        win.setContentSize(variant === 'ordinary' ? 1280 : 760, 800)
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(String(scale))});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
        )
        const geometry: unknown = await win.webContents.executeJavaScript(`(() => {
        const dialog=document.querySelector('[aria-labelledby="${decision === 'read' ? 'source' : 'connection'}-confirmation-title"]');
        if(!dialog?.checkVisibility()||!dialog.contains(document.activeElement))throw new Error('Consent lost visibility or safe focus');
        const rect=dialog.getBoundingClientRect(), content=dialog.querySelector('.confirmation-dialog-content'), style=getComputedStyle(dialog);
        const buttons=[...dialog.querySelectorAll('button')];
        if(rect.left<0||rect.top<0||rect.right>innerWidth+1||rect.bottom>innerHeight+1||Math.abs(parseFloat(style.fontSize)-12*${scale})>.1)throw new Error('Consent lost scale or viewport containment');
        if(content.scrollWidth>content.clientWidth+1||buttons.some(button=>{const r=button.getBoundingClientRect();return r.left<rect.left||r.right>rect.right||r.bottom>rect.bottom}))throw new Error('Consent identities or actions overflow');
        return {width:rect.width,height:rect.height,fontSize:style.fontSize,focused:document.activeElement.textContent,scrolls:content.scrollHeight>content.clientHeight};
      })()`)
        facts.push({ theme, variant, geometry })
        await host.writeFile(
          joinHostPath(output, `consent-${decision}-${theme}-${variant}.png`),
          (await win.webContents.capturePage()).toPNG(),
        )
      }
    await host.writeFile(
      joinHostPath(output, `consent-${decision}-geometry.json`),
      JSON.stringify(facts, null, 2),
    )
  } finally {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme=${JSON.stringify(original.theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(original.scale)})`,
    )
    win.setContentSize(size[0]!, size[1]!)
  }
}
