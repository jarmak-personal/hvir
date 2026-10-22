import { verifyExtensionSettingsGeometry } from './extension-presentation-geometry'
import { extensionSettingsControls } from './extension-settings-controls'
import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

interface VisualControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  select(): Promise<void>
  painted?(): Promise<unknown>
  readonly expectedInstructionImages?: number
  readonly narrowScale?: string
}

/** Actual search controls must share the available guest width without covering each other. */
export async function verifySkillagerSearchGeometry(
  guest: WebContents,
): Promise<unknown> {
  return guest.executeJavaScript(`(() => {
    const form=document.getElementById('search-form'), input=document.getElementById('query'), button=form?.querySelector('button[type=submit]');
    if(!form||!input||!button)throw new Error('Skillager search controls are missing');
    const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const bounds=box(form), query=box(input), submit=box(button);
    const contained=r=>r.width>0&&r.height>0&&r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1&&r.left>=0&&r.right<=innerWidth;
    const separate=query.right<=submit.left||submit.right<=query.left||query.bottom<=submit.top||submit.bottom<=query.top;
    const styled=[input,button].every(e=>{const s=getComputedStyle(e);return s.borderTopStyle==='solid'&&parseFloat(s.borderTopLeftRadius)>=3});
    if(!input.checkVisibility()||!button.checkVisibility()||!contained(query)||!contained(submit)||!separate||!styled)throw new Error('Actual Skillager search controls overlap, escape the form or lose shared styling');
    return {form:bounds,input:query,button:submit,separate,contained:true,styled,viewport:innerWidth,scale:document.documentElement.style.getPropertyValue('--hvir-interface-scale')};
  })()`)
}

/** Opt-in actual compositor captures contain only the owned public-CLI visual fixture. */
export async function captureExtensionVisuals(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  state:
    | 'unapproved'
    | 'library'
    | 'instructions'
    | 'project'
    | 'acceptance'
    | 'add'
    | 'update'
    | 'remove'
    | 'management'
    | 'import'
    | 'import-files'
    | 'router'
    | 'router-members'
    | 'preserved-original'
    | 'library-selected'
    | 'library-sources'
    | 'library-source-expanded'
    | 'source-search'
    | 'project-save',
  controls: VisualControls,
  captureDirectory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY,
): Promise<void> {
  const directory = captureDirectory
  if (!directory) return
  if (!directory.startsWith('/') || directory === '/')
    throw new Error('Select an absolute owned extension visual directory')
  const output = localPath(directory)
  await host
    .createDirectoryExclusive(output, { mode: 0o755 })
    .catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if ((await host.stat(output)).type !== 'dir') throw error
    })
  const originalSize = win.getContentSize()
  const originalTheme = (await win.webContents.executeJavaScript(
    'document.documentElement.dataset.theme',
  )) as string
  const originalScale = (await win.webContents.executeJavaScript(
    "getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale').trim()",
  )) as string
  const facts: unknown[] = []
  let cleanupFailure: Error | undefined
  try {
    for (const theme of ['dark', 'light'] as const) {
      for (const variant of ['ordinary', 'narrow-scaled'] as const) {
        console.log('[smoke] extension visual capture', state, theme, variant)
        const scale = variant === 'ordinary' ? '1' : (controls.narrowScale ?? '1.3')
        win.setContentSize(variant === 'ordinary' ? 1280 : 760, 800)
        await controls.click('Open settings')
        await section('Appearance', 'appearance')
        await win.webContents.executeJavaScript(`(() => {
          for (const [id, value] of [['settings-app-theme', ${JSON.stringify(theme)}], ['settings-interface-scale', ${JSON.stringify(scale)}]]) {
            const control = document.getElementById(id);
            const proto = control.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(control, value);
            control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}));
          }
        })()`)
        await controls.click('Save app settings')
        await settingsClosed()
        await controls.select()
        await controls.wait(
          async () =>
            (await guest.executeJavaScript(
              `document.documentElement.style.colorScheme === ${JSON.stringify(theme)} && document.documentElement.style.getPropertyValue('--hvir-interface-scale') === ${JSON.stringify(scale)}`,
            )) === true,
          'actual guest presentation after appearance save',
        )
        if (['library', 'library-sources', 'library-source-expanded'].includes(state))
          await controls.wait(
            async () =>
              (await guest.executeJavaScript(
                "document.querySelectorAll('#skills [data-source-toggle]').length>0 && document.getElementById('state').dataset.state==='ready'",
              )) === true,
            'current public library result after appearance save',
          )
        await settled()
        const visibleIdentity: unknown = await win.webContents.executeJavaScript(`(() => {
          const frame=[...document.querySelectorAll('webview')].find(item=>item.getWebContentsId()===${guest.id});
          const r=frame?.getBoundingClientRect();
          if(!frame?.checkVisibility()||!r||r.width<=0||r.height<=0||r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1)throw new Error('Captured guest is hidden or outside the workbench viewport');
          return {guestId:${guest.id},viewId:frame.closest('[data-extension-view]')?.dataset.extensionView,width:r.width,height:r.height};
        })()`)
        facts.push({ theme, variant, state, visibleIdentity })
        if (
          [
            'unapproved',
            'library',
            'project',
            'library-sources',
            'library-source-expanded',
            'source-search',
          ].includes(state)
        )
          facts.push({
            theme,
            variant,
            state,
            search: await verifySkillagerSearchGeometry(guest),
          })
        if (controls.painted) {
          try {
            facts.push({ theme, variant, state, navigation: await controls.painted() })
          } catch (error) {
            await write(`${state}-${theme}-${variant}-failed`)
            throw error
          }
        }
        facts.push({
          theme,
          variant,
          state,
          guest: (await guest.executeJavaScript(`(() => {
          const main = document.querySelector('main'), body = getComputedStyle(document.body);
          const button = document.querySelector('.toolbar .hvir-button'), style = getComputedStyle(button);
          const input = document.getElementById('query');
          const scroll = document.getElementById('skills') ?? document.getElementById('instructions');
          return {stateKind:document.getElementById('state')?.dataset.state ?? null,
            observedRows:document.querySelectorAll('#skills [data-skill-select]').length,
            actionableApproval:document.getElementById('state')?.textContent.includes('Settings') ?? false,
            sourceIdentitySecondary:!!document.getElementById('source-label')?.closest('details'),
            width:innerWidth, height:innerHeight, theme:document.documentElement.style.colorScheme,
            font:body.fontFamily, fontSize:body.fontSize, buttonFontSize:style.fontSize,
            buttonBorder:style.borderTopStyle, buttonBorderWidth:style.borderTopWidth, buttonRadius:style.borderTopLeftRadius,
            pageFits:document.documentElement.scrollWidth <= innerWidth,
            mainFits:main.getBoundingClientRect().bottom <= innerHeight + 1,
            inputFits:!input || input.getBoundingClientRect().right <= innerWidth,
            scrollOverflow:scroll ? getComputedStyle(scroll).overflowY : null,
            scrollHeight:scroll?.clientHeight ?? 0, scrollContained:!scroll || scroll.getBoundingClientRect().bottom <= innerHeight + 1};
        })()`)) as unknown,
        })
        await write(`${state}-${theme}-${variant}`)
        if (state === 'management') {
          await guest.executeJavaScript(
            "document.querySelector('[aria-label=\"Local project copies\"]').scrollIntoView({block:'start'})",
          )
          await settled()
          await write(`management-${theme}-${variant}-copy-form`)
          await guest.executeJavaScript("document.querySelector('main').scrollTop=0")
        }
        if (state === 'instructions') {
          await instructionImages('after Settings and appearance changes')
          const position: unknown = await guest.executeJavaScript(
            "document.getElementById('instructions').scrollTop",
          )
          await guest.executeJavaScript(
            "document.getElementById('instructions').scrollTop=0",
          )
          await settled()
          await write(`instructions-${theme}-${variant}-top`)
          const reader: unknown = await guest.executeJavaScript(`(() => {
            const content=document.getElementById('reader-content'), instructions=document.getElementById('instructions'), heading=document.querySelector('.skill-heading');
            const body=instructions.getBoundingClientRect(), available=content.getBoundingClientRect(), title=heading.getBoundingClientRect();
            const blocks=[...instructions.querySelectorAll('pre,table,img')].filter(block=>block.checkVisibility());
            if(Math.abs(body.left-title.left)>1||Math.abs(body.width-available.width)>2||body.right>innerWidth+1||document.documentElement.scrollWidth>innerWidth+1)throw new Error('Instructions are inset from their heading or escape the available pane');
            if(blocks.some(block=>{const r=block.getBoundingClientRect();return r.left<body.left-1||r.right>body.right+1}))throw new Error('A wide instruction block escapes its reader');
            return {left:body.left,width:body.width,availableWidth:available.width,blocks:blocks.map(block=>({kind:block.tagName,width:block.getBoundingClientRect().width,scrollWidth:block.scrollWidth})),aligned:true,contained:true};
          })()`)
          facts.push({ theme, variant, state, reader })
          if (
            await guest.executeJavaScript(
              "[...document.querySelectorAll('#instructions pre')].some(block=>block.checkVisibility())",
            )
          ) {
            await guest.executeJavaScript(`(() => {
              const instructions=document.getElementById('instructions'), block=[...instructions.querySelectorAll('pre')].find(item=>item.checkVisibility());
              instructions.scrollTop+=block.getBoundingClientRect().top-instructions.getBoundingClientRect().top;
            })()`)
            await settled()
            const code: unknown = await guest.executeJavaScript(`(() => {
              const instructions=document.getElementById('instructions'), block=[...instructions.querySelectorAll('pre')].find(item=>item.checkVisibility());
              const bounds=instructions.getBoundingClientRect(), rect=block.getBoundingClientRect();
              if(rect.top<bounds.top-1||rect.bottom>bounds.bottom+1||rect.left<bounds.left-1||rect.right>bounds.right+1)throw new Error('Code capture does not show the visible contained block');
              block.scrollLeft=block.scrollWidth-block.clientWidth;
              const overflow=block.scrollWidth>block.clientWidth+1, reachedEnd=Math.abs(block.scrollLeft-(block.scrollWidth-block.clientWidth))<=1;
              if(!reachedEnd||document.documentElement.scrollWidth>innerWidth+1)throw new Error('Code horizontal scrolling escapes the reader or cannot reach the end');
              const result={visible:true,contained:true,overflow,scrollLeft:block.scrollLeft,reachedEnd};block.scrollLeft=0;return result;
            })()`)
            facts.push({ theme, variant, state, code })
            await write(`instructions-${theme}-${variant}-blocks`)
          }
          if (
            await guest.executeJavaScript("!!document.querySelector('#instructions img')")
          ) {
            await guest.executeJavaScript(
              "document.querySelector('#instructions img').scrollIntoView({block:'center'})",
            )
            await settled()
            if (controls.expectedInstructionImages !== undefined) {
              const image: unknown = await guest.executeJavaScript(`(() => {
                const reader=document.getElementById('instructions'), image=reader.querySelector('img'), bounds=reader.getBoundingClientRect(), rect=image.getBoundingClientRect();
                if(!image.complete||!image.naturalWidth||rect.top<bounds.top-1||rect.bottom>bounds.bottom+1||rect.left<bounds.left-1||rect.right>bounds.right+1)throw new Error('Known image is not decoded and visible inside its reader');
                return {decoded:true,contained:true,width:rect.width,height:rect.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight};
              })()`)
              facts.push({ theme, variant, state, image })
            }
            await write(`instructions-${theme}-${variant}-image`)
          }
          await guest.executeJavaScript("document.getElementById('source-mode').click()")
          await controls.wait(
            async () =>
              (await guest.executeJavaScript(
                "document.getElementById('instructions').dataset.mode==='source' && document.getElementById('instructions').textContent.length>0",
              )) === true,
            'actual source instructions',
          )
          await guest.executeJavaScript(
            "document.getElementById('instructions').scrollTop=0",
          )
          await settled()
          const source: unknown = await guest.executeJavaScript(`(() => {
            const instructions=document.getElementById('instructions'), rect=instructions.getBoundingClientRect();
            if(rect.left<0||rect.right>innerWidth+1||instructions.scrollWidth>instructions.clientWidth+1||document.documentElement.scrollWidth>innerWidth+1)throw new Error('Source instructions overflow the reader');
            return {contained:true,wrapped:true,width:rect.width,scrollWidth:instructions.scrollWidth};
          })()`)
          facts.push({ theme, variant, state, source })
          await write(`instructions-${theme}-${variant}-source`)
          await guest.executeJavaScript(
            "document.getElementById('rendered-mode').click()",
          )
          await controls.wait(
            async () =>
              (await guest.executeJavaScript(
                "document.getElementById('instructions').dataset.mode==='rendered' && !!document.getElementById('instructions').firstElementChild",
              )) === true,
            'rendered instructions restored',
          )
          await instructionImages('after Source and Rendered changes')
          await guest.executeJavaScript(
            "document.getElementById('instructions').scrollTop=0",
          )
          for (const [name, selector] of [
            ['more', '.instruction-modes > .skill-more'],
            ['skill-actions', '#task-options'],
          ]) {
            const point = (await guest.executeJavaScript(`(() => {
              const details=document.querySelector(${JSON.stringify(selector)}), summary=details.querySelector('summary');
              details.open=false;summary.scrollIntoView({block:'nearest'});
              const rect=summary.getBoundingClientRect();
              if(!summary.checkVisibility()||rect.top<0||rect.bottom>innerHeight)throw new Error('Command disclosure is not reachable');
              return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};
            })()`)) as { x: number; y: number }
            guest.focus()
            guest.sendInputEvent({
              type: 'mouseDown',
              button: 'left',
              clickCount: 1,
              ...point,
            })
            guest.sendInputEvent({
              type: 'mouseUp',
              button: 'left',
              clickCount: 1,
              ...point,
            })
            await controls.wait(
              async () =>
                (await guest.executeJavaScript(
                  `document.querySelector(${JSON.stringify(selector)}).open`,
                )) === true,
              'native command disclosure opens',
            )
            const menu: unknown = await guest.executeJavaScript(`(() => {
              const menu=document.querySelector(${JSON.stringify(selector)}).querySelector('.skill-menu');
              menu.scrollIntoView({block:'nearest'});
              const bounds=menu.getBoundingClientRect(), task=document.getElementById('selected-task').getBoundingClientRect();
              const fits=rect=>rect.left>=0&&rect.right<=innerWidth+1&&rect.top>=0&&rect.bottom<=innerHeight+1;
              const items=[...menu.querySelectorAll('button')].filter(button=>button.checkVisibility());
              if(!fits(bounds)||menu.scrollWidth>menu.clientWidth+1||items.some(button=>!fits(button.getBoundingClientRect()))||(${JSON.stringify(name)}==='skill-actions'&&(bounds.top<task.top||bounds.bottom>task.bottom+1)))throw new Error('Command menu or its buttons escape the visible reader');
              return {width:bounds.width,height:bounds.height,contained:true};
            })()`)
            facts.push({ theme, variant, state, command: name, menu })
            await settled()
            await write(`instructions-${theme}-${variant}-${name}`)
            guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
            guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
            await controls.wait(
              async () =>
                (await guest.executeJavaScript(`(() => {
                const details=document.querySelector(${JSON.stringify(selector)}), summary=details.querySelector('summary');
                return !details.open&&document.hasFocus()&&document.activeElement===summary&&summary.matches(':focus-visible')&&getComputedStyle(summary).outlineStyle!=='none';
              })()`)) === true,
              'Escape closes commands and returns visible summary focus',
            )
          }
          await guest.executeJavaScript(
            `document.getElementById('selected-task').scrollTop=0;document.getElementById('instructions').scrollTop=${Number(position)}`,
          )
        }
        if (state === 'library') {
          await guest.executeJavaScript(
            "document.querySelector('.library-options > summary').click()",
          )
          await settled()
          await write(`library-${theme}-${variant}-library-options`)
          const menu: unknown = await guest.executeJavaScript(`(() => {
            const options=document.querySelector('.library-options'), menu=options.querySelector('.skill-menu'), sidebar=document.querySelector('.library-browser').getBoundingClientRect();
            const bounds=menu.getBoundingClientRect();
            const contained=rect=>rect.left>=sidebar.left&&rect.right<=sidebar.right+1&&rect.left>=0&&rect.right<=innerWidth+1;
            if(!menu.checkVisibility()||!contained(bounds)||menu.scrollWidth>menu.clientWidth+1||[...menu.querySelectorAll('button')].some(button=>!contained(button.getBoundingClientRect())))throw new Error('Library options escape the sidebar or guest');
            options.querySelector('summary').click();
            return {left:bounds.left,right:bounds.right,sidebarWidth:sidebar.width,viewport:innerWidth,contained:true};
          })()`)
          facts.push({ theme, variant, state, menu })
          await controls.wait(
            async () =>
              (await guest.executeJavaScript(`(() => {
            const summary=document.querySelector('.search-options > summary');
            if(!summary?.checkVisibility())return false;summary.click();return summary.parentElement.open;
          })()`)) === true,
            'ordinary Search options disclosure',
          )
          facts.push({
            theme,
            variant,
            state,
            searchOptions: (await guest.executeJavaScript(`(() => {
            const checkbox=document.getElementById('include-installed'), note=document.getElementById('installed-note');
            return {visible:note.checkVisibility(), unknown:note.textContent.includes('unknown'), disabled:checkbox.disabled, checked:checkbox.checked};
          })()`)) as unknown,
          })
          await settled()
          await write(`library-${theme}-${variant}-search-options`)
          await guest.executeJavaScript(
            "document.querySelector('.search-options > summary').click()",
          )
        }
        if (['unapproved', 'library', 'instructions'].includes(state)) {
          await controls.click('Open settings')
          await section('Extensions', 'extensions')
          await verifyExtensionSettingsGeometry(win, (predicate, label) =>
            controls.wait(predicate, label),
          )
          if (state === 'library' || state === 'instructions')
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(
                  "[...document.querySelectorAll('.extension-installation fieldset [role=status]')].some(e=>e.textContent.trim().startsWith('Approved'))",
                )) === true,
              'current approved program identity',
            )
          await settled()
          facts.push({
            theme,
            variant,
            state,
            settings: (await win.webContents.executeJavaScript(`(() => {
            const section = document.querySelector('.extension-settings'), scroll = section.querySelector('.extension-settings-pane');
            const heading = document.getElementById('settings-extensions-title');
            const add = [...section.querySelectorAll('button')].find(e => e.textContent.trim() === 'Add extension…');
            const checkbox=[...section.querySelectorAll('.agent-access-settings input[type=checkbox]')].find(e=>e.checkVisibility());
            const scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hvir-interface-scale'));
            const text=checkbox&&[...checkbox.parentElement.childNodes].find(e=>e.nodeType===Node.TEXT_NODE&&e.textContent.trim());
            const range=document.createRange();if(text)range.selectNodeContents(text);
            const check=checkbox?.getBoundingClientRect(), label=text?range.getBoundingClientRect():null;
            const beside=check&&label?Math.abs(check.width-14*scale)<.5&&check.right<=label.left+2&&check.top<label.bottom&&label.top<check.bottom:null;
            const bounds = section.getBoundingClientRect(), rect = add.getBoundingClientRect(), style = getComputedStyle(add);
            return {checkboxBesideText:beside, checkboxWidth:check?.width??null, theme:document.documentElement.dataset.theme, headingVisible:heading.checkVisibility(),
              hasScroll:!!scroll, scrollOverflow:scroll ? getComputedStyle(scroll).overflowY : null,
              headingBeforeContent:!!scroll && heading.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top,
              addFits:rect.left >= bounds.left && rect.right <= bounds.right,
              buttonBorder:style.borderTopStyle, buttonBorderWidth:style.borderTopWidth, buttonRadius:style.borderTopLeftRadius};
          })()`)) as unknown,
          })
          const configuration: unknown = await win.webContents.executeJavaScript(`(() => {
            const panel=document.querySelector('.extension-configuration-layout'), list=panel?.querySelector('.extension-installation-list'), detail=panel?.querySelector('.extension-installation');
            if(!panel||!list||!detail)return {present:false};
            const p=panel.getBoundingClientRect(), l=list.getBoundingClientRect(), r=detail.parentElement.getBoundingClientRect();
            const selected=list.querySelector('[aria-current=true]');
            const contained=l.left>=p.left&&r.right<=p.right+1&&l.right<=r.left+1&&l.height<=p.height&&r.height<=p.height;
            if(!contained||getComputedStyle(list).overflowY!=='auto'||getComputedStyle(detail.parentElement).overflowY!=='auto')throw new Error('Extension configuration list/detail is not bounded and independently scrollable');
            return {present:true,count:list.querySelectorAll('button').length,selectedMatches:selected?.querySelector('strong')?.textContent===detail.querySelector('h4')?.textContent,contained,listWidth:l.width,detailWidth:r.width,panelHeight:p.height};
          })()`)
          facts.push({ theme, variant, state, configuration })
          await write(`settings-${state}-${theme}-${variant}`)
          if (state === 'library' || state === 'instructions') {
            for (const name of ['File access', 'Extension actions']) {
              await controls.click(name)
              await controls.wait(
                async () =>
                  (await win.webContents.executeJavaScript(
                    `document.querySelector('.extension-configuration-tabs [aria-current=true]')?.textContent===${JSON.stringify(name)}`,
                  )) === true,
                'current selected configuration section',
              )
              if (name === 'File access') {
                await controls.wait(
                  async () =>
                    (await win.webContents.executeJavaScript(
                      `[...document.querySelectorAll('.extension-installation fieldset [role=status]')].some(e=>e.textContent.trim().startsWith(${JSON.stringify(state === 'instructions' ? 'Granted' : 'Not granted')}))`,
                    )) === true,
                  'current library reading permission state',
                )
                await win.webContents.executeJavaScript(
                  "document.querySelector('.extension-settings-pane').scrollTop=0",
                )
              }
              await settled()
              await write(
                `settings-${name === 'File access' ? 'files' : 'actions'}-${theme}-${variant}`,
              )
            }
            await controls.click('Program access')
          }
          if (state === 'instructions') {
            await extensionSettingsControls(win, 'Skillager', {
              wait: (predicate, label) => controls.wait(predicate, label),
              within: (work) => work,
            }).click('Remove')
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(`(() => {
                  const dialog=document.querySelector('[aria-labelledby="extension-remove-title"]');
                  return !!dialog&&dialog.contains(document.activeElement)&&document.activeElement.textContent.trim()==='Cancel'&&!dialog.querySelector('input[type=checkbox]').checked;
                })()`)) === true,
              'removal defaults to keeping setup with safe Cancel focus',
            )
            await settled()
            await write(`settings-removal-${theme}-${variant}-unchecked`)
            const checkbox = (await win.webContents.executeJavaScript(`(() => {
              const label=document.querySelector('.extension-forget-choice'), input=label.querySelector('input'), text=label.querySelector('span');
              const range=document.createRange();range.selectNodeContents(text);const first=range.getClientRects()[0], box=input.getBoundingClientRect();
              if(!input.checkVisibility()||box.width<=0||box.right>first.left||box.top>=first.bottom||box.bottom<=first.top||text.getBoundingClientRect().right>innerWidth)throw new Error('Removal checkbox is not beside the first label line');
              return {x:Math.round(first.left+first.width/2),y:Math.round(first.top+first.height/2),checkboxWidth:box.width,firstLineHeight:first.height,aligned:true};
            })()`)) as { x: number; y: number }
            win.webContents.sendInputEvent({
              type: 'mouseDown',
              button: 'left',
              clickCount: 1,
              x: checkbox.x,
              y: checkbox.y,
            })
            win.webContents.sendInputEvent({
              type: 'mouseUp',
              button: 'left',
              clickCount: 1,
              x: checkbox.x,
              y: checkbox.y,
            })
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(
                  "document.querySelector('.extension-forget-choice input').checked && document.querySelector('[aria-labelledby=\"extension-remove-title\"]').textContent.includes('fresh setup')",
                )) === true,
              'native label activation toggles the removal choice and explanation',
            )
            await settled()
            await write(`settings-removal-${theme}-${variant}-checked`)
            facts.push({
              theme,
              variant,
              state,
              removal: { checkbox, labelToggles: true, defaultCancelFocus: true },
            })
            await controls.click('Cancel')
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(
                  "!document.querySelector('[aria-labelledby=\"extension-remove-title\"]') && document.querySelector('.extension-installation h4')?.textContent==='Skillager'",
                )) === true,
              'Cancel preserves the selected installation',
            )
          }
          if (state === 'unapproved') {
            await section('Appearance', 'appearance')
            await settled()
            await write(`appearance-${theme}-${variant}`)
          }
          await controls.click('Close settings')
          await settingsClosed()
          await controls.select()
          await controls.wait(
            async () =>
              (await win.webContents.executeJavaScript(
                "!!document.querySelector('.extension-view:not([hidden])')",
              )) === true,
            'selected visual guest restored',
          )
          if (state === 'unapproved') {
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(`(() => {
              const button=document.querySelector('.workbench-health-toggle');
              if(!button?.checkVisibility()||button.disabled)return false;button.click();return true;
            })()`)) === true,
              'ordinary health control',
            )
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(
                  "!!document.querySelector('.workbench-health-dialog')",
                )) === true,
              'actual health dialog',
            )
            await settled()
            await write(`health-${theme}-${variant}`)
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(`(() => {
              const button=[...document.querySelectorAll('.workbench-health-dialog button')].find(e=>e.textContent.trim()==='Close');
              if(!button?.checkVisibility()||button.disabled)return false;button.click();return true;
            })()`)) === true,
              'ordinary health Close control',
            )
            await controls.wait(
              async () =>
                (await win.webContents.executeJavaScript(
                  "!document.querySelector('.workbench-health-dialog')",
                )) === true,
              'health dialog closed',
            )
          }
        }
      }
    }
    await host.writeFile(
      joinHostPath(output, `${state}-geometry.json`),
      JSON.stringify(facts, null, 2),
    )
  } finally {
    try {
      if (
        !(await win.webContents.executeJavaScript(
          "!!document.querySelector('.settings-dialog')",
        ))
      )
        await controls.click('Open settings')
      await section('Appearance', 'appearance')
      await win.webContents.executeJavaScript(`(() => {
      for (const [id,value] of [['settings-app-theme',${JSON.stringify(originalTheme)}],['settings-interface-scale',${JSON.stringify(originalScale)}]]) {
        const control=document.getElementById(id), proto=control.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(control,value);
        control.dispatchEvent(new Event(control.tagName==='SELECT'?'change':'input',{bubbles:true}));
      }
    })()`)
      await controls.click('Save app settings')
      win.setContentSize(originalSize[0]!, originalSize[1]!)
      await controls.select()
    } catch (error) {
      cleanupFailure =
        error instanceof Error
          ? error
          : new Error('Visual restoration failed', { cause: error })
      console.error('[smoke] extension visual restoration failed')
    }
  }
  if (cleanupFailure) throw cleanupFailure
  async function instructionImages(phase: string): Promise<void> {
    if (controls.expectedInstructionImages === undefined) return
    await controls.wait(
      async () =>
        (await guest.executeJavaScript(`(() => {
          const images=[...document.querySelectorAll('#instructions img')];
          return images.length===${controls.expectedInstructionImages} && images.every(image=>image.complete&&image.naturalWidth>0&&image.naturalHeight>0&&image.checkVisibility());
        })()`)) === true,
      `all known instruction images remain decoded ${phase}`,
    )
  }
  async function section(name: string, id: string): Promise<void> {
    const responsive = (await win.webContents.executeJavaScript(`(() => {
      const selector=document.querySelector('.settings-section-selector select');
      if (!selector?.checkVisibility() || selector.disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(selector,${JSON.stringify(id)});
      selector.dispatchEvent(new Event('change',{bubbles:true})); return true;
    })()`)) as boolean
    if (!responsive) await controls.click(name)
    await controls.wait(
      async () =>
        (await win.webContents.executeJavaScript(
          `!!document.getElementById(${JSON.stringify(`settings-${id}-title`)})`,
        )) === true,
      `actual ${name} section selected`,
    )
  }
  async function settingsClosed(): Promise<void> {
    await controls.wait(
      async () =>
        (await win.webContents.executeJavaScript(
          "!document.querySelector('.settings-dialog')",
        )) === true,
      'appearance/settings close publication',
    )
  }
  async function settled(): Promise<void> {
    await win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
  }
  async function write(name: string): Promise<void> {
    if (
      /^(unapproved|library|instructions|project|acceptance|add|update|remove|management|import|import-files|router|router-members|preserved-original|library-selected)-/.test(
        name,
      )
    ) {
      await host.writeFile(
        joinHostPath(output, `${name}-guest.png`),
        (await guest.capturePage()).toPNG(),
      )
      // Publish the current guest surface through the existing parent-frame barrier.
      await settled()
    }
    await host.writeFile(
      joinHostPath(output, `${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
  }
}
