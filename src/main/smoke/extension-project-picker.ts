import type { BrowserWindow } from 'electron'
import type { ProjectState } from '../../shared/workspace-types'
import { focusSmokeWindow } from './window-focus'
import { withinExtensionInspection } from './skillager-management-controls'

/** Exercise the trusted registered hierarchy, never infer a project from a path. */
export async function chooseExtensionWorkspace(
  win: BrowserWindow,
  workspaceId: string,
  container: string,
  wait: (predicate: () => Promise<boolean>, label: string) => Promise<void>,
): Promise<void> {
  const project = (await inspect(
    win,
    'window.hvir.invoke("project:root")',
  )) as ProjectState
  const registered = project.projects.find((entry) =>
    entry.workspaces.some((workspace) => workspace.id === workspaceId),
  )
  if (!registered) throw new Error('Exact extension destination is not registered')
  await wait(
    async () =>
      (await inspect(
        win,
        `(() => {
        const select=document.querySelector(${JSON.stringify(container)})?.querySelector('[aria-label="Extension project destination"]');
        if(!select?.checkVisibility()||select.disabled)return false;
        select.value=${JSON.stringify(registered.id)};
        if(select.value!==${JSON.stringify(registered.id)})throw new Error('Registered project is absent from trusted picker');
        select.dispatchEvent(new Event('change',{bubbles:true}));return true;
      })()`,
      )) === true,
    'visible registered extension project choice',
  )
  await wait(
    async () =>
      (await inspect(
        win,
        `(() => {
        const pane=document.querySelector(${JSON.stringify(container)}), project=pane?.querySelector('[aria-label="Extension project destination"]');
        if(!project||project.disabled||project.value!==${JSON.stringify(registered.id)})return false;
        const select=pane.querySelector('[aria-label="Extension worktree destination"]');
        if(!select)return ${registered.workspaces.length === 1};
        if(!select.checkVisibility()||select.disabled)return false;
        select.value=${JSON.stringify(workspaceId)};
        if(select.value!==${JSON.stringify(workspaceId)})throw new Error('Exact worktree is absent from trusted picker');
        select.dispatchEvent(new Event('change',{bubbles:true}));return true;
      })()`,
      )) === true,
    'visible exact extension worktree choice',
  )
  if (registered.workspaces.length > 1) {
    await focusSmokeWindow(win, 'window')
    const point = (await inspect(
      win,
      `(() => {
      const heading=document.querySelector(${JSON.stringify(container)})?.querySelector('.extension-view-identity'),r=heading?.getBoundingClientRect();
      if(!heading?.checkVisibility()||!r||r.width<=0||r.height<=0||r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1)throw new Error('Trusted extension identity is not reachable');
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    })()`,
    )) as { x: number; y: number }
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await wait(
      async () =>
        (await inspect(
          win,
          `(() => {
      const pane=document.querySelector(${JSON.stringify(container)}),project=pane?.querySelector('[aria-label="Extension project destination"]'),tree=pane?.querySelector('[aria-label="Extension worktree destination"]');
      if(!document.hasFocus()||!project||project.disabled||!tree||tree.disabled||tree.value!==${JSON.stringify(workspaceId)})return false;
      project.focus();return document.activeElement===project;
    })()`,
        )) === true,
      'native project picker keyboard focus',
    )
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await wait(
      async () =>
        (await inspect(
          win,
          `document.hasFocus()&&document.activeElement.getAttribute('aria-label')==='Extension worktree destination'&&document.activeElement.matches(':focus-visible')`,
        )) === true,
      'keyboard reaches scoped Worktree control',
    )
  }
}

export async function inspectExtensionProjectPicker(
  win: BrowserWindow,
  viewId: string,
): Promise<unknown> {
  return inspect(
    win,
    `(() => {
    const pane=document.querySelector('[data-extension-view="'+${JSON.stringify(viewId)}+'"]');
    const project=pane?.querySelector('[aria-label="Extension project destination"]'), tree=pane?.querySelector('[aria-label="Extension worktree destination"]'), location=pane?.querySelector('.extension-workspace-location');
    const heading=pane?.querySelector('.extension-view-heading'),title=heading?.querySelector(':scope > span'),close=heading?.querySelector(':scope > button');
    const fits=e=>{const r=e?.getBoundingClientRect();return e?.checkVisibility()&&r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1};
    if(!fits(project)||!fits(tree)||!location?.textContent||project.getAttribute('aria-describedby')!==location.id||tree.getAttribute('aria-describedby')!==location.id||project.title!==location.textContent||tree.title!==location.textContent||project.options.length<3||tree.options.length<2)throw new Error('Project/worktree hierarchy or exact accessible destination failed');
    const t=title?.getBoundingClientRect(),c=close?.getBoundingClientRect();
    if(!fits(title)||!fits(close)||Math.abs((t.top+t.bottom)/2-(c.top+c.bottom)/2)>2)throw new Error('Extension title and Close became separate rows');
    return {headingPaired:true,projects:project.options.length-1,worktrees:tree.options.length,projectLabel:project.selectedOptions[0].textContent,worktreeLabel:tree.selectedOptions[0].textContent,exactLocation:location.textContent,contained:true};
  })()`,
  )
}

function inspect(win: BrowserWindow, expression: string): Promise<unknown> {
  return withinExtensionInspection(win.webContents.executeJavaScript(expression))
}
