import type { BrowserWindow } from 'electron'
import { extensionSettingsControls } from './extension-settings-controls'

type Wait = (predicate: () => boolean | Promise<boolean>, label: string) => Promise<void>

/** Real Chromium layout assertions; capture opt-ins do not control these checks. */
export async function verifyExtensionSettingsGeometry(
  win: BrowserWindow,
  wait: Wait,
): Promise<void> {
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
    const section=document.querySelector('.extension-settings'), scroll=section?.querySelector('.settings-section-scroll');
    const heading=document.getElementById('settings-extensions-title');
    const add=[...(section?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()==='Add extension…');
    if(!scroll||!heading||!add)return false;
    const checkbox=section.querySelector('.agent-access-settings input[type=checkbox]');
    const text=checkbox && [...checkbox.parentElement.childNodes].find(e=>e.nodeType===Node.TEXT_NODE&&e.textContent.trim());
    if(!checkbox||!text)return false;
    const range=document.createRange();range.selectNodeContents(text);
    const check=checkbox.getBoundingClientRect(), label=range.getBoundingClientRect();
    const beside=check.width>0&&check.width<=20&&check.right<=label.left+2&&check.top<label.bottom&&label.top<check.bottom;
    const layout=section.querySelector('.extension-configuration-layout'), list=layout?.querySelector('.extension-installation-list'), detail=layout?.querySelector('.extension-installation');
    let selected=true;
    if(layout){
      if(!list||!detail||layout.querySelectorAll('.extension-installation').length!==1)return false;
      const left=list.getBoundingClientRect(), right=detail.getBoundingClientRect(), panel=layout.getBoundingClientRect();
      selected=left.width>0&&right.width>0&&left.right<=right.left+1&&left.left>=panel.left&&right.right<=panel.right+1&&left.height<=panel.height&&right.height<=panel.height&&getComputedStyle(list).overflowY==='auto'&&getComputedStyle(detail).overflowY==='auto';
    }
    const style=getComputedStyle(add), bounds=section.getBoundingClientRect(), box=scroll.getBoundingClientRect();
    const scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale'));
    return Math.abs(parseFloat(style.fontSize)-11*scale)<.1 && selected && beside && heading.checkVisibility() && heading.getBoundingClientRect().bottom <= box.top + 1 && box.bottom <= bounds.bottom + 1 && box.height > 0 && getComputedStyle(scroll).overflowY==='auto' && style.borderTopStyle==='solid' && parseFloat(style.borderTopLeftRadius)>=3;
  })()`)) === true,
    'Extensions heading, scroll containment and flat rounded Add control',
  )
  const count = (await win.webContents.executeJavaScript(
    "document.querySelectorAll('.extension-installation-list button').length",
  )) as number
  if (count > 1) {
    const original = (await win.webContents.executeJavaScript(`(() => {
      const buttons=[...document.querySelectorAll('.extension-installation-list button')];
      const index=buttons.findIndex(e=>e.getAttribute('aria-current')==='true'), selected=buttons[index], next=buttons[(index+1)%buttons.length];
      if(!selected||!next)throw new Error('Selected configuration disappeared');
      selected.focus();return {source:selected.dataset.source,name:selected.querySelector('strong')?.textContent,nextSource:next.dataset.source,nextName:next.querySelector('strong')?.textContent};
    })()`)) as
      | { source: unknown; name: unknown; nextSource: unknown; nextName: unknown }
      | undefined
    if (
      !original ||
      typeof original.source !== 'string' ||
      !original.source ||
      typeof original.name !== 'string' ||
      !original.name ||
      typeof original.nextSource !== 'string' ||
      !original.nextSource ||
      typeof original.nextName !== 'string' ||
      !original.nextName
    )
      throw new Error('Selected configuration identity is unavailable')
    if (!win.isFocused() || !win.isVisible() || win.isMinimized())
      throw new Error(
        'Configuration keyboard check requires the actual foreground window',
      )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
    const ports = { wait, within: <T>(work: Promise<T>): Promise<T> => work }
    const next = extensionSettingsControls(
      win,
      original.nextName,
      ports,
      original.nextSource,
    )
    await wait(
      () => next.selected(true),
      'native extension-list keyboard selection and focused configuration',
    )
    await extensionSettingsControls(win, original.name, ports, original.source).select()
  }
}

/** Enter must retain visible keyboard focus when first Enable admits a new installation. */
export async function verifyExtensionEnableFocus(
  win: BrowserWindow,
  wait: Wait,
): Promise<void> {
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
      const button=[...document.querySelectorAll('.extension-lifecycle button')].find(e=>e.textContent.trim()==='Enable');
      if(!button?.checkVisibility()||button.disabled)return false;
      button.focus();return document.hasFocus()&&document.activeElement===button;
    })()`)) === true,
    'visible keyboard Enable control',
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
      const details=document.querySelector('.extension-lifecycle'), summary=details?.querySelector('summary');
      const disable=[...(details?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()==='Disable');
      const dialog=document.querySelector('.settings-dialog'), bounds=summary?.getBoundingClientRect();
      return !!summary?.checkVisibility()&&details.open&&!!disable&&!disable.disabled&&document.hasFocus()&&document.activeElement===summary&&summary.matches(':focus-visible')&&dialog.contains(summary)&&bounds.top>=0&&bounds.bottom<=innerHeight;
    })()`)) === true,
    'first Enable retains visible summary focus inside Settings',
  ).catch(async (reason: unknown) => {
    console.log(
      '[smoke] Enable focus facts',
      JSON.stringify(
        await win.webContents.executeJavaScript(`(() => {
        const details=document.querySelector('.extension-lifecycle'), summary=details?.querySelector('summary');
        const disable=[...(details?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()==='Disable');
        return {open:details?.open,visible:summary?.checkVisibility(),enabled:!!disable,busy:disable?.disabled,documentFocus:document.hasFocus(),summaryFocus:document.activeElement===summary,focusTag:document.activeElement?.tagName,focusVisible:summary?.matches(':focus-visible'),bounds:summary?.getBoundingClientRect().toJSON(),viewport:innerHeight};
      })()`),
      ),
    )
    throw reason
  })
}

/** Real discovery may clear attention and replace configuration without losing the focused control. */
export async function verifyExtensionAttentionFocus(
  win: BrowserWindow,
  wait: Wait,
  clearAttention: () => Promise<void>,
): Promise<void> {
  await win.webContents.executeJavaScript(
    "document.querySelector('.extension-lifecycle > summary').focus()",
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
      const details=document.querySelector('.extension-lifecycle'), button=document.activeElement;
      return !!document.querySelector('.extension-installation [role=alert]')&&details.open&&details.contains(button)&&button.textContent.trim()==='Remove'&&button.checkVisibility()&&button.matches(':focus-visible');
    })()`)) === true,
    'attention lifecycle Remove reached through native Tab',
  )
  await clearAttention()
  await wait(
    async () =>
      (await win.webContents.executeJavaScript(`(() => {
      const article=document.querySelector('.extension-installation'), details=article?.querySelector('.extension-lifecycle'), button=document.activeElement;
      return !!article&&!article.querySelector('[role=alert]')&&details.open&&details.contains(button)&&button.textContent.trim()==='Remove'&&button.checkVisibility()&&button.matches(':focus-visible')&&document.hasFocus();
    })()`)) === true,
    'attention clearing retains visible keyboard focus inside Settings',
  )
}

/** Full declared static demand remains present while overflow gives controls real room. */
export async function verifyExtensionRailGeometry(
  win: BrowserWindow,
  wait: Wait,
  headerItems: number,
): Promise<void> {
  const original = win.getContentSize()
  try {
    win.setContentSize(760, original[1]!)
    await wait(
      async () =>
        (await win.webContents.executeJavaScript(`(() => {
      const header=document.querySelector('.terminal-rail-header'), group=header?.querySelector('.extension-terminal-items');
      if(!header||!group||group.querySelectorAll('button').length!==${headerItems})return false;
      const bounds=header.getBoundingClientRect(), part=group.getBoundingClientRect();
      const title=header.firstElementChild.getBoundingClientRect();
      const actions=[...header.querySelector('.terminal-header-actions').children].filter(e=>e!==group).map(e=>e.getBoundingClientRect());
      const buttons=[...group.querySelectorAll('button')];
      const separate=(a,b)=>a.right<=b.left+1||b.right<=a.left+1||a.bottom<=b.top+1||b.bottom<=a.top+1;
      const controls=[title,part,...actions];
      return part.width>=52 && controls.every((e,i)=>e.left>=bounds.left&&e.right<=bounds.right&&e.top>=bounds.top&&e.bottom<=bounds.bottom&&controls.slice(i+1).every(other=>separate(e,other))) && buttons.every(e=>e.getAttribute('aria-label')&&e.scrollWidth<=e.clientWidth&&e.getBoundingClientRect().width<=28) && getComputedStyle(group).overflowX==='auto';
    })()`)) === true,
      'bounded multi-item rail controls without label or built-in overlap',
    )
    await win.webContents.executeJavaScript(
      "document.querySelector('.terminal-rail-header .extension-terminal-items button:last-child').focus()",
    )
    await wait(
      async () =>
        (await win.webContents.executeJavaScript(`(() => {
      const button=document.querySelector('.terminal-rail-header .extension-terminal-items button:last-child'), group=button.parentElement;
      const box=button.getBoundingClientRect(), bounds=group.getBoundingClientRect();
      return document.activeElement===button && box.left>=bounds.left-1 && box.right<=bounds.right+1;
    })()`)) === true,
      'last contributed control remains focusable and scrolls into view',
    )
    await wait(
      async () =>
        (await win.webContents.executeJavaScript(`(() => {
      const rows=[...document.querySelectorAll('.terminal-list-row')];
      return rows.length===2 && rows.every(row=>{
        const bounds=row.getBoundingClientRect(), title=row.querySelector('.terminal-list-title');
        return title&&getComputedStyle(title).textOverflow==='ellipsis' && [...row.querySelectorAll('button')].filter(e=>!e.classList.contains('terminal-list-main')).every(e=>{const box=e.getBoundingClientRect();return box.left>=bounds.left-1&&box.right<=bounds.right+1});
      });
    })()`)) === true,
      'session titles truncate while contributed and built-in controls remain contained',
    )
  } finally {
    win.setContentSize(original[0]!, original[1]!)
  }
}
