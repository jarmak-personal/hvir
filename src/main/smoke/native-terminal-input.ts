import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { NativeTerminalGeometry } from '../../shared/native-terminal'
import type { NativeTerminalInputCompletion } from '../../shared/native-terminal-input'
import { terminalProbeSourceDelivery } from './terminal-probe-source'

const PREFIX = '__HVIR_NATIVE_INPUT_'
const PASTE_TEXT = 'é🙂\r\n日本\x00\x03\x1b\x7f\tZ'
const RESET =
  '\x1b[?1l\x1b[20l\x1b[>4;0m\x1b[<u\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l'
/** ECMA/Kitty byte fixtures also exercised at the native encoder owner. */
const phases = {
  enter: { mode: '', bytes: '\r' },
  control: { mode: '', bytes: '\x03' },
  continuous: { mode: '', bytes: '\x03' },
  concurrent: { mode: '', bytes: '\x1b[0n\x03' },
  arrow: { mode: '', bytes: '\x1b[A' },
  application: { mode: '\x1b[?1h', bytes: '\x1bOA' },
  alt: { mode: '', bytes: '\x1b[1;3A' },
  meta: { mode: '', bytes: '\x1b[1;9A' },
  kitty: { mode: '\x1b[>3u', bytes: '\x1b[1;1:1A\x1b[1;1:2A\x1b[1;1:3A' },
  mok: { mode: '\x1b[>4;2m', bytes: '\x1b[27;6;13~' },
  lnm: { mode: '\x1b[20h', bytes: '\r\n' },
  paste: { mode: '\x1b[?2004h', bytes: '\x1b[200~é🙂\r\n日本    \tZ\x1b[201~' },
  composition: { mode: '', bytes: '日本x' },
  mouse: {
    mode: '\x1b[?1002h\x1b[?1006h',
    bytes: '\x1b[<0;2;2M\x1b[<32;3;2M\x1b[<0;3;2m',
  },
  wheel: { mode: '\x1b[?1000h\x1b[?1006h', bytes: '\x1b[<65;2;2M' },
  focus: { mode: '\x1b[?1004h', bytes: '\x1b[O\x1b[I' },
} as const
export type NativeInputProbePhase = keyof typeof phases

/** Private same-PTY recorder. Stream hashing retains no terminal/input transcript. */
export function nativeTerminalInputProbeSource(): string {
  const config = Object.fromEntries(
    Object.entries(phases).map(([name, phase]) => [
      name,
      {
        mode: phase.mode,
        queryPrefix: name === 'focus' ? '\x1b[I' : '',
        length: Buffer.byteLength(phase.bytes),
        hash: createHash('sha256').update(phase.bytes).digest('hex'),
      },
    ]),
  )
  return `
const {createHash}=require('node:crypto');
const phases=${JSON.stringify(config)}, reset=${JSON.stringify(RESET)}, prefix=${JSON.stringify(PREFIX)};
let phase, name, hash, count=0, control=null, handshake=Buffer.alloc(0), waiting=false, closed=false, producing=false, produced=0, producerTimer, producerDeadline, producerTriggered=false, warmupBody=0;
const marker=value=>process.stdout.write(prefix+value+'__\\r\\n');
const stopProducer=()=>{producing=false;clearTimeout(producerTimer);clearTimeout(producerDeadline);process.stdout.off('drain',produce);};
function produce(){if(!producing||closed)return;const trigger=!producerTriggered&&produced>=65536;if(trigger){warmupBody=produced;producerTriggered=true;marker('continuous_WARMUP_'+warmupBody);}const body=(trigger?prefix+'continuous_TRIGGER__\\r\\n':'')+('\\r\\x1b[2Knative-continuous-output\\r').repeat(16);const size=Buffer.byteLength(body);if(size>256*1024-produced)return fail('continuous-cap');produced+=size;if(process.stdout.write(body)===false)process.stdout.once('drain',produce);else producerTimer=setTimeout(produce,0);}
const stop=code=>{if(closed)return;closed=true;stopProducer();clearTimeout(timer);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write(reset,()=>process.exit(code));};
const fail=(reason='protocol')=>{marker('FAILED_'+(name||'none')+'_'+reason);stop(2);};
const timer=setTimeout(()=>fail('deadline'),45000);
const command=value=>{
 if(value==='quit'){for(let i=0;i<180;i++)process.stdout.write('\\x1b['+(41+i%6)+'m native readonly row '+i+' \\x1b[0m\\r\\n');marker('CLOSED');return stop(0);}
 if(value==='observe'){if(!phase||waiting)return fail();marker(name+'_OBSERVED');return;}
 if(value==='end'){
  if(!phase||waiting)return fail();
  const actual=hash.digest('hex');
  if(count!==phase.length)return fail('count');if(actual!==phase.hash)return fail('digest');
  marker(name+'_OK');phase=undefined;return;
 }
 const next=phases[value];if(!next||phase)return fail('command');
 phase=next;name=value;hash=createHash('sha256');count=0;handshake=Buffer.alloc(0);waiting=true;
 if(name==='concurrent'){waiting=false;process.stdout.write(reset+phase.mode+'\\x1b[5n'+prefix+'concurrent_QUERY__\\r\\n');}
 else process.stdout.write(reset+phase.mode+'\\x1b[5n');
};
const data=bytes=>{
 if(!phase)return bytes.length?fail('unassigned'):undefined;
 if(waiting){
  handshake=Buffer.concat([handshake,bytes]);const reply=Buffer.from(phase.queryPrefix+'\\x1b[0n');
  if(!handshake.subarray(0,Math.min(handshake.length,reply.length)).equals(reply.subarray(0,Math.min(handshake.length,reply.length))))return fail(handshake.subarray(0,3).equals(Buffer.from('\\x1b[I'))?'query-focus-in':handshake.subarray(0,3).equals(Buffer.from('\\x1b[O'))?'query-focus-out':'query-prefix');
  if(handshake.length<reply.length)return;
  bytes=handshake.subarray(reply.length);handshake=Buffer.alloc(0);waiting=false;marker(name+'_READY');if(name==='continuous'){producing=true;produced=0;producerTriggered=false;warmupBody=0;producerDeadline=setTimeout(()=>fail('continuous-deadline'),2000);produce();}
 }
 count+=bytes.length;if(count>phase.length)return fail('excess');hash.update(bytes);if(name==='continuous'&&bytes.length){if(!producing||!producerTriggered)return fail('continuous-inactive');const total=produced;stopProducer();marker('continuous_INTERRUPTED_'+total);}
};
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',bytes=>{
 let start=0;for(let i=0;i<bytes.length&&!closed;i++){
  if(control!==null){if(bytes[i]===29){const value=control;control=null;command(value);}else{control+=String.fromCharCode(bytes[i]);if(control.length>32)return fail();}start=i+1;}
  else if(bytes[i]===29){data(bytes.subarray(start,i));control='';start=i+1;}
 }
 if(!closed&&control===null&&start<bytes.length)data(bytes.subarray(start));
});
marker('RECORDER_READY');
`
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  phase: string,
): Promise<void> {
  const deadline = Date.now() + 15000
  do {
    if (await check()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error(`native-input-${phase}-timeout`)
}
const focusScript = `(() => { const text=document.querySelector('.native-terminal-pane textarea'); if (!(text instanceof HTMLTextAreaElement)) throw new Error('native textarea missing'); text.focus({preventScroll:true}); return document.activeElement===text; })()`

/** Real Chromium events -> existing pane/IPC/native parser -> same supervisor PTY. */
export async function verifyNativeTerminalInput(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
): Promise<{
  phases: number
  mutationFences: number
  programmaticComposition: true
  programmaticPaste: true
  largeAdmissionQualified: false
  osImeQualified: false
  ordinaryPasteQualified: false
  continuousControl: {
    sourceAdmittedTrigger: true
    producerActiveAtInterrupt: true
    producedBytes: number
    warmupBodyBytes: number
    parsedNativeFeedDelta: number
    triggerToCaptureMs: number
    triggerToCompletionMs: number
    sourceBytesAtCapture: number
    sourceBytesAfterCaptureIncludingControlMarkers: number
    userWrites: 1
    osSigintQualified: false
    physicalOverlapQualified: false
  }
  concurrentQuery: {
    sourceAdmittedTrigger: true
    replyBeforeUserKey: true
    userWrites: 1
    physicalOverlapQualified: false
  }
}> {
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const read = async () => {
    let bytes: Uint8Array
    try {
      bytes = await native.readRetained(managed.id, owner)
    } catch (error) {
      let status:
        Awaited<ReturnType<NativeTerminalApplication['inspectRetained']>> | undefined
      try {
        status = await native.inspectRetained(managed.id, owner)
      } catch {
        /* Preserve the original failed observation. */
      }
      console.log(
        'HVIR_NATIVE_INPUT_OBSERVATION_FAILURE ' +
          JSON.stringify({
            kind: 'read',
            phase: phaseName ?? 'setup',
            statusAvailable: !!status,
            ...(status
              ? {
                  failure: status.failure,
                  inputFailure: status.inputFailure,
                  appliedSequence: status.appliedSequence,
                  ioAppliedSequence: status.ioAppliedSequence,
                  ioAppliedMutation: status.ioAppliedMutation,
                  closing: status.closing,
                }
              : {}),
          }),
      )
      throw new Error('native-input-read-observation-failed', { cause: error })
    }
    const text = new TextDecoder().decode(bytes)
    const failure = text.match(/__HVIR_NATIVE_INPUT_FAILED_([a-z]+)_([a-z-]+)__/)
    if (failure) throw new Error(`native-input-recorder-${failure[1]}-${failure[2]}`)
    return text
  }
  const write = (body: string) =>
    ptys.writeConfirmed(managed.id, owner.id, body, owner.generation)
  const observed: Array<{ kind: string } & NativeTerminalInputCompletion> = []
  const original: NativeTerminalApplication['input'] = native.input.bind(native)
  const originalWrite: PtySupervisor['writeConfirmed'] = ptys.writeConfirmed.bind(ptys)
  const userWrites: number[] = []
  ptys.writeConfirmed = (...args) => {
    return originalWrite(...args).then(() => {
      if (args[4] === 'user')
        userWrites.push(
          typeof args[2] === 'string' ? Buffer.byteLength(args[2]) : args[2].byteLength,
        )
      if (userWrites.length > 64) throw new Error('native-input-observer-bound')
    })
  }
  let sourceTriggered = false
  let continuousTriggered = false
  let phaseName: NativeInputProbePhase | undefined
  let sourceBytes = 0
  let captureBytes: number | undefined
  let continuousAfterCapture = 0
  let producedBytes = 0
  let warmupBodyBytes = 0
  let feedBefore = 0
  let parsedNativeFeedDelta = 0
  let triggerAt = 0
  let captureAt = 0
  let completionAt = 0
  let queryTail = ''
  const stopQuery = ptys.attach(
    managed.id,
    owner.id,
    {
      onData: (chunk) => {
        if (phaseName === 'continuous') {
          sourceBytes += Buffer.byteLength(chunk)
          if (captureBytes !== undefined)
            continuousAfterCapture += Buffer.byteLength(chunk)
        }
        const markers = queryTail + chunk
        queryTail = markers.slice(-128)
        if (
          phaseName === 'continuous' &&
          !continuousTriggered &&
          markers.includes(PREFIX + 'continuous_TRIGGER__')
        ) {
          continuousTriggered = true
          triggerAt = performance.now()
          win.webContents.sendInputEvent({
            type: 'keyDown',
            keyCode: 'C',
            modifiers: ['control'],
          })
          win.webContents.sendInputEvent({
            type: 'keyUp',
            keyCode: 'C',
            modifiers: ['control'],
          })
        }
        if (sourceTriggered || !markers.includes(PREFIX + 'concurrent_QUERY__')) return
        sourceTriggered = true
        win.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: 'C',
          modifiers: ['control'],
        })
        win.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: 'C',
          modifiers: ['control'],
        })
      },
    },
    owner.generation,
  )
  native.input = (...args) => {
    if (
      phaseName === 'continuous' &&
      args[2].kind === 'key' &&
      args[2].action === 1 &&
      captureBytes === undefined
    ) {
      captureBytes = sourceBytes
      captureAt = performance.now()
    }
    return original(...args).then((completion: NativeTerminalInputCompletion) => {
      if (phaseName === 'continuous' && args[2].kind === 'key' && args[2].action === 1)
        completionAt = performance.now()
      observed.push({
        kind: args[2].kind,
        requestedMutation: completion.requestedMutation,
        ...(completion.caret ? { caret: { ...completion.caret } } : {}),
        ...(completion.captured === undefined ? {} : { captured: completion.captured }),
        ...(completion.refused ? { refused: completion.refused } : {}),
      })
      if (observed.length > 64) observed.shift()
      return completion
    })
  }
  let mutationFences = 0
  try {
    if (!(await win.webContents.executeJavaScript(focusScript)))
      throw new Error('native-input-focus')
    for (const { command, marker } of terminalProbeSourceDelivery(
      nativeTerminalInputProbeSource(),
      'HVIR_NATIVE_INPUT_B64',
      '__HVIR_NATIVE_INPUT_DELIVERY_',
    )) {
      await write(command)
      await waitFor(async () => (await read()).includes(marker), 'source-delivery')
    }
    await write(
      `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_NATIVE_INPUT_B64"; unset HVIR_NATIVE_INPUT_B64; printf '__HVIR_NATIVE_INPUT_RETURNED__\\n'\r`,
    )
    await waitFor(
      async () => (await read()).includes(PREFIX + 'RECORDER_READY__'),
      'recorder',
    )
    const key = (
      keyCode: string,
      modifiers: Parameters<typeof win.webContents.sendInputEvent>[0]['modifiers'] = [],
    ) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const geometry = (await native.inspectRetained(managed.id, owner)).geometry
    const point = (column: number) =>
      win.webContents.executeJavaScript(
        `(() => { const canvas=document.querySelector('[id^="native-terminal-"] canvas'); if(!canvas)throw new Error('native canvas missing');const r=canvas.getBoundingClientRect();return{x:Math.round(r.left+${(geometry.paddingLeft + (column - 0.5) * geometry.cellWidth) / geometry.backingScale}),y:Math.round(r.top+${(geometry.paddingTop + 1.5 * geometry.cellHeight) / geometry.backingScale})};})()`,
      ) as Promise<{ x: number; y: number }>
    for (const name of Object.keys(phases) as NativeInputProbePhase[]) {
      console.log(`[native-workbench] input-${name}`)
      observed.length = 0
      phaseName = name
      sourceBytes = 0
      const userBefore = userWrites.length
      const beforeStatus = await native.inspectRetained(managed.id, owner)
      const before = beforeStatus.ioAppliedMutation
      if (name === 'continuous') feedBefore = beforeStatus.appliedSequence
      await write('\x1d' + name + '\x1d')
      await waitFor(
        async () =>
          (await read()).includes(
            PREFIX +
              name +
              (name === 'concurrent'
                ? '_QUERY__'
                : name === 'continuous'
                  ? '_TRIGGER__'
                  : '_READY__'),
          ),
        name + '-ready',
      )
      switch (name) {
        case 'enter':
        case 'lnm':
          key('Enter')
          break
        case 'control':
          key('C', ['control'])
          break
        case 'continuous':
          if (!continuousTriggered)
            throw new Error('native-input-continuous-source-trigger')
          break
        case 'concurrent':
          if (!sourceTriggered) throw new Error('native-input-source-trigger')
          break
        case 'arrow':
        case 'application':
          key('Up')
          break
        case 'alt':
          key('Up', ['alt'])
          break
        case 'meta':
          key('Up', ['meta'])
          break
        case 'mok':
          key('Enter', ['control', 'shift'])
          break
        case 'kitty':
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
          win.webContents.sendInputEvent({
            type: 'keyDown',
            keyCode: 'Up',
            modifiers: ['isautorepeat'],
          })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
          break
        case 'paste':
          await win.webContents.executeJavaScript(
            `(() => {const text=document.querySelector('.native-terminal-pane textarea');if(!(text instanceof HTMLTextAreaElement))throw new Error('native textarea missing');const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(PASTE_TEXT)});text.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));return true;})()`,
          )
          break
        case 'composition':
          await win.webContents.executeJavaScript(
            `(() => {const text=document.querySelector('.native-terminal-pane textarea');if(!text)throw new Error('native textarea missing');for(const[type,data]of[['compositionstart',''],['compositionupdate','に']])text.dispatchEvent(new CompositionEvent(type,{data,bubbles:true}));return true;})()`,
          )
          await waitFor(
            () =>
              observed.some(
                (value) => value.kind === 'preedit' && value.requestedMutation > before,
              ),
            'preedit-completion',
          )
          {
            const serial = Math.max(
              ...observed
                .filter((value) => value.kind === 'preedit')
                .map((value) => value.requestedMutation),
            )
            await waitFor(
              async () =>
                ((await native.rendererInfo(managed.id, owner)).lastFrame
                  ?.snapshotMutation ?? -1) >= serial,
              'preedit-frame',
            )
          }
          await waitFor(
            () =>
              observed.some((value) => value.caret?.geometrySerial === geometry.serial),
            'preedit-caret',
          )
          {
            const caret = observed.findLast(
              (value) => value.caret?.geometrySerial === geometry.serial,
            )!.caret!
            const placed = (await win.webContents.executeJavaScript(
              `(() => {const t=document.querySelector('.native-terminal-pane textarea');if(!(t instanceof HTMLTextAreaElement))return false;return Math.abs(parseFloat(t.style.left)-${caret.x})<1&&Math.abs(parseFloat(t.style.top)-${caret.y})<1&&Math.abs(parseFloat(t.style.height)-${caret.height})<1;})()`,
            )) as boolean
            if (
              !placed ||
              caret.x < 0 ||
              caret.y < 0 ||
              caret.x > geometry.width / geometry.backingScale ||
              caret.y > (geometry.height + geometry.cellHeight) / geometry.backingScale
            )
              throw new Error('native-input-caret-placement')
          }
          await win.webContents.executeJavaScript(
            `(() => {const text=document.querySelector('.native-terminal-pane textarea');if(!text)throw new Error('native textarea missing');text.dispatchEvent(new CompositionEvent('compositionend',{data:'日本',bubbles:true}));text.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertFromComposition',data:'日本',bubbles:true,cancelable:true}));return true;})()`,
          )
          key('X')
          break
        case 'mouse': {
          const a = await point(2),
            b = await point(3)
          win.webContents.sendInputEvent({ type: 'mouseMove', ...a })
          win.webContents.sendInputEvent({
            type: 'mouseDown',
            button: 'left',
            clickCount: 1,
            ...a,
          })
          win.webContents.sendInputEvent({
            type: 'mouseMove',
            ...b,
            modifiers: ['leftbuttondown'],
          })
          win.webContents.sendInputEvent({
            type: 'mouseUp',
            button: 'left',
            clickCount: 1,
            ...b,
          })
          break
        }
        case 'wheel': {
          const at = await point(2)
          await win.webContents.executeJavaScript(
            `(() => {const canvas=document.querySelector('[id^="native-terminal-"] canvas');if(!canvas)throw new Error('native canvas missing');canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:${at.x},clientY:${at.y},deltaMode:0,deltaY:${geometry.cellHeight / geometry.backingScale}}));return true;})()`,
          )
          break
        }
        case 'focus':
          await win.webContents.executeJavaScript(
            `(() => {const other=[...document.querySelectorAll('button')].find(b=>b instanceof HTMLButtonElement&&!b.disabled&&b.getBoundingClientRect().width>0);if(!(other instanceof HTMLButtonElement))throw new Error('focus target missing');other.focus();return true;})()`,
          )
          await waitFor(() => observed.some((value) => value.kind === 'focus'), 'blur')
          await win.webContents.executeJavaScript(focusScript)
          break
      }
      const kind =
        name === 'mouse'
          ? 'pointer'
          : name === 'wheel' || name === 'paste'
            ? name
            : name === 'focus'
              ? 'focus'
              : 'key'
      const expected =
        name === 'mouse'
          ? 4
          : name === 'kitty' || name === 'composition'
            ? 3
            : name === 'wheel' || name === 'paste'
              ? 1
              : 2
      await waitFor(
        () => observed.filter((value) => value.kind === kind).length >= expected,
        name + '-all-events',
      )
      await waitFor(
        () =>
          observed.some((value) => value.requestedMutation > before && !value.refused),
        name + '-completion',
      )
      const serial = Math.max(
        ...observed
          .filter((value) => !value.refused)
          .map((value) => value.requestedMutation),
      )
      await waitFor(
        async () =>
          (await native.inspectRetained(managed.id, owner)).ioAppliedMutation >= serial,
        name + '-io',
      )
      await write('\x1dobserve\x1d')
      await waitFor(
        async () => (await read()).includes(PREFIX + name + '_OBSERVED__'),
        name + '-observe',
      )
      await waitFor(
        async () =>
          ((await native.rendererInfo(managed.id, owner)).lastFrame?.snapshotMutation ??
            -1) >= serial,
        name + '-frame',
      )
      if (observed.some((value) => value.refused))
        throw new Error('native-input-qualification-refused')
      if (
        name === 'concurrent' &&
        (userWrites.length !== userBefore + 1 || userWrites.at(-1) !== 1)
      )
        throw new Error('native-input-query-user-provenance')
      if (name === 'continuous') {
        const interrupted = (await read()).match(
          /__HVIR_NATIVE_INPUT_continuous_INTERRUPTED_([0-9]+)__/,
        )
        producedBytes = Number(interrupted?.[1])
        const warmed = (await read()).match(
          /__HVIR_NATIVE_INPUT_continuous_WARMUP_([0-9]+)__/,
        )
        warmupBodyBytes = Number(warmed?.[1])
        parsedNativeFeedDelta =
          (await native.inspectRetained(managed.id, owner)).appliedSequence - feedBefore
        if (
          !producedBytes ||
          warmupBodyBytes < 65536 ||
          !Number.isFinite(warmupBodyBytes) ||
          parsedNativeFeedDelta < 4 ||
          captureAt < triggerAt ||
          completionAt < captureAt ||
          producedBytes > 256 * 1024 ||
          captureBytes === undefined ||
          userWrites.length !== userBefore + 1 ||
          userWrites.at(-1) !== 1
        )
          throw new Error('native-input-continuous-progress')
      }
      if (
        name === 'paste' &&
        (userWrites.length !== userBefore + 1 ||
          userWrites.at(-1) !== Buffer.byteLength(phases.paste.bytes))
      )
        throw new Error('native-input-paste-user-provenance')
      if (name === 'focus' && userWrites.length !== userBefore)
        throw new Error('native-input-focus-user-provenance')
      mutationFences++
      await write('\x1dend\x1d')
      await waitFor(
        async () => (await read()).includes(PREFIX + name + '_OK__'),
        name + '-bytes',
      )
    }
    await write('\x1dquit\x1d')
    await waitFor(
      async () => (await read()).includes(PREFIX + 'RETURNED__'),
      'shell-return',
    )
    if (
      ptys.list().length !== 1 ||
      ptys.get(managed.id)?.instanceId !== managed.instanceId
    )
      throw new Error('native-input-pty-identity')
    return {
      phases: Object.keys(phases).length,
      mutationFences,
      programmaticComposition: true,
      programmaticPaste: true,
      largeAdmissionQualified: false,
      osImeQualified: false,
      ordinaryPasteQualified: false,
      continuousControl: {
        sourceAdmittedTrigger: true,
        producerActiveAtInterrupt: true,
        producedBytes,
        warmupBodyBytes,
        parsedNativeFeedDelta,
        triggerToCaptureMs: captureAt - triggerAt,
        triggerToCompletionMs: completionAt - triggerAt,
        sourceBytesAtCapture: captureBytes ?? 0,
        sourceBytesAfterCaptureIncludingControlMarkers: continuousAfterCapture,
        userWrites: 1,
        osSigintQualified: false,
        physicalOverlapQualified: false,
      },
      concurrentQuery: {
        sourceAdmittedTrigger: true,
        replyBeforeUserKey: true,
        userWrites: 1,
        physicalOverlapQualified: false,
      },
    }
  } finally {
    void stopQuery()
    ptys.writeConfirmed = originalWrite
    native.input = original
  }
}

export interface ReadonlyRendererProbe {
  ok: boolean
  phase: 'readiness' | 'bounds' | 'wheel'
  ready?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
  layout?: {
    cssWidth: number
    cssHeight: number
    backingScale: number
    backingWidth: number
    backingHeight: number
  }
  error?: { name: string; message: string; stack: string }
  census: Record<string, unknown>
}

/** Same-session DOM readiness is observation only; the receiver owns canvas materialization. */
export function nativeReadonlyPresentationReady(
  a: NativeTerminalGeometry,
  b: NativeTerminalGeometry,
  view: ReadonlyRendererProbe,
): boolean {
  const layout = view.layout
  return !!(
    view.ok &&
    view.ready &&
    view.bounds &&
    layout &&
    a.serial === b.serial &&
    a.width === b.width &&
    a.height === b.height &&
    a.backingScale === b.backingScale &&
    [
      layout.cssWidth,
      layout.cssHeight,
      layout.backingScale,
      layout.backingWidth,
      layout.backingHeight,
    ].every(Number.isFinite) &&
    layout.cssWidth > 0 &&
    layout.cssHeight > 0 &&
    Math.fround(layout.backingScale) === Math.fround(b.backingScale) &&
    Math.round(layout.cssWidth * layout.backingScale) === b.width &&
    Math.round(layout.cssHeight * layout.backingScale) === b.height &&
    layout.backingWidth === b.width &&
    layout.backingHeight === b.height
  )
}

/** Fixed qualification script: report its own errors without losing renderer context. */
export function nativeReadonlyProbeScript(
  phase: 'readiness' | 'bounds' | 'wheel',
  deltaY = 0,
  sessionId?: string,
): string {
  if (!Number.isFinite(deltaY)) throw new Error('native-readonly-wheel-delta')
  return String.raw`(() => {
    const phase=${JSON.stringify(phase)}, session=${JSON.stringify(sessionId ?? null)}, selector='[id^="native-terminal-"] canvas';
    const lookup=()=>{if(session===null)return{panel:null,pane:document.querySelector('.native-terminal-pane'),surface:document.querySelector('[id^="native-terminal-"]'),canvas:document.querySelector(selector)};const panel=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===session),pane=panel?.querySelector('.native-terminal-pane'),surface=pane?.querySelector('[id^="native-terminal-"]');return{panel,pane,surface,canvas:surface?.querySelector('canvas')};};
    const finite=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)?{x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height)}:null;
    const census=()=>{const {panel,pane,surface,canvas}=lookup();let bounds=null;try{if(canvas)bounds=finite(canvas.getBoundingClientRect());}catch{}return{panelMatched:!!panel,panelExited:/^Exited \(-?\d+\)$/.test(panel?.getAttribute('data-terminal-status')??''),canvasCount:document.querySelectorAll(selector).length,paneCount:document.querySelectorAll('.native-terminal-pane').length,surfaceCount:document.querySelectorAll('[id^="native-terminal-"]').length,canvasConnected:canvas?.isConnected??false,paneConnected:pane?.isConnected??false,surfaceConnected:surface?.isConnected??false,paneReadonly:pane?.getAttribute('aria-readonly')==='true',panelHidden:panel?.getAttribute('aria-hidden')==='true',paneHidden:pane?.hidden??false,canvasHidden:canvas?.hidden??false,bounds,statusModes:(Array.isArray(window.nativeQualificationModes)?window.nativeQualificationModes:[]).filter(mode=>['native-gpu','native-pixels','unavailable'].includes(mode)).slice(-8)};};
    const clean=(value,max)=>String(value??'').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi,'[url]').slice(0,max);
    try{const {panel,pane,surface,canvas}=lookup();if(phase==='readiness'){
      const facts=census(),r=surface?.getBoundingClientRect(),bounds=canvas?finite(canvas.getBoundingClientRect()):undefined;
      const layout=r?{cssWidth:r.width,cssHeight:r.height,backingScale:window.devicePixelRatio,backingWidth:canvas?.width??0,backingHeight:canvas?.height??0}:undefined;
      return{ok:true,phase,ready:!!(facts.panelMatched&&facts.panelExited&&!facts.panelHidden&&facts.paneReadonly&&facts.paneConnected&&facts.surfaceConnected&&facts.canvasConnected&&!facts.paneHidden&&!facts.canvasHidden&&bounds&&bounds.width>0&&bounds.height>0),bounds,layout,census:facts};
    }if(!canvas)throw new Error('native canvas missing');const r=canvas.getBoundingClientRect(),bounds=finite(r);if(!bounds)throw new Error('native canvas nonfinite bounds');if(phase==='wheel')canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:r.left+8,clientY:r.top+8,deltaMode:0,deltaY:${deltaY}}));return{ok:true,phase,bounds,census:census()};}
    catch(error){return{ok:false,phase,error:{name:clean(error?.name,64),message:clean(error?.message,256),stack:clean(error?.stack,512)},census:census()};}
  })()`
}

async function observeReadonlyRenderer(
  win: BrowserWindow,
  phase: 'readiness' | 'bounds' | 'wheel',
  deltaY = 0,
  sessionId?: string,
): Promise<ReadonlyRendererProbe> {
  let result: ReadonlyRendererProbe
  try {
    result = (await win.webContents.executeJavaScript(
      nativeReadonlyProbeScript(phase, deltaY, sessionId),
    )) as ReadonlyRendererProbe
  } catch (error) {
    console.log(
      'HVIR_NATIVE_READONLY_SCRIPT_FAILURE ' +
        JSON.stringify({
          phase,
          kind: 'execution-context',
          windowDestroyed: win.isDestroyed(),
          webContentsDestroyed: win.webContents.isDestroyed(),
        }),
    )
    throw new Error('native-readonly-script-context-' + phase, { cause: error })
  }
  if (phase !== 'readiness' || !result.ok)
    console.log('HVIR_NATIVE_READONLY_SCRIPT_OBSERVATION ' + JSON.stringify(result))
  if (!result.ok)
    throw new Error('native-readonly-script-' + phase + '-' + result.error?.name)
  return result
}

/** Finished native history remains scrollable after the physical PTY is gone. */
export async function verifyNativeReadonlyInput(
  win: BrowserWindow,
  native: NativeTerminalApplication,
  managed: ManagedPty,
): Promise<{ readonlyWheel: true; frameMutation: number; capturedPixelsChanged: true }> {
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const current = () => {
    const session = native.sessions.get(managed.id)
    return session?.readonly === true && session.session.instanceId === managed.instanceId
  }
  if (!current()) throw new Error('native-input-not-readonly')
  console.log('[native-workbench] readonly-bounds')
  const ready: {
    current?: { geometry: NativeTerminalGeometry; observation: ReadonlyRendererProbe }
  } = {}
  let lastObservation: ReadonlyRendererProbe | undefined
  let lastAcknowledgements:
    | {
        a: Pick<NativeTerminalGeometry, 'serial' | 'width' | 'height' | 'backingScale'>
        b: Pick<NativeTerminalGeometry, 'serial' | 'width' | 'height' | 'backingScale'>
      }
    | undefined
  try {
    await waitFor(async () => {
      const a = (await native.inspectRetained(managed.id, owner)).geometry
      lastObservation = await observeReadonlyRenderer(win, 'readiness', 0, managed.id)
      const b = (await native.inspectRetained(managed.id, owner)).geometry
      lastAcknowledgements = {
        a: {
          serial: a.serial,
          width: a.width,
          height: a.height,
          backingScale: a.backingScale,
        },
        b: {
          serial: b.serial,
          width: b.width,
          height: b.height,
          backingScale: b.backingScale,
        },
      }
      if (!current() || !nativeReadonlyPresentationReady(a, b, lastObservation))
        return false
      ready.current = { geometry: b, observation: lastObservation }
      return true
    }, 'readonly-presentation-ready')
  } catch (error) {
    console.log(
      'HVIR_NATIVE_READONLY_READINESS_FAILURE ' +
        JSON.stringify({
          observation: lastObservation ?? { observed: false },
          acknowledgements: lastAcknowledgements,
        }),
    )
    throw error
  }
  const accepted = ready.current
  if (!accepted?.observation.bounds) throw new Error('native-readonly-bounds-missing')
  const { geometry, observation } = accepted,
    bounds = accepted.observation.bounds
  console.log('HVIR_NATIVE_READONLY_SCRIPT_OBSERVATION ' + JSON.stringify(observation))
  const hash = async () =>
    createHash('sha256')
      .update((await win.webContents.capturePage(bounds)).toBitmap())
      .digest('hex')
  console.log('[native-workbench] readonly-baseline')
  let baseline = await hash()
  await waitFor(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    const next = await hash()
    const stable = baseline === next
    baseline = next
    return stable
  }, 'readonly-baseline')
  const before = (await native.inspectRetained(managed.id, owner)).ioAppliedMutation
  console.log('[native-workbench] readonly-wheel')
  await observeReadonlyRenderer(
    win,
    'wheel',
    (-8 * geometry.cellHeight) / geometry.backingScale,
    managed.id,
  )
  await waitFor(
    async () =>
      (await native.inspectRetained(managed.id, owner)).ioAppliedMutation > before,
    'readonly-io',
  )
  const serial = (await native.inspectRetained(managed.id, owner)).ioAppliedMutation
  await waitFor(
    async () =>
      ((await native.rendererInfo(managed.id, owner)).lastFrame?.snapshotMutation ??
        -1) >= serial,
    'readonly-frame',
  )
  await waitFor(async () => (await hash()) !== baseline, 'readonly-pixels')
  return { readonlyWheel: true, frameMutation: serial, capturedPixelsChanged: true }
}
