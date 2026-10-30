import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionView } from '../../shared/extensions/workbench'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  chooseExtensionWorkspace,
  inspectExtensionProjectPicker,
} from './extension-project-picker'
import { captureExtensionVisuals } from './extension-visuals'
import { focusSmokeWindow } from './window-focus'
import {
  skillagerManagementControls,
  withinExtensionInspection,
} from './skillager-management-controls'
import { smokeScriptValue } from './script-value'

/** Actual installed-CLI journey through the selected library skill and trusted destination. */
export async function verifySelectedSkillTasks(
  win: BrowserWindow,
  host: ProjectHost,
  workspace: { readonly id: string; readonly root: HostPath },
  skillId: string,
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    guest(view: ExtensionView): Promise<WebContents>
    library(): ExtensionView | undefined
    project(): ExtensionView | undefined
    reader(): ExtensionView | undefined
  },
): Promise<Record<string, unknown>> {
  await controls.click('Skillager library')
  await controls.wait(() => !!controls.library(), 'selected task library view')
  const selectedView = controls.library()!,
    guest = await controls.guest(selectedView),
    ui = skillagerManagementControls(guest, controls)
  await ui.ready(
    "!!document.querySelector('#skills [data-source-toggle]')",
    'owned library source groups',
  )
  await ui.inspect("document.querySelector('#skills [data-source-toggle]').click()")
  await ui.ready(
    `!!document.querySelector('[data-id="${skillId}"]')`,
    'owned library skill',
  )
  await pointer(`[data-skill-select][data-id="${skillId}"]`)
  try {
    await ui.ready(
      "document.getElementById('instructions').textContent.length>0",
      'selected current instructions',
    )
  } catch (error) {
    console.log(
      '[smoke] owned selected reader boundary',
      await ui.inspect(
        "({selected:document.querySelector('[aria-current=true]')?.dataset.id,reader:document.getElementById('reader-state').textContent,task:document.getElementById('task-state').textContent,hidden:document.getElementById('reader-content').hidden})",
      ),
    )
    throw error
  }
  await ownedImage()
  await chooseExtensionWorkspace(
    win,
    workspace.id,
    '[data-extension-view="' + selectedView.id + '"]',
    (predicate, label) => controls.wait(predicate, label),
  )
  await ui.ready(
    `document.getElementById('task-destination').title.includes(${JSON.stringify(workspace.root.path)})`,
    'visible exact project destination',
  )
  await ui.ready(
    "!document.getElementById('exact-review').hidden && document.querySelectorAll('[data-review-path]').length===3 && !document.getElementById('accept-version').disabled",
    'complete optional inventory with one acceptance decision',
  )
  await captureReview('acceptance', 'exact-review', 'accept-version')
  await pointer('#accept-version')
  const accepted = await result('accept-version')
  await ui.ready(
    "document.getElementById('task-primary').textContent==='Add to project' && !document.getElementById('task-primary').disabled",
    'accepted source ready in the same reader',
  )
  await ui.set('query', 'owned-consumer')
  await ui.inspect("document.getElementById('search-form').requestSubmit()")
  await ui.ready(
    "document.getElementById('state').textContent.includes('match')",
    'selected task search',
  )
  await ui.ready(
    "document.querySelectorAll('#skills [data-skill-select]').length===1 && document.querySelector('#skills [data-skill-select]').textContent.includes('owned-consumer')",
    'accepted indexed search result',
  )
  await pointer('#skills [data-skill-select]')
  await ui
    .ready(
      "document.getElementById('task-primary').textContent==='Add to project' && !document.getElementById('task-primary').disabled && document.getElementById('instructions').textContent.length>0",
      'search occurrence resolved to the exact accepted source',
    )
    .catch(async (error) => {
      console.log(
        '[smoke] selected search boundary',
        await ui.inspect(
          "({task:document.getElementById('task-state').textContent,primary:document.getElementById('task-primary').textContent,disabled:document.getElementById('task-primary').disabled,reader:document.getElementById('reader-state').textContent,reading:document.getElementById('instructions').textContent.length,selected:document.querySelector('#skills [aria-current=true]')?.dataset.id,reviewHidden:document.getElementById('exact-review').hidden})",
        ),
      )
      throw error
    })
  await ownedImage()
  await captureReview('add', 'selected-task', 'task-primary')
  const selectedAgent = (await ui.inspect(`(() => {
    const option=document.getElementById('task-agent').selectedOptions[0];
    if(option?.textContent.trim()!=='Codex'||!option.value)throw new Error('Expected displayed Add agent is unavailable');
    return option.value;
  })()`)) as string
  await focusSmokeWindow(win, 'window')
  // Appearance captures return focus to the workbench; enter the guest with real input.
  await ui.ready(
    "document.getElementById('state').dataset.state==='ready' && !document.getElementById('task-mode').disabled",
    'current list and selected task settled before keyboard entry',
  )
  await pointer('#task-mode')
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await ui
    .ready(
      "document.hasFocus() && document.activeElement.id==='task-mode'",
      'native selected-task keyboard starting focus',
    )
    .catch(async (error) => {
      console.log(
        '[smoke] selected keyboard starting boundary',
        await ui.inspect(
          "({focus:document.hasFocus(),active:document.activeElement.id,visible:document.getElementById('task-mode').checkVisibility(),disabled:document.getElementById('task-mode').disabled})",
        ),
      )
      throw error
    })
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await ui.ready(
    "document.hasFocus() && document.activeElement.id==='task-primary' && document.activeElement.matches(':focus-visible') && getComputedStyle(document.activeElement).outlineStyle!=='none' && !document.activeElement.disabled",
    'keyboard reaches the primary Add action',
  )
  await ui.inspect(`(() => {
    const events=[], started=performance.now(), record=value=>{
      if(events.length<48)events.push({ms:Math.round(performance.now()-started),...value});
    }, input=event=>record({kind:event.type,key:event.key,target:event.target.id});
    for(const type of ['keydown','keyup','click'])document.addEventListener(type,input,true);
    const release=window.hvirExtension.onMessage(message=>{
      if(message.kind==='context')record({kind:'context',visible:message.context.visible,workspace:message.context.workspace?.id});
      if(message.kind==='result')record({kind:'result',ok:message.ok,action:message.value?.action,outcome:message.value?.outcome});
      if(message.kind==='revoked')record({kind:'revoked'});
    });
    window.__hvirSelectedAddTrace={events,stop:()=>{release();for(const type of ['keydown','keyup','click'])document.removeEventListener(type,input,true);}};
  })()`)
  try {
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    guest.sendInputEvent({ type: 'char', keyCode: '\r' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await result('add-copy')
  } finally {
    console.log(
      '[smoke] selected Add public input/result trace',
      await ui.inspect(`(() => {
        const trace=window.__hvirSelectedAddTrace;trace.stop();delete window.__hvirSelectedAddTrace;
        return {events:trace.events,primary:document.getElementById('task-primary').textContent,hidden:document.getElementById('task-primary').hidden,modeDisabled:document.getElementById('task-mode').disabled};
      })()`),
    )
  }
  await ui.ready(
    "document.getElementById('task-primary').textContent==='Added'",
    'quiet installed state',
  )
  if (
    !(await ui.inspect(
      "document.getElementById('query').value==='owned-consumer' && document.getElementById('instructions').textContent.length>0",
    ))
  )
    throw new Error('Selected task lost the search or instructions')
  await sidebarSelection()
  await controls.click('Skillager library')
  await ui.ready(
    "document.getElementById('task-primary').textContent==='Added' && !document.getElementById('task-mode').disabled",
    'independent Library retains its current selected copy after sidebar browsing',
  )
  await ui.inspect("document.getElementById('instructions').scrollTop=160")
  const retainedScroll = (await ui.inspect(
    "document.getElementById('instructions').scrollTop",
  )) as number
  if (retainedScroll < 100)
    throw new Error('Owned instructions did not exercise reading position')
  await captureExtensionVisuals(win, guest, host, 'instructions', {
    ...controls,
    expectedInstructionImages: 1,
    select: async () => {
      await controls.click('Skillager library')
      await controls.wait(
        async () =>
          Boolean(
            await withinExtensionInspection(
              win.webContents.executeJavaScript(
                `document.querySelector('.extension-top-destination .extension-view:not([hidden])')?.dataset.extensionView===${JSON.stringify(selectedView.id)} && (()=>{const view=document.querySelector('[data-extension-view="${selectedView.id}"]'),frame=view.querySelector('webview'),r=frame.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.width>0&&r.top>=0&&r.bottom<=innerHeight+1})()`,
              ),
            ),
          ),
        'captured visible view is the inspected selected guest',
      )
      try {
        await ui.ready(
          `document.getElementById('state').dataset.state==='ready' && document.getElementById('task-primary').textContent==='Added' && document.getElementById('task-state').textContent==='' && !document.getElementById('task-mode').disabled && document.getElementById('query').value==='owned-consumer' && document.getElementById('task-destination').title.includes(${JSON.stringify(workspace.root.path)}) && document.getElementById('instructions').textContent.length>0 && Math.abs(document.getElementById('instructions').scrollTop-${retainedScroll})<1 && !!document.querySelector('#skills [aria-current=true]')`,
          'return retains query destination selected occurrence and reading position',
        )
      } catch (error) {
        console.log(
          '[smoke] selected return boundary',
          await ui.inspect(
            "({list:document.getElementById('state').textContent,listKind:document.getElementById('state').dataset.state,primary:document.getElementById('task-primary').textContent,task:document.getElementById('task-state').textContent,query:document.getElementById('query').value,destination:document.getElementById('task-destination').textContent,instructions:document.getElementById('instructions').textContent.length,scroll:document.getElementById('instructions').scrollTop,selected:document.querySelector('#skills [aria-current=true]')?.dataset.id})",
          ),
        )
        throw error
      }
    },
    painted: async () => {
      const facts = await ui.inspect(`(() => {
        const article=document.getElementById('instructions'), action=document.getElementById('task-mode'), destination=document.getElementById('task-destination');
        const a=article.getBoundingClientRect(), b=action.getBoundingClientRect();
        const fits=r=>r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;
        const result={readingHeight:a.height, readingWidth:a.width, readingFits:fits(a), actionFits:fits(b), destinationVisible:destination.checkVisibility(), overflow:getComputedStyle(article).overflowY};
        if(!article.checkVisibility()||a.height<120||a.width<180||!fits(a)||!fits(b)||!destination.checkVisibility()||result.overflow!=='auto')throw new Error('Selected-skill reading space or primary action is unreachable');
        return result;
      })()`)
      return {
        reader: facts,
        destination: await inspectExtensionProjectPicker(win, selectedView.id),
      }
    },
  })
  await ui.set('task-mode', 'stub')
  await ui.ready(
    "!document.getElementById('task-confirmation').hidden && document.getElementById('task-effects').textContent.includes('SKILL.md')",
    'complete affected-file summary',
  )
  await captureReview('update', 'task-confirmation', 'task-confirm')
  await pointer('#task-cancel')
  if ((await ui.inspect("document.getElementById('task-mode').value")) !== 'native')
    throw new Error('Canceled conversion changed the displayed actual mode')
  await ui.set('task-mode', 'stub')
  await ui.ready(
    "!document.getElementById('task-confirmation').hidden",
    'fresh update confirmation',
  )
  await pointer('#task-confirm')
  await result('change-exposure')
  await pointer('#task-options > summary')
  await pointer('#task-remove')
  await ui.ready(
    "!document.getElementById('task-confirmation').hidden",
    'contextual remove summary',
  )
  await captureReview('remove', 'task-confirmation', 'task-confirm')
  await pointer('#task-confirm')
  await result('remove-copy')
  console.log(
    '[smoke] selected skill: search/read, trusted exact destination, one acceptance decision without visits, direct Add, mode-change Update, cancellation, Remove; retained query/instructions OK',
  )
  await withinExtensionInspection(
    win.webContents.executeJavaScript(
      "document.querySelector('.project-tab-main').click()",
    ),
  )
  await controls.wait(
    async () =>
      Boolean(
        await withinExtensionInspection(
          win.webContents.executeJavaScript(`(() => {
    const tab=[...document.querySelectorAll('.viewer-tab .tab-main')].find(item=>item.title==='Skillager · Manage skills');
    if(!tab?.checkVisibility())return false;tab.click();return true;
  })()`),
        ),
      ),
    'return to advanced management',
  )
  return accepted

  async function sidebarSelection(): Promise<void> {
    await withinExtensionInspection(
      win.webContents.executeJavaScript(
        "document.querySelector('.project-tab-main').click()",
      ),
    )
    await controls.click('Skills in this project')
    await controls.wait(() => !!controls.project(), 'existing project sidebar')
    const sidebar = await controls.guest(controls.project()!),
      browser = skillagerManagementControls(sidebar, controls)
    sidebar.focus()
    sidebar.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    sidebar.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await browser.ready(
      "!document.querySelector('.library-options').open",
      'secondary browser menu closed before selecting rows',
    )
    await browser.set('query', 'owned-consumer')
    await browser.inspect("document.getElementById('search-form').requestSubmit()")
    await browser.ready(
      "document.getElementById('state').dataset.state==='ready' && document.querySelectorAll('#skills [data-skill-select]').length===1",
      'exact managed project occurrence in the unified browser',
    )
    const projectPath = await browser.inspect(
      "document.querySelector('#skills [data-skill-select]').dataset.sourcePath",
    )
    await browser.inspect("document.querySelector('#skills [data-skill-select]').click()")
    await controls.wait(
      () => !!controls.reader(),
      'existing selected instruction contribution',
    )
    const reader = await controls.guest(controls.reader()!),
      detail = skillagerManagementControls(reader, controls)
    await detail.ready(
      "document.readyState==='complete' && !!document.getElementById('reader-state') && !!document.getElementById('task-agent-name') && !!document.getElementById('task-mode')",
      'selected reader document loaded before inspecting its task',
    )
    await detail.ready(
      `document.getElementById('reader-state').dataset.state==='ready' && document.getElementById('task-agent-name').textContent===${JSON.stringify(selectedAgent)} && document.getElementById('task-agent-field').hidden && document.getElementById('task-mode').value==='native' && !document.getElementById('task-mode').disabled`,
      'selected managed Project copy exposes its actual agent and mode',
    )
    await captureSidebar('sidebar-managed-project')
    await browser.click('scope-library')
    await browser.ready(
      "document.getElementById('state').dataset.state==='ready' && document.querySelectorAll('#skills [data-source-toggle]').length===1 && document.querySelector('#skills [data-source-toggle]').getAttribute('aria-expanded')==='false' && document.querySelectorAll('#skills [data-skill-select]').length===0",
      'sidebar Library starts with the owned source collapsed',
    )
    await browser.inspect(
      "document.querySelector('#skills [data-source-toggle]').click()",
    )
    await browser.ready(
      `document.getElementById('state').dataset.state==='ready' && !!document.querySelector('[data-id="${skillId}"]')`,
      'same sidebar Library metadata',
    )
    await browser.inspect(
      `document.querySelector('[data-skill-select][data-id="${skillId}"]').click()`,
    )
    await detail.ready(
      "document.getElementById('reader-state').dataset.state==='ready' && !document.getElementById('task-agent-field').hidden && document.getElementById('instructions').textContent.includes('Owned complete fixture revision two') && !document.getElementById('task-mode').disabled",
      'selected Library instructions and tasks share the Project reader',
    )
    if ((await controls.guest(controls.reader()!)).id !== reader.id)
      throw new Error('Sidebar Library selection created a second reader')
    await captureSidebar('sidebar-selected-library')
    await browser.click('scope-project')
    await browser.ready(
      `document.getElementById('query').value==='owned-consumer' && document.querySelector('#skills [aria-current=true]')?.dataset.sourcePath===${JSON.stringify(projectPath)}`,
      'return restores the exact Project query and selected managed occurrence',
    )
    await detail.ready(
      `document.getElementById('reader-state').dataset.state==='ready' && document.getElementById('task-agent-name').textContent===${JSON.stringify(selectedAgent)} && document.getElementById('task-agent-field').hidden && !document.getElementById('task-mode').disabled`,
      'return restores the selected Project task identity',
    )
    console.log(
      '[smoke] one sidebar: managed Project identity → selected Library instructions/tasks → exact Project query/selection, same reader OK',
    )
    async function captureSidebar(name: string): Promise<void> {
      const directory = process.env.HVIR_EXTENSION_VISUAL_DIRECTORY
      if (!directory) return
      await detail.inspect(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      )
      await host.writeFile(
        joinHostPath(localPath(directory), `${name}.png`),
        (await win.webContents.capturePage()).toPNG(),
      )
      await host.writeFile(
        joinHostPath(localPath(directory), `${name}.json`),
        JSON.stringify({ readerId: reader.id, projectPath, skillId, workspace }, null, 2),
      )
    }
  }
  async function ownedImage(): Promise<void> {
    await ui.ready(
      "(() => { const images=[...document.querySelectorAll('#instructions img')]; return images.length===1 && images[0].complete && images[0].naturalWidth===1280 && images[0].naturalHeight===120; })()",
      'known selected image decoded before changing destination or hiding the reader',
    )
  }

  async function pointer(selector: string): Promise<void> {
    await ui.inspect(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`,
    )
    await ui.ready(
      `(() => {
      const element=document.querySelector(${JSON.stringify(selector)});if(!element?.checkVisibility()||element.disabled)return false;
      const r=element.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
      return r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&element.contains(document.elementFromPoint(x,y));
    })()`,
      `visible reachable ${selector}`,
    )
    const point = (await ui.inspect(
      `(() => {const r=document.querySelector(${smokeScriptValue(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    )) as { x: number; y: number }
    win.focus()
    guest.focus()
    guest.sendInputEvent({ type: 'mouseMove', ...point })
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }

  async function captureReview(
    state: 'acceptance' | 'add' | 'update' | 'remove',
    section: string,
    confirm: string,
  ): Promise<void> {
    await captureExtensionVisuals(win, guest, host, state, {
      ...controls,
      select: async () => {
        await controls.click('Skillager library')
        await controls.wait(
          async () =>
            (await win.webContents.executeJavaScript(
              `document.querySelector('.extension-top-destination .extension-view:not([hidden]) webview')?.getWebContentsId()===${guest.id}`,
            )) === true,
          'review capture belongs to the visible guest',
        )
        await ui.ready(
          `document.getElementById('state').dataset.state==='ready' && document.getElementById('instructions').textContent.length>0 && ${state === 'acceptance' ? "!document.getElementById('exact-review').hidden" : "!document.getElementById('task-refresh').disabled"}`,
          'current selected review task',
        )
        if (await ui.inspect(`document.getElementById('${section}').hidden`)) {
          if (state === 'remove') {
            if (!(await ui.inspect("document.getElementById('task-options').open")))
              await pointer('#task-options > summary')
            await pointer('#task-remove')
          } else if (state === 'update') await ui.set('task-mode', 'stub')
          else if (state !== 'acceptance') await pointer('#task-primary')
        }
        await ui.ready(
          `!document.getElementById('${section}').hidden && !document.getElementById('${confirm}').disabled`,
          'review decision ready',
        )
        await ui.inspect(
          "document.getElementById('selected-task').scrollTop=0;document.getElementById('instructions').scrollTop=0",
        )
        await ui.inspect(
          `document.getElementById('${confirm}').scrollIntoView({block:'nearest'})`,
        )
        // Capture the resized guest once before the parent compositor snapshot.
        await guest.capturePage()
      },
      painted: async () =>
        ui.inspect(`(() => {
        const reader=document.getElementById('instructions').getBoundingClientRect(), action=document.getElementById('${confirm}'), task=document.getElementById('selected-task');
        const rect=action.getBoundingClientRect(), bounds=task.getBoundingClientRect();
        if(reader.height<120||reader.width<180||document.documentElement.scrollWidth>innerWidth)throw new Error('Review lost usable reading space');
        if(!action.checkVisibility()||rect.top<bounds.top||rect.bottom>bounds.bottom+1||rect.left<0||rect.right>innerWidth+1||rect.bottom>innerHeight+1)throw new Error('Review action is not fully visible within its task');
        return {readerHeight:reader.height,readerWidth:reader.width,confirmationVisible:action.checkVisibility(),confirmationWithinTask:rect.bottom<=bounds.bottom,taskScrolls:task.scrollHeight>task.clientHeight};
      })()`),
    })
  }

  async function result(action: string): Promise<Record<string, unknown>> {
    try {
      await ui.ready(
        `(() => {try{return JSON.parse(document.getElementById('task-result').textContent).action===${smokeScriptValue(action)}}catch{return false}})()`,
        `${action} selected task result`,
      )
    } catch (error) {
      console.log(
        '[smoke] selected task result boundary',
        await ui.inspect(
          "({state:document.getElementById('task-state').textContent,result:document.getElementById('task-result').textContent,focused:document.activeElement.id,focus:document.hasFocus(),disabled:document.getElementById('task-primary').disabled})",
        ),
      )
      throw error
    }
    const value = (await ui.inspect(
      "JSON.parse(document.getElementById('task-result').textContent)",
    )) as Record<string, unknown>
    if (value['outcome'] !== 'verified')
      throw new Error(`Selected task ${action} was ${String(value['outcome'])}`)
    return value
  }
}
