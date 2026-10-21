import type { BrowserWindow } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
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
    const section=document.querySelector('.extension-settings'), panel=section?.querySelector('.extension-configuration-layout');
    const heading=document.getElementById('settings-extensions-title');
    const sidebar=panel?.querySelector('.extension-settings-sidebar'), list=sidebar?.querySelector('.extension-installation-list');
    const add=sidebar?.querySelector('.extension-add-action'), pane=panel?.querySelector('.extension-settings-pane');
    const shared=pane?.querySelector('.extension-shared-settings'), article=pane?.querySelector('.extension-installation');
    if(!section||!heading||!panel||!sidebar||!list||!add||!pane||!shared)return false;
    const p=panel.getBoundingClientRect(), l=sidebar.getBoundingClientRect(), n=list.getBoundingClientRect(), r=pane.getBoundingClientRect(), a=add.getBoundingClientRect();
    const bounds=section.getBoundingClientRect(), scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale'));
    const contained=l.width>0&&r.width>0&&l.right<=r.left+1&&r.right<=p.right+1&&r.bottom<=p.bottom+1&&p.bottom<=bounds.bottom+1&&p.height>0;
    const pinned=a.bottom<=l.bottom+1&&Math.abs(a.bottom-l.bottom)<2&&a.top>=n.bottom-1&&a.left>=l.left&&a.right<=l.right+1;
    const scrolls=getComputedStyle(section).overflowY==='hidden'&&getComputedStyle(panel).overflowY==='hidden'&&getComputedStyle(list).overflowY==='auto'&&getComputedStyle(pane).overflowY==='auto'&&(!article||getComputedStyle(article).overflowY!=='auto');
    const hidden=shared.hidden?getComputedStyle(shared).display==='none'&&!!article:shared.checkVisibility()&&!article;
    const checkbox=shared.querySelector('.agent-access-settings input[type=checkbox]');
    let beside=true;
    if(!shared.hidden){
      const text=checkbox&&[...checkbox.parentElement.childNodes].find(e=>e.nodeType===Node.TEXT_NODE&&e.textContent.trim());
      if(!checkbox||!text)return false;
      const range=document.createRange();range.selectNodeContents(text);
      const check=checkbox.getBoundingClientRect(), label=range.getBoundingClientRect();
      beside=check.width>0&&Math.abs(check.width-14*scale)<.5&&check.right<=label.left+2&&check.top<label.bottom&&label.top<check.bottom;
    }
    return contained&&pinned&&scrolls&&hidden&&beside&&heading.checkVisibility()&&heading.getBoundingClientRect().bottom<=p.top+1&&Math.abs(parseFloat(getComputedStyle(add).fontSize)-11*scale)<.1;
  })()`)) === true,
    'single Extensions panel with independent content scroll and pinned Add action',
  ).catch(async (reason: unknown) => {
    console.log(
      '[smoke] settings geometry failure',
      JSON.stringify(
        await win.webContents.executeJavaScript(`(() => {
      const box=selector=>{const e=document.querySelector(selector);return e?{rect:e.getBoundingClientRect().toJSON(),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,display:getComputedStyle(e).display,overflow:getComputedStyle(e).overflowY}:null};
      return {scale:getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale'),section:box('.extension-settings'),panel:box('.extension-configuration-layout'),sidebar:box('.extension-settings-sidebar'),list:box('.extension-installation-list'),pane:box('.extension-settings-pane'),shared:box('.extension-shared-settings'),add:box('.extension-add-action'),checkbox:box('.extension-shared-settings input[type=checkbox]')};
    })()`),
      ),
    )
    throw reason
  })
  const count = (await win.webContents.executeJavaScript(
    "document.querySelectorAll('.extension-installation-list button[data-source]').length",
  )) as number
  const selected =
    (await win.webContents.executeJavaScript(
      "!!document.querySelector('.extension-installation-list [data-source][aria-current=true]')",
    )) === true
  if (count > 0 && selected) {
    const original = (await win.webContents.executeJavaScript(`(() => {
      const buttons=[...document.querySelectorAll('.extension-installation-list button[data-source]')];
      const index=buttons.findIndex(e=>e.getAttribute('aria-current')==='true'), selected=buttons[index], next=buttons[0];
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
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home' })
    await wait(
      async () =>
        (await win.webContents.executeJavaScript(
          "document.querySelector('[aria-label=\"Extension settings\"]').getAttribute('aria-current')==='true'",
        )) === true,
      'native Home selects shared settings without opening Add',
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

/** One compact row keeps built-ins and the full declared extension demand reachable. */
export async function verifyExtensionRailGeometry(
  win: BrowserWindow,
  wait: Wait,
  headerItems: number,
  host: ProjectHost,
): Promise<void> {
  const size = win.getContentSize()
  const original = (await win.webContents.executeJavaScript(
    `({theme:document.documentElement.dataset.theme,scale:document.documentElement.style.getPropertyValue('--hvir-interface-scale')})`,
  )) as { theme: string; scale: string }
  const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
  if (directory && (!directory.startsWith('/') || directory === '/'))
    throw new Error('Select an absolute owned extension visual directory')
  const output = directory ? localPath(directory) : undefined
  if (output)
    await host
      .createDirectoryExclusive(output, { mode: 0o755 })
      .catch(async (error: unknown) => {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await host.stat(output)).type !== 'dir'
        )
          throw error
      })
  const facts: unknown[] = []
  try {
    for (const theme of ['dark', 'light']) {
      for (const variant of ['ordinary', 'narrow-scaled']) {
        const scale = variant === 'ordinary' ? '1' : '1.3'
        win.setContentSize(variant === 'ordinary' ? 1280 : 760, 800)
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(scale)})`,
        )
        const geometry = `(() => {
          const rail=document.querySelector('.terminal-rail:not([hidden])'), header=rail?.querySelector('.terminal-rail-header'), group=header?.querySelector('.extension-terminal-items');
          if(!header||!group||group.querySelectorAll('button').length!==${headerItems})return false;
          const bounds=header.getBoundingClientRect(), part=group.getBoundingClientRect();
          const actions=[...header.querySelector('.terminal-header-actions').children].filter(e=>e!==group).map(e=>e.getBoundingClientRect());
          const buttons=[...group.querySelectorAll('button')];
          const controls=[part,...actions];
          const singleRow=controls.every(e=>Math.abs((e.top+e.bottom)/2-(part.top+part.bottom)/2)<1);
          const contained=controls.every((e,i)=>e.left>=bounds.left&&e.right<=bounds.right&&e.top>=bounds.top&&e.bottom<=bounds.bottom&&controls.slice(i+1).every(other=>e.right<=other.left+1||other.right<=e.left+1));
          const accessible=[...header.querySelectorAll('button')].every(e=>e.getAttribute('aria-label')&&e.title);
          const chrome=header.querySelectorAll('.terminal-header-actions > button, .terminal-move-control > button, .terminal-new-control > button');
          const oneRowHeight=bounds.height<=Math.max(...controls.map(e=>e.height))+10;
          if(!rail.getAttribute('aria-label')||header.querySelector('.terminal-settings-button')||header.textContent.includes('Terminals')||chrome.length!==4||part.width<52||!singleRow||!contained||!accessible||!oneRowHeight||buttons.some(e=>e.scrollWidth>e.clientWidth||e.getBoundingClientRect().width>28)||getComputedStyle(group).overflowX!=='auto')return false;
          return {width:bounds.width,height:bounds.height,contributionWidth:part.width,contributions:buttons.length,singleRow,contained,accessible,scale:getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale').trim(),theme:document.documentElement.dataset.theme};
        })()`
        await wait(
          async () => !!(await win.webContents.executeJavaScript(geometry)),
          `single-row terminal controls without overlap: ${theme} ${variant}`,
        )
        await win.webContents.executeJavaScript(
          "document.querySelector('.terminal-rail-header .extension-terminal-items button:last-child').focus()",
        )
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        win.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'Tab',
          modifiers: ['shift'],
        })
        win.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'Tab',
          modifiers: ['shift'],
        })
        await wait(
          async () =>
            (await win.webContents.executeJavaScript(`(() => {
              const button=document.querySelector('.terminal-rail-header .extension-terminal-items button:last-child'), group=button.parentElement;
              const box=button.getBoundingClientRect(), bounds=group.getBoundingClientRect();
              return document.hasFocus()&&document.activeElement===button&&button.matches(':focus-visible')&&box.left>=bounds.left-1&&box.right<=bounds.right+1;
            })()`)) === true,
          `last contribution reached with native Tab and visible focus: ${theme} ${variant}`,
        )
        facts.push({
          theme,
          variant,
          geometry: (await win.webContents.executeJavaScript(geometry)) as unknown,
          keyboardReachable: true,
        })
        if (output) {
          await win.webContents.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          )
          await host.writeFile(
            joinHostPath(output, `terminal-header-${theme}-${variant}.png`),
            (await win.webContents.capturePage()).toPNG(),
          )
        }
      }
    }
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
    if (output)
      await host.writeFile(
        joinHostPath(output, 'terminal-header-geometry.json'),
        JSON.stringify(facts, null, 2),
      )
  } finally {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme=${JSON.stringify(original.theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(original.scale)})`,
    )
    win.setContentSize(size[0]!, size[1]!)
  }
}

/** Both settings destinations retain real scroll containment at theme/scale boundaries. */
export async function verifyExtensionSettingsVariants(
  win: BrowserWindow,
  wait: Wait,
  host: ProjectHost,
): Promise<void> {
  const size = win.getContentSize()
  const original = (await win.webContents.executeJavaScript(
    `({theme:document.documentElement.dataset.theme,scale:document.documentElement.style.getPropertyValue('--hvir-interface-scale')})`,
  )) as { theme: string; scale: string }
  const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
  if (directory && (!directory.startsWith('/') || directory === '/'))
    throw new Error('Select an absolute owned extension visual directory')
  const output = directory ? localPath(directory) : undefined
  if (output)
    await host
      .createDirectoryExclusive(output, { mode: 0o755 })
      .catch(async (error: unknown) => {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          (await host.stat(output)).type !== 'dir'
        )
          throw error
      })
  const reference = extensionSettingsControls(
    win,
    'hvir Reference',
    { wait, within: (work) => work },
    'reference',
  )
  const facts: unknown[] = []
  try {
    for (const theme of ['dark', 'light']) {
      for (const variant of ['ordinary', 'narrow-scaled', 'short-scaled']) {
        win.setContentSize(
          variant === 'ordinary' ? 1280 : 760,
          variant === 'short-scaled' ? 600 : 800,
        )
        await win.webContents.executeJavaScript(
          `document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(variant === 'ordinary' ? '1' : '1.5')})`,
        )
        for (const destination of ['shared', 'installed']) {
          await win.webContents.executeJavaScript(
            "document.querySelector('.extension-settings-pane').scrollTop=99999",
          )
          if (destination === 'shared') {
            await win.webContents.executeJavaScript(
              `document.querySelector('[aria-label="Extension settings"]').click()`,
            )
          } else await reference.select()
          await verifyExtensionSettingsGeometry(win, wait)
          await wait(
            async () =>
              (await win.webContents.executeJavaScript(
                "document.querySelector('.extension-settings-pane').scrollTop===0",
              )) === true,
            'changed settings destination starts at top',
          )
          const geometry = (await win.webContents.executeJavaScript(`(() => {
            const panel=document.querySelector('.extension-configuration-layout'), pane=panel.querySelector('.extension-settings-pane'), list=panel.querySelector('.extension-installation-list'), add=panel.querySelector('.extension-add-action'), shared=panel.querySelector('.extension-shared-settings');
            const before=add.getBoundingClientRect().toJSON();pane.scrollTop=pane.scrollHeight;list.scrollTop=list.scrollHeight;
            const after=add.getBoundingClientRect().toJSON();
            if(before.top!==after.top||before.bottom!==after.bottom||panel.scrollHeight>panel.clientHeight+1||pane.scrollWidth>pane.clientWidth+1)throw new Error('Settings scrolling moved Add or overflowed the panel');
            pane.scrollTop=0;list.scrollTop=0;
            return {panelHeight:panel.clientHeight,paneHeight:pane.clientHeight,contentHeight:pane.scrollHeight,sidebarHeight:list.clientHeight,sidebarContentHeight:list.scrollHeight,pinnedAdd:true,outerScroll:false,sharedHidden:shared.hidden,sharedDisplay:getComputedStyle(shared).display,scale:getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale').trim()};
          })()`)) as unknown
          // Native Tab must reach the persistent Add action, skipping hidden shared fields.
          await win.webContents.executeJavaScript(
            `document.querySelector('.extension-installation-list button:last-child').focus()`,
          )
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
          await wait(
            async () =>
              (await win.webContents.executeJavaScript(
                `document.activeElement===document.querySelector('.extension-add-action')&&document.activeElement.matches(':focus-visible')`,
              )) === true,
            'pinned Add reachable by native Tab without hidden settings',
          )
          facts.push({ theme, variant, destination, geometry, keyboardReachable: true })
          if (output) {
            await win.webContents.executeJavaScript(
              'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
            )
            await host.writeFile(
              joinHostPath(
                output,
                `settings-panel-${theme}-${variant}-${destination}.png`,
              ),
              (await win.webContents.capturePage()).toPNG(),
            )
          }
        }
      }
    }
    if (output)
      await host.writeFile(
        joinHostPath(output, 'settings-panel-geometry.json'),
        JSON.stringify(facts, null, 2),
      )
  } finally {
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.theme=${JSON.stringify(original.theme)};document.documentElement.style.setProperty('--hvir-interface-scale',${JSON.stringify(original.scale)})`,
    )
    win.setContentSize(size[0]!, size[1]!)
    await reference.select()
  }
}
