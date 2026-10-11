import { webContents, type BrowserWindow } from 'electron'
import type { ExtensionView } from '../../shared/extensions/workbench'
import { trustedRendererControl } from './trusted-renderer-control'

/** Unrelated editable application preferences must survive the deliberate Add handoff. */
export async function prepareInstallationDraft(
  win: BrowserWindow,
  click: (name: string) => Promise<void>,
): Promise<void> {
  await click('Appearance')
  await win.webContents.executeJavaScript(`(() => {
    const input=document.getElementById('settings-interface-scale');
    if(!input?.checkVisibility()) throw new Error('Appearance draft unavailable');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1.25');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await click('Keybindings')
  await win.webContents.executeJavaScript(`(() => {
    const input=document.getElementById('settings-keybindings-json');
    if(!input?.checkVisibility()) throw new Error('Keybindings draft unavailable');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'{ unfinished draft');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await click('Extensions')
}

/** Observe ordinary visible placement and native input after Add, without selecting it. */
export async function verifyInstalledLanding(
  win: BrowserWindow,
  installationId: string,
  surface: 'top' | 'viewer',
  wait: (predicate: () => boolean | Promise<boolean>, label: string) => Promise<void>,
): Promise<void> {
  let view: ExtensionView | undefined
  await wait(async () => {
    const views = (await win.webContents.executeJavaScript(
      'window.hvir.invoke("extensions:views", undefined)',
    )) as ExtensionView[]
    view = views.find(
      (entry) =>
        entry.installationId === installationId && entry.context?.surface === surface,
    )
    return (
      !!view &&
      trustedRendererControl(
        win,
        `function(viewId) {
        const pane=[...document.querySelectorAll('[data-extension-view]')].find(entry=>entry.dataset.extensionView===viewId);
        return !document.querySelector('.settings-dialog') && !!pane?.checkVisibility();
      }`,
        [view.id],
        (work) => work,
      )
    )
  }, `Add reveals its declared ${surface} landing without another Open or navigation click`)
  let guest: Electron.WebContents | undefined
  await wait(async () => {
    guest = webContents
      .getAllWebContents()
      .find((entry) => !entry.isDestroyed() && entry.getURL() === view!.url)
    return (
      !!guest?.isFocused() &&
      (await guest.executeJavaScript(
        "document.hasFocus() && [...document.querySelectorAll('button')].some(button=>!button.disabled && button.checkVisibility())",
      )) === true
    )
  }, 'automatic landing owns actual native guest keyboard focus')
  guest!.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  guest!.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait(
    () =>
      guest!.executeJavaScript(
        "document.hasFocus() && document.activeElement?.tagName === 'BUTTON'",
      ),
    'native Tab reaches an ordinary landing control without focus helpers',
  )
}
