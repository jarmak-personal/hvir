import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

interface VisualControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  select(): Promise<void>
  painted?(): Promise<unknown>
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
  state: 'unapproved' | 'library' | 'instructions' | 'project',
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
        const scale = variant === 'ordinary' ? '1' : '1.3'
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
        if (state === 'library')
          await controls.wait(
            async () =>
              (await guest.executeJavaScript(
                "document.querySelectorAll('#skills [role=option]').length===100 && !['loading','stale','error'].includes(document.getElementById('state').dataset.state)",
              )) === true,
            'current public library result after appearance save',
          )
        await settled()
        if (state !== 'instructions')
          facts.push({
            theme,
            variant,
            state,
            search: await verifySkillagerSearchGeometry(guest),
          })
        if (controls.painted)
          facts.push({ theme, variant, state, navigation: await controls.painted() })
        facts.push({
          theme,
          variant,
          state,
          guest: (await guest.executeJavaScript(`(() => {
          const main = document.querySelector('main'), body = getComputedStyle(document.body);
          const button = document.querySelector('.toolbar .hvir-button'), style = getComputedStyle(button);
          const input = document.getElementById('query');
          const scroll = document.getElementById('skills') ?? document.getElementById('instructions');
          return {stateKind:document.getElementById('state').dataset.state,
            observedRows:document.querySelectorAll('#skills [role=option]').length,
            actionableApproval:document.getElementById('state').textContent.includes('Settings'),
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
        if (state === 'library') {
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
        if (state !== 'instructions' && state !== 'project') {
          await controls.click('Open settings')
          await section('Extensions', 'extensions')
          await settled()
          facts.push({
            theme,
            variant,
            state,
            settings: (await win.webContents.executeJavaScript(`(() => {
            const section = document.querySelector('.extension-settings'), scroll = section.querySelector('.settings-section-scroll');
            const heading = document.getElementById('settings-extensions-title');
            const add = [...section.querySelectorAll('button')].find(e => e.textContent.trim() === 'Add extension…');
            const checkbox=section.querySelector('.agent-access-settings input[type=checkbox]');
            const text=checkbox&&[...checkbox.parentElement.childNodes].find(e=>e.nodeType===Node.TEXT_NODE&&e.textContent.trim());
            const range=document.createRange();if(text)range.selectNodeContents(text);
            const check=checkbox?.getBoundingClientRect(), label=text?range.getBoundingClientRect():null;
            const beside=!!check&&!!label&&check.width<=20&&check.right<=label.left+2&&check.top<label.bottom&&label.top<check.bottom;
            const bounds = section.getBoundingClientRect(), rect = add.getBoundingClientRect(), style = getComputedStyle(add);
            return {checkboxBesideText:beside, checkboxWidth:check?.width??null, theme:document.documentElement.dataset.theme, headingVisible:heading.checkVisibility(),
              hasScroll:!!scroll, scrollOverflow:scroll ? getComputedStyle(scroll).overflowY : null,
              headingBeforeContent:!!scroll && heading.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().top,
              addFits:rect.left >= bounds.left && rect.right <= bounds.right,
              buttonBorder:style.borderTopStyle, buttonBorderWidth:style.borderTopWidth, buttonRadius:style.borderTopLeftRadius};
          })()`)) as unknown,
          })
          await write(`settings-${state}-${theme}-${variant}`)
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
    await host.writeFile(
      joinHostPath(output, `${name}.png`),
      (await win.webContents.capturePage()).toPNG(),
    )
    if (/^(unapproved|library|instructions|project)-/.test(name))
      await host.writeFile(
        joinHostPath(output, `${name}-guest.png`),
        (await guest.capturePage()).toPNG(),
      )
  }
}
