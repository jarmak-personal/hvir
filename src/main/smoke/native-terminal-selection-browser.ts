import { createHash } from 'node:crypto'
import { clipboard, type BrowserWindow } from 'electron'
import type { ManagedPty } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Closed synthetic-gesture diagnostics; never includes text, URI or host paths. */
export function nativeSelectionPointerObservation(
  input: Extract<
    import('../../shared/native-terminal-input').NativeTerminalInputOperation,
    { kind: 'pointer' }
  >,
  result: import('../../shared/native-terminal-input').NativeTerminalInputCompletion,
  phase: string,
) {
  return {
    phase,
    x: input.x,
    y: input.y,
    button: input.button,
    action: input.action,
    modifiers: input.modifiers,
    captured: result.captured,
    selectionResult: result.selectionResult,
    linkCandidate: result.linkCandidate,
  }
}

export function nativeSelectionHitCensusScript(
  session: string,
  x: number,
  y: number,
): string {
  return `(()=>{const panel=[...document.querySelectorAll('.terminal-surface')].find(n=>n.getAttribute('data-terminal-session')===${JSON.stringify(session)}),pane=panel?.querySelector('.native-terminal-pane');
const describe=n=>({tag:n?.tagName??null,role:n?.getAttribute('role')?.slice(0,32)??null,classes:typeof n?.className==='string'?n.className.slice(0,128):null});
const bounds=n=>{if(!n)return null;const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};};
const menus=[...document.querySelectorAll('.terminal-context-menu')],canvas=pane?.querySelector('canvas');return{viewport:{width:globalThis.innerWidth??null,height:globalThis.innerHeight??null,dpr:globalThis.devicePixelRatio??null},paneBounds:bounds(pane),canvasBounds:bounds(canvas),canvasBacking:canvas?{width:canvas.width,height:canvas.height}:null,point:{x:${x},y:${y}},menus:menus.length,menuBounds:menus.slice(0,4).map(bounds),hits:document.elementsFromPoint(${x},${y}).slice(0,8).map(describe),active:describe(document.activeElement),pane:!!pane,readonly:pane?.getAttribute('aria-readonly')==='true',canvas:!!pane?.querySelector('canvas'),nativeHit:!!pane&&pane.contains(document.elementsFromPoint(${x},${y})[0]),statusCount:pane?.querySelectorAll('[role="status"]').length??0,hidden:panel?.hidden??null};})()`
}

export function paneScript(session: string, readiness = false): string {
  return `const panel=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===${JSON.stringify(session)}),pane=panel?.querySelector('.native-terminal-pane'),surface=pane?.querySelector('[id^="native-terminal-"]'),canvas=surface?.querySelector('canvas'),input=pane?.querySelector('textarea');${readiness ? 'if(!pane?.isConnected||!surface?.isConnected||!canvas?.isConnected||!input?.isConnected)return undefined;' : "if(!pane||!surface||!canvas||!input)throw new Error('native-selection-elements');"}const viewId=surface.id.slice('native-terminal-'.length);`
}
export function nativeSelectionReadinessScript(session: string): string {
  return `(async()=>{${paneScript(session, true)}try{await window.hvir.invoke('native-terminal:selection',{viewId,action:'state'});return true;}catch(error){if(/native-selection-(source-stale|stale|unavailable|not-drawn)/.test(String(error)))return false;throw error;}})()`
}
export const clipboardInstall = (isolated: boolean) => `(() => {
 const clipboard=navigator.clipboard;if(!clipboard?.writeText)throw new Error('native-selection-clipboard-unavailable');
 const descriptor=Object.getOwnPropertyDescriptor(clipboard,'writeText'),write=clipboard.writeText.bind(clipboard),open=window.open;
 const probe={writes:[],opens:[],active:true,frames:0,last:performance.now(),maxGapMs:0};
 Object.defineProperty(clipboard,'writeText',{configurable:true,value:async text=>{const bytes=new TextEncoder().encode(text),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');if(${isolated})await write(text);probe.writes.push({bytes:bytes.length,sha256:hash});if(probe.writes.length>64)throw new Error('native-selection-clipboard-observation-bound');}});
 window.open=(target,frame,features)=>{probe.opens.push({target:String(target),frame,features});return null;};
 const tick=now=>{if(!probe.active)return;probe.frames++;probe.maxGapMs=Math.max(probe.maxGapMs,now-probe.last);probe.last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
 probe.restore=()=>{probe.active=false;window.open=open;if(descriptor)Object.defineProperty(clipboard,'writeText',descriptor);else delete clipboard.writeText;delete window.nativeSelectionProbe;};window.nativeSelectionProbe=probe;return true;
})()`
interface ClipboardProof {
  writes: { bytes: number; sha256: string }[]
  opens: { target: string; frame: string; features: string }[]
  frames: number
  maxGapMs: number
}

export function nativeSelectionBrowser(
  win: BrowserWindow,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration },
    scope = paneScript(managed.id)
  const wait = async (check: () => boolean | Promise<boolean>, phase: string) => {
    const deadline = Date.now() + 15000
    do {
      if (await check()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error('native-selection-' + phase + '-timeout')
  }
  const readLayout = async (readiness: boolean) => {
    const geometry = (await native.inspectRetained(managed.id, owner)).geometry
    const bounds = (await win.webContents.executeJavaScript(
      `(()=>{${paneScript(managed.id, readiness)}const r=pane.getBoundingClientRect(),c=canvas.getBoundingClientRect();return{x:r.x,y:r.y,viewId,width:r.width,height:r.height,canvasWidth:canvas.width,canvasHeight:canvas.height,canvasCssWidth:c.width,canvasCssHeight:c.height,dpr:devicePixelRatio};})()`,
    )) as
      | {
          x: number
          y: number
          viewId: string
          width: number
          height: number
          canvasWidth: number
          canvasHeight: number
          canvasCssWidth: number
          canvasCssHeight: number
          dpr: number
        }
      | undefined
    if (!bounds) return undefined
    if (Math.round(bounds.width * geometry.backingScale) !== geometry.width)
      if (readiness) return undefined
      else throw new Error('native-selection-layout-not-current')
    return { geometry, bounds }
  }
  const layout = async () => {
    const value = await readLayout(false)
    if (!value) throw new Error('native-selection-elements')
    return value
  }
  const mouse = (
    type: 'mouseDown' | 'mouseUp' | 'mouseMove',
    x: number,
    y: number,
    button: 'left' | 'right' = 'left',
    clickCount = 1,
    modifiers: ('control' | 'meta' | 'shift' | 'leftbuttondown')[] = [],
  ) =>
    win.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount,
      modifiers,
    })
  const point = async (column: number, row: number) => {
    const { geometry: g, bounds: b } = await layout()
    return {
      x: b.x + (g.paddingLeft + g.cellWidth * column) / g.backingScale,
      y: b.y + (g.paddingTop + g.cellHeight * row) / g.backingScale,
    }
  }
  const clear = async (): Promise<unknown> =>
    win.webContents.executeJavaScript(
      `(async()=>{${scope}return window.hvir.invoke('native-terminal:selection',{viewId,action:'selection-clear'});})()`,
    )
  const drawn = async () =>
    (await win.webContents.executeJavaScript(
      nativeSelectionReadinessScript(managed.id),
    )) === true
  const ready = () => wait(drawn, 'drawn-current-screen')
  const accommodateGrid = async (current: () => boolean) => {
    const before = await layout(),
      handle = native.sessions.get(managed.id)?.handle
    if (before.geometry.rows >= 20)
      return { action: false, before: before.geometry, after: before.geometry }
    if (!handle || !current()) throw new Error('native-selection-resize-owner')
    const start = (await win.webContents.executeJavaScript(
      `(()=>{const separator=document.querySelector('[role="separator"][aria-label="Resize terminal"]');if(!separator)throw new Error('native-selection-resizer-missing');const r=separator.getBoundingClientRect(),x=Math.round(r.x+Math.min(24,r.width/4)),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!hit||!separator.contains(hit)||hit.closest('[data-resizer-action]'))throw new Error('native-selection-resizer-hit');return{x,y};})()`,
    )) as { x: number; y: number }
    const end = {
      x: start.x,
      y:
        start.y -
        Math.ceil(
          ((21 - before.geometry.rows) * before.geometry.cellHeight) /
            before.geometry.backingScale,
        ),
    }
    console.log(
      'HVIR_NATIVE_SELECTION_RESIZE ' +
        JSON.stringify({ before: before.geometry, start, end }),
    )
    mouse('mouseMove', start.x, start.y)
    mouse('mouseDown', start.x, start.y)
    mouse('mouseMove', end.x, end.y)
    mouse('mouseUp', end.x, end.y)
    let accepted: typeof before | undefined
    await wait(async () => {
      if (!current() || native.sessions.get(managed.id)?.handle !== handle)
        throw new Error('native-selection-resize-owner')
      const a = await readLayout(true)
      if (
        !a ||
        a.geometry.serial <= before.geometry.serial ||
        a.geometry.rows < 20 ||
        !(await drawn())
      )
        return false
      const b = await readLayout(true)
      if (!b) return false
      const g = b.geometry,
        bounds = b.bounds
      if (
        a.geometry.serial !== g.serial ||
        a.geometry.width !== g.width ||
        a.geometry.height !== g.height ||
        g.columns !== before.geometry.columns ||
        Math.fround(bounds.dpr) !== g.backingScale ||
        Math.round(bounds.height * bounds.dpr) !== g.height ||
        Math.round(bounds.canvasCssWidth * bounds.dpr) !== g.width ||
        Math.round(bounds.canvasCssHeight * bounds.dpr) !== g.height ||
        bounds.canvasWidth !== g.width ||
        bounds.canvasHeight !== g.height
      )
        return false
      accepted = b
      return true
    }, 'resizer-applied-draw')
    if (!accepted) throw new Error('native-selection-resize-observation')
    return {
      action: true,
      before: before.geometry,
      after: accepted.geometry,
      start,
      end,
      sameNativeState: true,
      currentDraw: true,
    }
  }
  const painted = () =>
    wait(async () => {
      const { geometry: g, bounds: b } = await layout()
      const image = await win.webContents.capturePage({
        x: Math.ceil(b.x + g.paddingLeft / g.backingScale),
        y: Math.ceil(b.y + (g.paddingTop + 4 * g.cellHeight) / g.backingScale),
        width: Math.max(1, Math.floor((10 * g.cellWidth) / g.backingScale)),
        height: Math.max(1, Math.floor(g.cellHeight / g.backingScale)),
      })
      const bytes = image.toBitmap()
      let blue = 0
      for (let offset = 0; offset < bytes.length; offset += 4)
        if (
          bytes[offset]! > 120 &&
          bytes[offset]! > bytes[offset + 1]! * 1.4 &&
          bytes[offset]! > bytes[offset + 2]! * 1.4
        )
          blue++
      return blue >= 50
    }, 'fixture-pixels')
  const drag = async (row: number, start: number, end: number) => {
    await clear()
    const a = await point(start, row),
      b = await point(end, row)
    mouse('mouseMove', a.x, a.y)
    mouse('mouseDown', a.x, a.y)
    mouse('mouseMove', b.x, b.y)
    mouse('mouseUp', b.x, b.y)
  }
  const hitObservations: unknown[] = []
  let intendedPoint: { x: number; y: number; row: number; column: number } | undefined
  const hitCensus = (): Promise<unknown> | undefined =>
    intendedPoint &&
    win.webContents.executeJavaScript(
      nativeSelectionHitCensusScript(managed.id, intendedPoint.x, intendedPoint.y),
    )
  const menuDismissals: { visible: boolean; dismissed: boolean; nativeHit: boolean }[] =
    []
  const prepareLink = async () => {
    const before = (await hitCensus()) as { menus: number; nativeHit: boolean }
    if (before.menus) {
      key('Escape')
      await wait(
        async () => !((await hitCensus()) as { menus: number }).menus,
        'link-menu-dismiss',
      )
    }
    const after = (await hitCensus()) as { menus: number; nativeHit: boolean }
    menuDismissals.push({
      visible: before.menus > 0,
      dismissed: after.menus === 0,
      nativeHit: after.nativeHit,
    })
    if (menuDismissals.length > 8) menuDismissals.shift()
    if (!after.nativeHit) throw new Error('native-selection-link-hit-not-native')
  }
  const clicks = async (
    row: number,
    column: number,
    count: number,
    modifiers: ('control' | 'meta' | 'shift')[] = [],
  ) => {
    await clear()
    const p = await point(column, row)
    if (modifiers.length) {
      intendedPoint = { ...p, row, column }
      await prepareLink()
      hitObservations.push({ intendedPoint, census: await hitCensus() })
      if (hitObservations.length > 8) hitObservations.shift()
    }
    for (let n = 1; n <= count; n++) {
      mouse('mouseDown', p.x, p.y, 'left', n, modifiers)
      mouse('mouseUp', p.x, p.y, 'left', n, modifiers)
    }
  }
  const key = (keyCode: string, modifiers: ('control' | 'meta' | 'shift')[] = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  const focus = () =>
    win.webContents.executeJavaScript(
      `(()=>{${scope}input.focus({preventScroll:true});return document.activeElement===input;})()`,
    )
  const proof = () =>
    win.webContents.executeJavaScript(
      `(()=>{const p=window.nativeSelectionProbe;return{writes:p.writes,opens:p.opens,frames:p.frames,maxGapMs:p.maxGapMs};})()`,
    ) as Promise<ClipboardProof>
  const menu = async (label: string) => {
    const p = await point(2.5, 4.5)
    mouse('mouseDown', p.x, p.y, 'right')
    mouse('mouseUp', p.x, p.y, 'right')
    let bounds: { x: number; y: number } | undefined
    await wait(async () => {
      bounds = (await win.webContents.executeJavaScript(
        `(()=>{const button=[...document.querySelectorAll('.terminal-context-menu [role="menuitem"]')].find(node=>node.textContent?.startsWith(${JSON.stringify(label)}));if(!button||button.disabled)return;const r=button.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      )) as { x: number; y: number } | undefined
      return !!bounds
    }, 'menu-' + label)
    mouse('mouseDown', bounds!.x, bounds!.y)
    mouse('mouseUp', bounds!.x, bounds!.y)
  }
  const copied = async (
    expected: string,
    action: () => Promise<unknown> | void,
    isolated: boolean,
  ) => {
    const before = (await proof()).writes.length
    await action()
    await wait(async () => {
      const entries = (await proof()).writes
      if (entries.length === before) return false
      const actual = entries.at(-1)!
      if (
        entries.length !== before + 1 ||
        actual.bytes !== Buffer.byteLength(expected) ||
        actual.sha256 !== digest(expected)
      )
        throw new Error('native-selection-clipboard-exact')
      return true
    }, 'clipboard')
    if (isolated) {
      await wait(() => digest(clipboard.readText()) === digest(expected), 'os-clipboard')
    }
    return { bytes: Buffer.byteLength(expected), sha256: digest(expected) }
  }
  return {
    owner,
    wait,
    layout,
    accommodateGrid,
    mouse,
    point,
    clear,
    drag,
    clicks,
    key,
    focus,
    proof,
    menu,
    copied,
    ready,
    painted,
    hitObservations,
    menuDismissals,
    hitCensus,
  }
}
