import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { clipboard, webContents, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { NativeTerminalSelectionRefused } from '../../shared/native-terminal-selection'
import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import { terminalProbeSourceDelivery } from './terminal-probe-source'
import { closeWebPaneSmokeServer } from './web-pane-boundary'

const PREFIX = '__HVIR_NATIVE_SELECTION_'
export const NATIVE_SELECTION_RETENTION_MARKER = 'HVIR_M9_RETENTION_EPOCH'
export const NATIVE_READONLY_SELECTION = 'HVIR_READONLY_SELECTION'
const LARGE_ROWS = 4096
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** Synthetic goldens come from the fixture, never from observed selected text. */
export function nativeSelectionFixture(columns: number) {
  const word = 'alpha beta',
    unicode = '  A界e\u0301B  ',
    wrap = 'w'.repeat(columns) + 'tail'
  const plain = './package.json',
    external = 'https://example.com/native-selection'
  return { word, unicode, wrap, plain, external }
}
export function nativeSelectionLargeRow(columns: number, row: number): string {
  const prefix = 'L' + String(row).padStart(4, '0') + ':'
  return prefix + 'x'.repeat(columns - prefix.length)
}
export function nativeSelectionLargeExpected(columns: number) {
  const hash = createHash('sha256')
  let bytes = 0
  for (let row = 0; row < LARGE_ROWS; row++) {
    const text =
      nativeSelectionLargeRow(columns, row) + (row + 1 === LARGE_ROWS ? '' : '\n')
    hash.update(text)
    bytes += Buffer.byteLength(text)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** One raw recorder in the already-owned Shell PTY. Only fixed protocol markers are observed. */
export function nativeSelectionRecorderSource(
  columns: number,
  rows: number,
  fileUri: string,
  loopback: string,
): string {
  const fixture = nativeSelectionFixture(columns)
  return `
const prefix=${JSON.stringify(PREFIX)}, fixture=${JSON.stringify(fixture)}, columns=${columns}, rows=${rows}, fileUri=${JSON.stringify(fileUri)}, loopback=${JSON.stringify(loopback)};
let command=null, waiting=false, query='', phase='', producing=false, produced=0, producerTimer, producerDeadline, largeRow=0, closed=false;
const marker=text=>process.stdout.write('\\x1b]0;'+prefix+text+'__\\x07');
const stopProducer=()=>{producing=false;clearTimeout(producerTimer);clearTimeout(producerDeadline);process.stdout.off('drain',produce);};
const stop=code=>{if(closed)return;closed=true;stopProducer();clearTimeout(deadline);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l',()=>process.exit(code));};
const fail=reason=>{marker('FAILED_'+reason);stop(2);};
const row=(n,text)=>'\\x1b['+(n+1)+';1H'+text;
const setup=()=>{process.stdout.write('\\x1b[?1049h\\x1b[?25l\\x1b[?1000l\\x1b[?1006l\\x1b[?1004l\\x1b[?2004l\\x1b[2J'+row(4,'\\x1b[48;2;0;0;255;97m'+fixture.word+'\\x1b[0m')+row(6,fixture.unicode)+row(8,fixture.wrap)+row(11,'\\x1b]8;;'+fileUri+'\\x1b\\\\OSC8-file\\x1b]8;;\\x1b\\\\')+row(13,fixture.plain)+row(15,loopback)+row(17,fixture.external));};
function produce(){if(!producing||closed)return;if(produced>=262144)return fail('continuous-cap');const ready=produced>=65536&&phase==='continuous-warmup';if(ready){phase='continuous';marker('CONTINUOUS_TRIGGER_'+produced);}let body=('\\x1b7'+row(rows-2,'\\r\\x1b[2Kunrelated-output')+'\\x1b8').repeat(16);produced+=Buffer.byteLength(body);if(process.stdout.write(body)===false)process.stdout.once('drain',produce);else producerTimer=setTimeout(produce,0);}
function large(){while(largeRow<${LARGE_ROWS}){const n=largeRow++,head='L'+String(n).padStart(4,'0')+':',body=head+'x'.repeat(columns-head.length)+(largeRow===${LARGE_ROWS}?'':'\\r\\n');if(!process.stdout.write(body)){process.stdout.once('drain',large);return;}}waiting=true;query='';process.stdout.write('\\x1b[5n');}
const start=name=>{stopProducer();phase=name;if(name==='quit'){marker('CLOSED');stop(0);return;}if(name==='grid'||name==='continuous-warmup'){setup();waiting=true;query='';process.stdout.write('\\x1b[5n');return;}if(name==='primary'){process.stdout.write('\\x1b[?1049l');waiting=true;query='';process.stdout.write('\\x1b[5n');return;}if(name==='large'){process.stdout.write('\\x1b[?1049l');largeRow=0;large();return;}fail('command');};
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',data=>{for(const byte of data){if(command!==null){if(byte===29){const name=command;command=null;start(name);}else command+=String.fromCharCode(byte);continue;}if(byte===29){command='';continue;}if(waiting){query+=String.fromCharCode(byte);if(query.length===4){if(query!=='\\x1b[0n')return fail('query');waiting=false;marker(phase.toUpperCase()+'_READY');if(phase==='continuous-warmup'){producing=true;producerDeadline=setTimeout(()=>fail('continuous-deadline'),2000);produce();}}continue;}if(byte===3&&phase==='continuous'){const active=producing;stopProducer();if(!active)return fail('continuous-inactive');marker('CONTINUOUS_INTERRUPTED_'+produced);continue;}if(byte===3&&phase==='large'){process.stdout.write('\\x1b[Hchanged');marker('LARGE_INTERRUPTED');continue;}if(byte===97&&phase==='large'){marker('LARGE_KEY');continue;}return fail('unexpected-input');}});
const deadline=setTimeout(()=>fail('deadline'),45000);marker('READY');
`
}

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

function paneScript(session: string): string {
  return `const panel=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===${JSON.stringify(session)}),pane=panel?.querySelector('.native-terminal-pane'),surface=pane?.querySelector('[id^="native-terminal-"]'),canvas=surface?.querySelector('canvas'),input=pane?.querySelector('textarea');if(!pane||!surface||!canvas||!input)throw new Error('native-selection-elements');const viewId=surface.id.slice('native-terminal-'.length);`
}
const clipboardInstall = (isolated: boolean) => `(() => {
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
  const layout = async () => {
    const geometry = (await native.inspectRetained(managed.id, owner)).geometry
    const bounds = (await win.webContents.executeJavaScript(
      `(()=>{${scope}const r=pane.getBoundingClientRect();return{x:r.x,y:r.y,viewId,width:r.width,height:r.height};})()`,
    )) as { x: number; y: number; viewId: string; width: number; height: number }
    if (Math.round(bounds.width * geometry.backingScale) !== geometry.width)
      throw new Error('native-selection-layout-not-current')
    return { geometry, bounds }
  }
  const mouse = (
    type: 'mouseDown' | 'mouseUp' | 'mouseMove',
    x: number,
    y: number,
    button: 'left' | 'right' = 'left',
    clickCount = 1,
    modifiers: ('control' | 'meta' | 'shift')[] = [],
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
  const ready = () =>
    wait(async () => {
      try {
        await win.webContents.executeJavaScript(
          `(async()=>{${scope}return window.hvir.invoke('native-terminal:selection',{viewId,action:'state'});})()`,
        )
        return true
      } catch (error) {
        if (/native-selection-(stale|unavailable|not-drawn)/.test(String(error)))
          return false
        throw error
      }
    }, 'drawn-current-screen')
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

/** Existing workbench, real Chromium gestures, mature native selection, and no user clipboard mutation. */
export async function verifyNativeTerminalSelection(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const browser = nativeSelectionBrowser(win, native, managed),
    { owner, wait } = browser
  const isolated =
    process.platform === 'linux' &&
    process.env['HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD'] === '1'
  let raw = '',
    failed = false,
    mainSamples = 0,
    mainMaxMs = 0,
    lastBeat = performance.now(),
    httpContacts = 0,
    readRequests = 0
  const markers = new Set<string>()
  let initialGrid: unknown
  let phase = 'setup'
  const stage = (name: string) => {
    phase = name
    console.log('[native-workbench] selection-' + name)
  }
  const heartbeat = setInterval(() => {
    const now = performance.now()
    mainSamples++
    mainMaxMs = Math.max(mainMaxMs, now - lastBeat)
    lastBeat = now
  }, 5)
  const stop = ptys.attach(managed.id, owner.id, {
    onData: (data) => {
      const text = raw + data
      for (const match of text.matchAll(/__HVIR_NATIVE_SELECTION_([A-Za-z0-9_-]+)__/g))
        markers.add(match[1]!)
      raw = text.slice(-4096)
      if (markers.size > 128 || [...markers].some((value) => value.startsWith('FAILED_')))
        failed = true
    },
    onExit: () => {
      failed = true
    },
  })
  const seen = (marker: string) => {
    if (failed) throw new Error('native-selection-recorder-failed')
    return markers.has(marker)
  }
  const write = (text: string) =>
    ptys.writeConfirmed(managed.id, owner.id, text, owner.generation)
  const command = async (name: string) => {
    raw = ''
    markers.clear()
    await write('\x1d' + name + '\x1d')
  }
  const originalRead = native.readSelection.bind(native),
    originalInput = native.input.bind(native),
    originalWrite = ptys.writeConfirmed.bind(ptys)
  let largeActive = false,
    copyPending = false,
    copyFinished = false,
    copyStale = false,
    inputWhilePending = false,
    writeWhilePending = false,
    userWrites = 0,
    largeMutation = 0
  let copyFailure: { code: number | null; stale: boolean } | undefined
  native.readSelection = (...args) => {
    const result = originalRead(...args)
    if (!largeActive) return result
    copyPending = true
    readRequests++
    browser.key('C', ['control'])
    return result
      .then(
        (value) => {
          copyFinished = true
          return value
        },
        (error) => {
          copyFailure = {
            code: error instanceof NativeTerminalSelectionRefused ? error.code : null,
            stale: error instanceof NativeTerminalSelectionRefused && error.stale,
          }
          copyStale = copyFailure.code === 6 && copyFailure.stale
          throw error
        },
      )
      .finally(() => {
        copyPending = false
      })
  }
  const pointerObservations: ReturnType<typeof nativeSelectionPointerObservation>[] = []
  native.input = (...args) =>
    originalInput(...args).then((value) => {
      if (args[2].kind === 'pointer' && phase.startsWith('link')) {
        pointerObservations.push(nativeSelectionPointerObservation(args[2], value, phase))
        if (pointerObservations.length > 32) pointerObservations.shift()
      }
      if (
        largeActive &&
        args[2].kind === 'key' &&
        !('refused' in value && value.refused)
      ) {
        inputWhilePending ||= copyPending
        largeMutation = value.requestedMutation
      }
      return value
    })
  ptys.writeConfirmed = (...args) =>
    originalWrite(...args).then(() => {
      if (largeActive && args[4] === 'user') {
        userWrites++
        writeWhilePending ||= copyPending
      }
    })
  const originalSelection = native.selection.bind(native),
    completedCommands = new Set<string>()
  native.selection = (...args) =>
    originalSelection(...args).then((value) => {
      if (args[0].action === 'clear' || args[0].action === 'reset')
        completedCommands.add(args[0].action)
      return value
    })
  const originalCapture = native.captureLink.bind(native),
    originalLinkRead = native.continueLink.bind(native)
  const links: { kind: string; hash: string; rootMatched: boolean }[] = []
  let captures = 0,
    continuations = 0
  const linkOutcomes: {
    phase: string
    step: string
    outcome: string
    pending?: boolean
    kind?: string
  }[] = []
  const linkOutcome = (
    step: string,
    outcome: string,
    pending?: boolean,
    kind?: string,
  ) => {
    linkOutcomes.push({ phase, step, outcome, pending, kind })
    if (linkOutcomes.length > 16) linkOutcomes.shift()
  }
  const observeLink = (
    link:
      | import('../../shared/native-terminal-link').NativeTerminalLinkActivation
      | undefined,
  ) => {
    if (link) {
      links.push({
        kind: link.kind,
        hash: digest(link.target),
        rootMatched:
          JSON.stringify(link.workspaceRoot) === JSON.stringify(managed.workspaceRoot),
      })
      if (links.length > 8) throw new Error('native-selection-link-observation-bound')
    }
  }
  native.captureLink = (...args) => {
    captures++
    return originalCapture(...args).then(
      (value) => {
        linkOutcome('capture', 'resolved', value.pending, value.link?.kind)
        observeLink(value.link)
        return value
      },
      (error) => {
        linkOutcome('capture', 'rejected')
        throw error
      },
    )
  }
  native.continueLink = (...args) => {
    continuations++
    return originalLinkRead(...args).then(
      (value) => {
        linkOutcome('read', 'resolved', undefined, value?.kind)
        observeLink(value)
        return value
      },
      (error) => {
        linkOutcome('read', 'rejected')
        throw error
      },
    )
  }
  const server = createServer((_request, response) => {
    httpContacts++
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(
      '<!doctype html><title>native-selection-web</title><body>HVIR_NATIVE_SELECTION_WEB</body>',
    )
  })
  const summaries: { name: string; bytes: number; sha256: string }[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('native-selection-server-address')
    const loopback = `http://127.0.0.1:${address.port}/native-selection`
    const { geometry } = await browser.layout()
    if (geometry.columns < 40 || geometry.rows < 20) {
      initialGrid = {
        geometry,
        windowBounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        dom: (await win.webContents.executeJavaScript(
          nativeSelectionHitCensusScript(managed.id, 0, 0),
        )) as unknown,
      }
      console.log('HVIR_NATIVE_SELECTION_GRID ' + JSON.stringify(initialGrid))
      throw new Error('native-selection-fixture-grid')
    }
    const fileUri = pathToFileURL(managed.workspaceRoot.path + '/package.json').href,
      fixture = nativeSelectionFixture(geometry.columns)
    await win.webContents.executeJavaScript(clipboardInstall(isolated))
    await write("stty -echo; printf '%s%s\\n' '__HVIR_NATIVE_SELECTION_' 'ECHO_OFF__'\r")
    await wait(() => seen('ECHO_OFF'), 'echo-off')
    for (const { command: body, marker } of terminalProbeSourceDelivery(
      nativeSelectionRecorderSource(geometry.columns, geometry.rows, fileUri, loopback),
      'HVIR_SELECTION_B64',
      PREFIX + 'DELIVERY_',
    )) {
      await write(body)
      await wait(() => raw.includes(marker), 'source-delivery')
    }
    await write(
      `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_SELECTION_B64"; unset HVIR_SELECTION_B64; stty echo; printf '%s%s\\n' '__HVIR_NATIVE_SELECTION_' 'RETURNED__'\r`,
    )
    await wait(() => seen('READY'), 'recorder-ready')
    await command('grid')
    await wait(() => seen('GRID_READY'), 'grid-ready')
    await browser.ready()
    await browser.painted()
    stage('drag')
    await browser.drag(4.5, 0.25, 4.9)
    summaries.push({
      name: 'drag',
      ...(await browser.copied('alpha', () => browser.menu('Copy Selection'), isolated)),
    })
    stage('word')
    await browser.clicks(4.5, 1.5, 2)
    summaries.push({
      name: 'word',
      ...(await browser.copied(
        'alpha',
        async () => {
          await browser.focus()
          browser.key('C', ['meta'])
        },
        isolated,
      )),
    })
    stage('line')
    await browser.clicks(4.5, 1.5, 3)
    summaries.push({
      name: 'line',
      ...(await browser.copied(
        fixture.word,
        async () => {
          await browser.focus()
          browser.key('C', ['control', 'shift'])
        },
        isolated,
      )),
    })
    stage('unicode')
    await browser.drag(6.5, 0.25, 8.9)
    summaries.push({
      name: 'unicode-whitespace',
      ...(await browser.copied(
        fixture.unicode,
        () => browser.menu('Copy Selection'),
        isolated,
      )),
    })
    stage('all')
    await browser.menu('Select All')
    const whole = [
      fixture.word,
      fixture.unicode,
      fixture.wrap,
      'OSC8-file',
      fixture.plain,
      loopback,
      fixture.external,
    ].join('\n\n')
    summaries.push({
      name: 'all-softwrap',
      ...(await browser.copied(
        whole,
        async () => {
          await browser.focus()
          browser.key('C', ['control', 'shift'])
        },
        isolated,
      )),
    })
    stage('continuous')
    await command('continuous-warmup')
    await wait(
      () => [...markers].some((value) => /^CONTINUOUS_TRIGGER_[0-9]+$/.test(value)),
      'continuous-trigger',
    )
    await browser.ready()
    await browser.drag(4.5, 0.25, 4.9)
    summaries.push({
      name: 'continuous-drag',
      ...(await browser.copied(
        'alpha',
        async () => {
          await browser.focus()
          browser.key('C', ['control', 'shift'])
        },
        isolated,
      )),
    })
    await browser.focus()
    browser.key('C', ['control'])
    await wait(
      () => [...markers].some((value) => /^CONTINUOUS_INTERRUPTED_[0-9]+$/.test(value)),
      'continuous-interrupt',
    )
    const produced = Number(
      /^CONTINUOUS_INTERRUPTED_([0-9]+)$/.exec(
        [...markers].find((value) => value.startsWith('CONTINUOUS_INTERRUPTED_')) ?? '',
      )?.[1],
    )
    if (produced < 65536) throw new Error('native-selection-continuous-warmup')
    await command('grid')
    await wait(() => seen('GRID_READY'), 'links-grid')
    stage('link-external')
    await browser.ready()
    await browser.clicks(17.5, 2.5, 1, ['control'])
    await wait(async () => (await browser.proof()).opens.length === 1, 'external-link')
    const opened = (await browser.proof()).opens[0]!
    if (
      opened.target !== fixture.external ||
      opened.frame !== '_blank' ||
      opened.features !== 'noopener,noreferrer'
    )
      throw new Error('native-selection-external-intent')
    for (const [row, target] of [
      [11.5, fileUri],
      [13.5, fixture.plain],
    ] as const) {
      stage(row === 11.5 ? 'link-file' : 'link-plain')
      await browser.clicks(row, 2.5, 1, ['control'])
      await wait(
        () =>
          links.some(
            (link) =>
              link.kind === 'file' && link.hash === digest(target) && link.rootMatched,
          ),
        'file-intent',
      )
      await wait(
        async () =>
          win.webContents.executeJavaScript(
            `Boolean([...document.querySelectorAll('.viewer-tab:not(.web-pane-tab) .tab-name')].find(node=>node.textContent==='package.json'))`,
          ) as Promise<boolean>,
        'file-view',
      )
    }
    stage('link-loopback')
    await browser.clicks(15.5, 2.5, 1, ['control'])
    await wait(() => server.listening && httpContacts > 0, 'loopback-contact')
    let guestId = 0
    await wait(async () => {
      guestId = (await win.webContents.executeJavaScript(
        `(()=>{const guest=document.querySelector('webview.web-pane-frame');return guest?.getWebContentsId?.()??0;})()`,
      )) as number
      return guestId > 0
    }, 'loopback-guest')
    const guest = webContents.fromId(guestId)
    if (!guest || guest.hostWebContents !== win.webContents)
      throw new Error('native-selection-web-guest-owner')
    await wait(
      async () =>
        Boolean(
          await guest.executeJavaScript(
            `document.body?.textContent==='HVIR_NATIVE_SELECTION_WEB'&&typeof require==='undefined'&&typeof window.hvir==='undefined'`,
          ),
        ),
      'loopback-content',
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('.web-pane-tab .tab-close')?.click();true`,
    )
    await wait(
      async () =>
        !(await win.webContents.executeJavaScript(
          `Boolean(document.querySelector('.web-pane-tab'))`,
        )),
      'loopback-close',
    )
    stage('clear-epoch')
    await command('primary')
    await wait(() => seen('PRIMARY_READY'), 'primary-ready')
    await browser.ready()
    if (
      !new TextDecoder()
        .decode(await native.readRetained(managed.id, owner))
        .includes('HVIR_NATIVE_WORKBENCH_READY')
    )
      throw new Error('native-selection-original-ready-before-clear')
    await browser.menu('Clear Screen and Scrollback')
    await wait(() => completedCommands.has('clear'), 'clear-io-applied')
    if (new TextDecoder().decode(await native.readRetained(managed.id, owner)).trim())
      throw new Error('native-selection-clear-not-empty')
    stage('large-copy')
    await command('large')
    await wait(() => seen('LARGE_READY'), 'large-ready')
    await browser.menu('Select All')
    await browser.focus()
    const expected = nativeSelectionLargeExpected(geometry.columns),
      before = (await browser.proof()).writes.length
    largeActive = true
    browser.key('C', ['control', 'shift'])
    await wait(() => copyFinished || !!copyFailure, 'large-copy-outcome')
    if (copyFailure && !copyStale)
      throw new Error(
        'native-selection-large-copy-refused-' + String(copyFailure.code ?? 'unknown'),
      )
    await wait(() => seen('LARGE_INTERRUPTED'), 'large-control-recorder')
    if (
      userWrites !== 1 ||
      readRequests !== 1 ||
      (!copyStale && !inputWhilePending && !writeWhilePending)
    )
      throw new Error('native-selection-large-input-progress')
    if (copyFinished) {
      await wait(
        async () => (await browser.proof()).writes.length > before,
        'large-clipboard',
      )
      const actual = (await browser.proof()).writes.at(-1)
      if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
        throw new Error('native-selection-large-copy-exact')
    } else if ((await browser.proof()).writes.length !== before)
      throw new Error('native-selection-stale-copy-clipboard')
    largeActive = false
    browser.key('A')
    await wait(() => seen('LARGE_KEY'), 'key-after-copy')
    stage('reset')
    await browser.menu('Reset Terminal')
    await wait(() => completedCommands.has('reset'), 'reset-io-applied')
    if (new TextDecoder().decode(await native.readRetained(managed.id, owner)).trim())
      throw new Error('native-selection-reset-not-empty')
    await command('quit')
    await wait(() => seen('RETURNED'), 'recorder-returned')
    await write(`printf '%s%s\\n' 'HVIR_M9_' 'RETENTION_EPOCH'\r`)
    await wait(
      async () =>
        new TextDecoder()
          .decode(await native.readRetained(managed.id, owner))
          .includes(NATIVE_SELECTION_RETENTION_MARKER),
      'new-retention-marker',
    )
    const paint = await browser.proof()
    if (
      !paint.frames ||
      !mainSamples ||
      paint.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs ||
      mainMaxMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs
    )
      throw new Error('native-selection-paint-budget')
    const finalStatus = await native.inspectRetained(managed.id, owner)
    if (
      finalStatus.failure ||
      finalStatus.inputFailure ||
      native.sessions.get(managed.id)?.inputUnavailable ||
      ptys.get(managed.id)?.instanceId !== managed.instanceId ||
      ptys.list().length !== 1
    )
      throw new Error('native-selection-final-owner-or-input')
    return {
      fixtureColumns: geometry.columns,
      parserInputAlive: true,
      originalReadyBeforeClear: true,
      clearScreenScrollback: true,
      resetTerminal: true,
      samePty: true,
      drag: true,
      word: true,
      line: true,
      unicodeWhitespace: true,
      softwrap: true,
      selectAll: true,
      menu: true,
      metaCopy: true,
      controlShiftCopy: true,
      copies: summaries,
      continuous: { producedBytes: produced, copiedWhileActive: true },
      largeCopy: {
        fixtureBytes: expected.bytes,
        copyFinished,
        copyStale,
        refusalCode: copyFailure?.code ?? null,
        inputWhilePending,
        writeWhilePending,
        userWrites,
        mutation: largeMutation,
      },
      fileUriAndPlainIntent: true,
      linkIntents: links.length,
      linkRootsMatched: links.every((link) => link.rootMatched),
      loopbackRouteContent: true,
      externalOpenerObserved: true,
      linkMenuDismissals: browser.menuDismissals.filter((value) => value.visible).length,
      linkNativeHits: browser.menuDismissals.every(
        (value) => value.dismissed && value.nativeHit,
      ),
      osExternalOpenerInvoked: false,
      isolatedOsClipboardReadback: isolated,
      clipboardIntercepted: !isolated,
      mainSamples,
      mainMaxMs,
      rendererSamples: paint.frames,
      rendererMaxMs: paint.maxGapMs,
      retentionEpoch: NATIVE_SELECTION_RETENTION_MARKER,
      hardwareGpuQualified: false,
    }
  } catch (error) {
    let status:
      Awaited<ReturnType<NativeTerminalApplication['inspectRetained']>> | undefined
    try {
      status = await native.inspectRetained(managed.id, owner)
    } catch {
      /* Keep the initiating failure. */
    }
    let openerObservation: { count: number; hashes: string[] } | undefined
    try {
      const proof = await browser.proof()
      openerObservation = {
        count: proof.opens.length,
        hashes: proof.opens.slice(-8).map((value) => digest(value.target)),
      }
    } catch {
      /* Preserve the original operation failure. */
    }
    let failureHitCensus: unknown
    try {
      failureHitCensus = await browser.hitCensus()
    } catch {
      /* Keep the original failure. */
    }
    console.log(
      'HVIR_NATIVE_SELECTION_FAILURE ' +
        JSON.stringify({
          phase,
          recorderFailed: failed,
          initialGrid,
          clicked: phase === 'link-external' ? { row: 17.5, column: 2.5 } : undefined,
          menuDismissals: browser.menuDismissals,
          hitObservations: browser.hitObservations,
          failureHitCensus,
          pointerObservations,
          completedCommands: [...completedCommands],
          captures,
          continuations,
          linkOutcomes,
          links,
          openerObservation,
          copyFailure,
          statusAvailable: !!status,
          ...(status
            ? {
                failure: status.failure,
                inputFailure: status.inputFailure,
                closing: status.closing,
                geometrySerial: status.geometry.serial,
                geometry: status.geometry,
                appliedSequence: status.appliedSequence,
                ioAppliedSequence: status.ioAppliedSequence,
              }
            : {}),
        }),
    )
    throw error
  } finally {
    native.selection = originalSelection
    native.captureLink = originalCapture
    native.continueLink = originalLinkRead
    native.readSelection = originalRead
    native.input = originalInput
    ptys.writeConfirmed = originalWrite
    clearInterval(heartbeat)
    await stop()
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      await win.webContents
        .executeJavaScript(
          `window.nativeSelectionProbe?.restore();document.querySelector('.web-pane-tab .tab-close')?.click();true`,
        )
        .catch(() => undefined)
    if (isolated) clipboard.clear()
    await closeWebPaneSmokeServer(server)
  }
}

/** Native retained state remains selectable after the physical PTY has gone. */
export async function verifyNativeReadonlySelection(
  win: BrowserWindow,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  console.log('[native-workbench] selection-readonly')
  const browser = nativeSelectionBrowser(win, native, managed),
    isolated =
      process.platform === 'linux' &&
      process.env['HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD'] === '1'
  await win.webContents.executeJavaScript(clipboardInstall(isolated))
  try {
    const record = native.sessions.get(managed.id)
    if (!record?.readonly || record.session.instanceId !== managed.instanceId)
      throw new Error('native-selection-readonly-instance')
    const before = (await native.inspectRetained(managed.id, browser.owner))
      .ioAppliedMutation
    await win.webContents.executeJavaScript(
      `(()=>{${paneScript(managed.id)}const r=canvas.getBoundingClientRect();canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.x+8,clientY:r.y+8,deltaY:32768}));return true;})()`,
    )
    await browser.wait(
      async () =>
        (await native.inspectRetained(managed.id, browser.owner)).ioAppliedMutation >
        before,
      'readonly-bottom',
    )
    await browser.ready()
    await browser.drag(0.5, 0.25, NATIVE_READONLY_SELECTION.length - 0.1)
    const copied = await browser.copied(
      NATIVE_READONLY_SELECTION,
      () => browser.menu('Copy Selection'),
      isolated,
    )
    await browser.wait(
      async () => (await browser.proof()).frames >= 2,
      'readonly-paint-samples',
    )
    const paint = await browser.proof()
    if (paint.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs)
      throw new Error('native-selection-readonly-paint-budget')
    return {
      rendererSamples: paint.frames,
      rendererMaxMs: paint.maxGapMs,
      readonlyDrag: true,
      readonlyCopy: true,
      bytes: copied.bytes,
      sha256: copied.sha256,
      isolatedOsClipboardReadback: isolated,
    }
  } finally {
    await win.webContents
      .executeJavaScript('window.nativeSelectionProbe?.restore();true')
      .catch(() => undefined)
    if (isolated) clipboard.clear()
  }
}
