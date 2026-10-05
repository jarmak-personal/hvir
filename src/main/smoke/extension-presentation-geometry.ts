import type { BrowserWindow } from 'electron'

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
    const style=getComputedStyle(add), bounds=section.getBoundingClientRect(), box=scroll.getBoundingClientRect();
    return beside && heading.checkVisibility() && heading.getBoundingClientRect().bottom <= box.top + 1 && box.bottom <= bounds.bottom + 1 && box.height > 0 && getComputedStyle(scroll).overflowY==='auto' && style.borderTopStyle==='solid' && parseFloat(style.borderTopLeftRadius)>=3;
  })()`)) === true,
    'Extensions heading, scroll containment and flat rounded Add control',
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
