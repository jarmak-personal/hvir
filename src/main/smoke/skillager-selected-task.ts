import type { BrowserWindow, WebContents } from 'electron'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionVisuals } from './extension-visuals'
import { focusSmokeWindow } from './window-focus'
import {
  skillagerManagementControls,
  withinExtensionInspection,
} from './skillager-management-controls'

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
  },
): Promise<Record<string, unknown>> {
  await controls.click('Skillager library')
  await controls.wait(() => !!controls.library(), 'selected task library view')
  const selectedView = controls.library()!,
    guest = await controls.guest(selectedView),
    ui = skillagerManagementControls(guest, controls)
  await ui.ready(
    `!!document.querySelector('[data-id="${skillId}"]')`,
    'owned library skill',
  )
  await pointer(`[data-id="${skillId}"]`)
  try {
    await ui.ready(
      "document.getElementById('instructions').textContent.length>0",
      'selected current instructions',
    )
  } catch (error) {
    console.log(
      '[smoke] owned selected reader boundary',
      await ui.inspect(
        "({selected:document.querySelector('[aria-selected=true]')?.dataset.id,reader:document.getElementById('reader-state').textContent,task:document.getElementById('task-state').textContent,hidden:document.getElementById('reader-content').hidden})",
      ),
    )
    throw error
  }
  await withinExtensionInspection(
    win.webContents.executeJavaScript(`(() => {
    const pane=document.querySelector('.extension-top-destination .extension-view:not([hidden])');
    const select=pane?.querySelector('[aria-label="Extension project destination"]');
    if(!select)throw new Error('Trusted destination selector unavailable');
    select.value=${JSON.stringify(workspace.id)};select.dispatchEvent(new Event('change',{bubbles:true}));
  })()`),
  )
  await ui.ready(
    `document.getElementById('task-destination').textContent.includes(${JSON.stringify(workspace.root.path)}) && !document.getElementById('task-primary').disabled`,
    'visible exact project destination',
  )
  await pointer('#task-primary')
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
    "document.getElementById('state').textContent.includes('matches')",
    'selected task search',
  )
  await ui.ready(
    "document.querySelectorAll('#skills [role=option]').length===1 && document.querySelector('#skills [role=option]').textContent.includes('owned-consumer')",
    'accepted indexed search result',
  )
  await pointer('#skills [role=option]')
  await ui
    .ready(
      "document.getElementById('task-primary').textContent==='Add to project' && !document.getElementById('task-primary').disabled && document.getElementById('instructions').textContent.length>0",
      'search occurrence resolved to the exact accepted source',
    )
    .catch(async (error) => {
      console.log(
        '[smoke] selected search boundary',
        await ui.inspect(
          "({task:document.getElementById('task-state').textContent,primary:document.getElementById('task-primary').textContent,disabled:document.getElementById('task-primary').disabled,reader:document.getElementById('reader-state').textContent,reading:document.getElementById('instructions').textContent.length,selected:document.querySelector('#skills [aria-selected=true]')?.dataset.id,reviewHidden:document.getElementById('exact-review').hidden})",
        ),
      )
      throw error
    })
  await captureReview('add', 'selected-task', 'task-primary')
  await focusSmokeWindow(win, 'window')
  // Appearance captures return focus to the workbench; enter the guest with real input.
  await pointer('#task-destination')
  await ui.inspect("document.getElementById('task-mode').focus()")
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
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  guest.sendInputEvent({ type: 'char', keyCode: '\r' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await result('add-copy')
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
  await ui.inspect("document.getElementById('instructions').scrollTop=160")
  const retainedScroll = (await ui.inspect(
    "document.getElementById('instructions').scrollTop",
  )) as number
  if (retainedScroll < 100)
    throw new Error('Owned instructions did not exercise reading position')
  await captureExtensionVisuals(win, guest, host, 'instructions', {
    ...controls,
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
          `document.getElementById('state').dataset.state==='ready' && document.getElementById('task-primary').textContent==='Added' && document.getElementById('task-state').textContent.includes('In this project') && document.getElementById('query').value==='owned-consumer' && document.getElementById('task-destination').textContent.includes(${JSON.stringify(workspace.root.path)}) && document.getElementById('instructions').textContent.length>0 && Math.abs(document.getElementById('instructions').scrollTop-${retainedScroll})<1 && !!document.querySelector('#skills [aria-selected=true]')`,
          'return retains query destination selected occurrence and reading position',
        )
      } catch (error) {
        console.log(
          '[smoke] selected return boundary',
          await ui.inspect(
            "({list:document.getElementById('state').textContent,listKind:document.getElementById('state').dataset.state,primary:document.getElementById('task-primary').textContent,task:document.getElementById('task-state').textContent,query:document.getElementById('query').value,destination:document.getElementById('task-destination').textContent,instructions:document.getElementById('instructions').textContent.length,scroll:document.getElementById('instructions').scrollTop,selected:document.querySelector('#skills [aria-selected=true]')?.dataset.id})",
          ),
        )
        throw error
      }
    },
    painted: async () => {
      const facts = await ui.inspect(`(() => {
        const article=document.getElementById('instructions'), action=document.getElementById('task-primary'), destination=document.getElementById('task-destination');
        const a=article.getBoundingClientRect(), b=action.getBoundingClientRect();
        const fits=r=>r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;
        const result={readingHeight:a.height, readingWidth:a.width, readingFits:fits(a), actionFits:fits(b), destinationVisible:destination.checkVisibility(), overflow:getComputedStyle(article).overflowY};
        if(!article.checkVisibility()||a.height<120||a.width<180||!fits(a)||!fits(b)||!destination.checkVisibility()||result.overflow!=='auto')throw new Error('Selected-skill reading space or primary action is unreachable');
        return result;
      })()`)
      return facts
    },
  })
  await ui.set('task-mode', 'stub')
  await ui.ready(
    "document.getElementById('task-primary').textContent==='Update' && !document.getElementById('task-primary').disabled",
    'contextual mode change',
  )
  await pointer('#task-primary')
  await ui.ready(
    "!document.getElementById('task-confirmation').hidden && document.getElementById('task-effects').textContent.includes('SKILL.md')",
    'complete affected-file summary',
  )
  await captureReview('update', 'task-confirmation', 'task-confirm')
  await pointer('#task-cancel')
  await pointer('#task-primary')
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
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
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
          `document.getElementById('instructions').textContent.length>0 && !document.getElementById('${state === 'remove' ? 'task-remove' : 'task-primary'}').disabled`,
          'current selected review task',
        )
        if (await ui.inspect(`document.getElementById('${section}').hidden`)) {
          if (state === 'remove') {
            if (!(await ui.inspect("document.getElementById('task-options').open")))
              await pointer('#task-options > summary')
            await pointer('#task-remove')
          } else await pointer('#task-primary')
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
        `(() => {try{return JSON.parse(document.getElementById('task-result').textContent).action===${JSON.stringify(action)}}catch{return false}})()`,
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
