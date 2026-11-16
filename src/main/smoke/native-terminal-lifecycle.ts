import { app, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'

/** Combined browser/PTY/native lifetimes in the ordinary workbench, rather than
 * another renderer or an imitation terminal. Fixture output contains no user data. */
export async function verifyNativeTerminalLifetimes(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const original = native.sessions.get(managed.id)
  if (!original) throw new Error('native-lifecycle-missing-state')
  const handle = original.handle
  const evaluate = <T>(source: string): Promise<T> =>
    win.webContents.executeJavaScript(`(()=>{${source}})()`)
  const wait = async (read: () => Promise<boolean>, stage: string) => {
    const deadline = Date.now() + 15000
    do {
      if (await read()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error('native-lifecycle-timeout:' + stage)
  }
  const identity = () => {
    const current = ptys.get(managed.id),
      state = native.sessions.get(managed.id)
    if (
      ptys.list().length !== 1 ||
      current?.pid !== managed.pid ||
      current.instanceId !== managed.instanceId ||
      state?.handle !== handle ||
      state.session.instanceId !== managed.instanceId ||
      state.unavailable
    )
      throw new Error('native-lifecycle-replaced-state')
  }
  const marker = async (name: string) => {
    // Octal escape prevents shell echo from satisfying the parser observation.
    const escaped = [...name]
      .map((value) => '\\' + value.charCodeAt(0).toString(8))
      .join('')
    await ptys.writeConfirmed(
      managed.id,
      owner.id,
      `printf '${escaped}\\n'\r`,
      owner.generation,
    )
    await wait(
      async () =>
        new TextDecoder()
          .decode(await native.readRetained(managed.id, owner))
          .includes(name),
      name,
    )
  }
  const click = (selector: string) =>
    evaluate(
      `const node=document.querySelector(${JSON.stringify(selector)});if(!(node instanceof HTMLElement))throw new Error('native-lifecycle-control');node.click();return true;`,
    )
  const button = (label: string, root = 'document') =>
    evaluate(
      `const node=[...${root}.querySelectorAll('button')].find(value=>value.textContent?.trim()===${JSON.stringify(label)}&&!value.disabled);if(!(node instanceof HTMLButtonElement))throw new Error('native-lifecycle-button');node.click();return true;`,
    )
  const canvasCount = () =>
    evaluate<number>(
      `return document.querySelectorAll('[id^="native-terminal-"] canvas').length;`,
    )
  const viewId = await evaluate<string>(
    `const element=document.querySelector('.native-terminal-pane [id^="native-terminal-"]');if(!element)throw new Error('native-lifecycle-view');return element.id.slice('native-terminal-'.length);`,
  )
  let hiddenInputRefusals = 0
  const refusedInput = async () => {
    try {
      await native.key(viewId, owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
    } catch (error) {
      if (
        error instanceof Error &&
        /native-(view-hidden|presentation-unavailable)/.test(error.message)
      ) {
        hiddenInputRefusals++
        return
      }
      throw error
    }
    throw new Error('native-lifecycle-hidden-input-accepted')
  }
  const bounds = win.getContentBounds()
  const cycles = []
  app.focus({ steal: true })
  win.show()
  win.focus()
  win.webContents.focus()
  for (let cycle = 0; cycle < 3; cycle++) {
    await click('.sessions-destination')
    await wait(
      () => evaluate(`return !!document.querySelector('.sessions-overview');`),
      'overview',
    )
    await wait(async () => (await canvasCount()) === 0, 'hidden-release')
    await refusedInput()
    if (native.targets.drawn(viewId, win.webContents.mainFrame))
      throw new Error('native-lifecycle-hidden-drawn-authority')
    await marker('HVIR_LIFECYCLE_HIDDEN_' + cycle)
    identity()
    await wait(
      () =>
        evaluate(
          `return [...document.querySelectorAll('.session-card button')].some(value=>value.textContent?.trim()==='Interact'&&!value.disabled);`,
        ),
      'interact-ready',
    )
    await button('Interact', `document.querySelector('.sessions-overview')`)
    await wait(
      () =>
        evaluate(
          `return !!document.querySelector('.sessions-detail-terminal.ready [id^="native-terminal-"] canvas');`,
        ),
      'borrowed-canvas',
    )
    await marker('HVIR_LIFECYCLE_INTERACT_' + cycle)
    const before = (await native.inspectRetained(managed.id, owner)).geometry.serial
    const widthBefore = await evaluate<number>(
      `return document.querySelector('.sessions-detail-terminal-container').getBoundingClientRect().width;`,
    )
    // Sessions detail has a maximum width, so resizing an already wide window
    // need not resize its terminal. Change the actual borrowed container extent.
    await evaluate(
      `const container=document.querySelector('.sessions-detail-terminal-container');if(!(container instanceof HTMLElement))throw new Error('native-lifecycle-resize-container');for(let resize=0;resize<4;resize++)container.style.width='calc(100% - '+(resize%2?19:37)+'px)';return true;`,
    )
    const widthAfter = await evaluate<number>(
      `return document.querySelector('.sessions-detail-terminal-container').getBoundingClientRect().width;`,
    )
    if (!(widthAfter > 0 && widthAfter < widthBefore))
      throw new Error('native-lifecycle-resize-did-not-change-container')
    await wait(
      async () =>
        (await native.inspectRetained(managed.id, owner)).geometry.serial > before,
      'rapid-refit',
    )
    await evaluate(
      `document.querySelector('.sessions-detail-terminal-container').style.width='';return true;`,
    )
    await button('Close', `document.querySelector('.sessions-terminal-detail')`)
    await wait(
      () => evaluate(`return !document.querySelector('.sessions-terminal-detail');`),
      'borrow-release',
    )
    await wait(async () => (await canvasCount()) === 0, 'overview-release')
    await click('.project-tab-main')
    await wait(
      () =>
        evaluate(
          `return !!document.querySelector('.workbench:not([hidden]) .native-terminal-pane canvas');`,
        ),
      'workspace-return',
    )
    await marker('HVIR_LIFECYCLE_RETURN_' + cycle)
    identity()
    const state = await native.inspectRetained(managed.id, owner)
    await wait(
      async () =>
        (await native.inspectRetained(managed.id, owner)).queuedReplyBytes === 0,
      'reply-quiescence',
    )
    cycles.push({
      cycle,
      canvases: await canvasCount(),
      queuedReplyBytes: state.queuedReplyBytes,
      serial: state.geometry.serial,
      directLayoutWidths: { before: widthBefore, after: widthAfter },
    })
  }
  win.setContentSize(bounds.width, bounds.height)
  identity()
  return {
    cycles,
    hiddenInputRefusals,
    samePty: true,
    sameNativeState: true,
    hiddenOutput: true,
    realSessionsHandoff: true,
    realHostQualified: false,
  }
}
