import { createHash } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { NativeTerminalInputCompletion } from '../../shared/native-terminal-input'
import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import { terminalProbeSourceDelivery } from './terminal-probe-source'

const PREFIX = '__HVIR_NATIVE_LARGE_PASTE_'
const CASES = [
  {
    name: 'unicode',
    sourceBytes: 17 * 1024 * 1024,
    pattern: 'é🙂\r\n',
    lnm: false,
    bracketed: true,
  },
  {
    name: 'lnm',
    sourceBytes: 33 * 1024 * 1024,
    pattern: '\n',
    lnm: true,
    bracketed: false,
  },
] as const

/** Fixed fixtures hash incrementally; neither recorder nor main retains the body. */
export function nativePasteExpectations() {
  return CASES.map((fixture) => {
    const repeat = fixture.sourceBytes / Buffer.byteLength(fixture.pattern)
    const wirePattern = fixture.lnm ? '\r\n' : fixture.pattern
    const hash = createHash('sha256').update(fixture.bracketed ? '\x1b[200~' : '')
    const block = wirePattern.repeat(1024)
    let remaining = repeat
    while (remaining >= 1024) {
      hash.update(block)
      remaining -= 1024
    }
    hash
      .update(wirePattern.repeat(remaining))
      .update(fixture.bracketed ? '\x1b[201~' : '')
    return {
      ...fixture,
      repeat,
      wireBytes: Buffer.byteLength(wirePattern) * repeat + (fixture.bracketed ? 12 : 0),
      sha256: hash.digest('hex'),
    }
  })
}

export function nativePasteRecorderSource(): string {
  const fixtures = nativePasteExpectations().map(
    ({ name, wireBytes, sha256, lnm, bracketed }) => ({
      name,
      wireBytes,
      sha256,
      lnm,
      bracketed,
    }),
  )
  return `
const {createHash}=require('node:crypto'),fixtures=${JSON.stringify(fixtures)},prefix=${JSON.stringify(PREFIX)};
let fixture,hash,count=0,command=null,waiting=false,handshake=Buffer.alloc(0),closed=false;
const marker=s=>process.stdout.write(prefix+s+'__\\r\\n');
const finish=code=>{if(closed)return;closed=true;clearTimeout(timer);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\\x1b[20l\\x1b[?2004l',()=>process.exit(code));};
const fail=()=>{marker('FAILED');finish(2);};
const timer=setTimeout(fail,100000);
const control=value=>{if(value==='quit'){marker('CLOSED');return finish(0);}if(value==='end'){if(!fixture||waiting||count!==fixture.wireBytes||hash.digest('hex')!==fixture.sha256)return fail();marker(fixture.name+'_OK');fixture=undefined;return;}fixture=fixtures.find(f=>f.name===value);if(!fixture)return fail();hash=createHash('sha256');count=0;waiting=true;handshake=Buffer.alloc(0);process.stdout.write((fixture.bracketed?'\\x1b[?2004h':'\\x1b[?2004l')+(fixture.lnm?'\\x1b[20h':'\\x1b[20l')+'\\x1b[5n');};
const accept=bytes=>{if(!fixture)return bytes.length?fail():undefined;if(waiting){handshake=Buffer.concat([handshake,bytes]);const reply=Buffer.from('\\x1b[0n');if(!handshake.subarray(0,Math.min(reply.length,handshake.length)).equals(reply.subarray(0,Math.min(reply.length,handshake.length))))return fail();if(handshake.length<reply.length)return;bytes=handshake.subarray(reply.length);handshake=Buffer.alloc(0);waiting=false;marker(fixture.name+'_READY');}count+=bytes.length;if(count>fixture.wireBytes)return fail();hash.update(bytes);};
process.stdin.setRawMode(true);process.stdin.on('data',bytes=>{let start=0;for(let i=0;i<bytes.length&&!closed;i++){if(command!==null){if(bytes[i]===29){const value=command;command=null;control(value);}else{command+=String.fromCharCode(bytes[i]);if(command.length>16)return fail();}start=i+1;}else if(bytes[i]===29){accept(bytes.subarray(start,i));command='';start=i+1;}}if(!closed&&command===null&&start<bytes.length)accept(bytes.subarray(start));});process.stdin.resume();marker('READY');
`
}

/** Large synthetic clipboard transactions through the ordinary renderer input path. */
export async function verifyNativeTerminalPaste(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const write = (body: string) =>
    ptys.writeConfirmed(managed.id, owner.id, body, owner.generation)
  const read = async () => {
    const text = new TextDecoder().decode(await native.readRetained(managed.id, owner))
    if (text.includes(PREFIX + 'FAILED__')) throw new Error('native-large-paste-recorder')
    return text
  }
  const wait = async (check: () => boolean | Promise<boolean>, phase: string) => {
    const deadline = Date.now() + 45000
    do {
      if (await check()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    throw new Error('native-large-paste-' + phase + '-timeout')
  }
  const originalInput = native.input.bind(native)
  const originalWrite = ptys.writeConfirmed.bind(ptys)
  const completions: NativeTerminalInputCompletion[] = []
  const confirmedWrites: number[] = []
  let confirmedAt = 0
  let current = false
  native.input = (...args) =>
    originalInput(...args).then((result) => {
      if (current && args[2].kind === 'paste') {
        completions.push(result)
        if (completions.length > 1) throw new Error('native-large-paste-completion-bound')
      }
      return result
    })
  ptys.writeConfirmed = (...args) =>
    originalWrite(...args).then(() => {
      if (current && args[4] === 'user') {
        confirmedAt = performance.now()
        confirmedWrites.push(
          typeof args[2] === 'string' ? Buffer.byteLength(args[2]) : args[2].byteLength,
        )
        if (confirmedWrites.length > 2) throw new Error('native-large-paste-write-bound')
      }
    })
  const samples: Array<{
    atMs: number
    processes: Array<{
      pid: number
      type: string
      workingSetSize: number
      peakWorkingSetSize: number
    }>
  }> = []
  const sample = () => {
    if (samples.length >= 1024) return
    samples.push({
      atMs: performance.now(),
      processes: app.getAppMetrics().map(({ pid, type, memory }) => ({
        pid,
        type,
        workingSetSize: memory.workingSetSize,
        peakWorkingSetSize: memory.peakWorkingSetSize,
      })),
    })
  }
  const results: Array<{
    name: string
    sourceBytes: number
    wireBytes: number
    wireSha256: string
    confirmedUserWrites: number
    elapsedMs: number
    confirmedWriteMs: number
    recorderAcknowledgedMs: number
    paint: { frames: number; maxGapMs: number; heapBefore?: number; heapAfter?: number }
  }> = []
  let sampleTimer: ReturnType<typeof setInterval> | undefined
  try {
    await write("stty -echo; printf '__HVIR_NATIVE_PASTE_ECHO_OFF__\\n'\r")
    await wait(
      async () => (await read()).includes('__HVIR_NATIVE_PASTE_ECHO_OFF__'),
      'echo-off',
    )
    for (const { command, marker } of terminalProbeSourceDelivery(
      nativePasteRecorderSource(),
      'HVIR_PASTE_B64',
      PREFIX + 'DELIVERY_',
    )) {
      await write(command)
      await wait(async () => (await read()).includes(marker), 'delivery')
    }
    await write(
      `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_PASTE_B64"; unset HVIR_PASTE_B64; stty echo; printf '${PREFIX}RETURNED__\\n'\r`,
    )
    await wait(async () => (await read()).includes(PREFIX + 'READY__'), 'recorder')
    for (const fixture of nativePasteExpectations()) {
      console.log('[native-workbench] large-paste-' + fixture.name)
      await write('\x1d' + fixture.name + '\x1d')
      await wait(
        async () => (await read()).includes(PREFIX + fixture.name + '_READY__'),
        'mode',
      )
      completions.length = 0
      confirmedWrites.length = 0
      current = true
      sample()
      sampleTimer = setInterval(sample, 100)
      const started = performance.now()
      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('.native-terminal-pane textarea');if(!(input instanceof HTMLTextAreaElement))throw new Error('native paste textarea');input.focus({preventScroll:true});
        const observation={frames:0,maxGapMs:0,last:performance.now(),active:true,heapBefore:performance.memory?.usedJSHeapSize};window.nativeLargePasteObservation=observation;
        const tick=now=>{if(!observation.active)return;observation.frames++;observation.maxGapMs=Math.max(observation.maxGapMs,now-observation.last);observation.last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
        const transfer=new DataTransfer();transfer.setData('text/plain',${JSON.stringify(fixture.pattern)}.repeat(${fixture.repeat}));input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));return true;
      })()`)
      await wait(
        () => completions.length > 0 && confirmedWrites.length > 0,
        'confirmation',
      )
      const completion = completions.at(-1)
      if (
        !completion ||
        completion.refused ||
        confirmedWrites.length !== 1 ||
        confirmedWrites[0] !== fixture.wireBytes
      ) {
        console.log(
          'HVIR_NATIVE_LARGE_PASTE_WRITE_FAILURE ' +
            JSON.stringify({
              name: fixture.name,
              sourceBytes: fixture.sourceBytes,
              expectedWireBytes: fixture.wireBytes,
              observedWriteBytes: confirmedWrites,
              completionObserved: !!completion,
              refused: completion?.refused ?? null,
              requestedMutation: completion?.requestedMutation ?? null,
            }),
        )
        throw new Error('native-large-paste-one-write')
      }
      await write('\x1dend\x1d')
      await wait(
        async () => (await read()).includes(PREFIX + fixture.name + '_OK__'),
        'exact-wire',
      )
      const recorderAcknowledgedAt = performance.now()
      const completed = completion
      await wait(
        async () =>
          (await native.inspectRetained(managed.id, owner)).ioAppliedMutation >=
          completed.requestedMutation,
        'io',
      )
      const paint = (await win.webContents.executeJavaScript(
        `(() => {const value=window.nativeLargePasteObservation;value.active=false;return{frames:value.frames,maxGapMs:Math.max(value.maxGapMs,performance.now()-value.last),heapBefore:value.heapBefore,heapAfter:performance.memory?.usedJSHeapSize};})()`,
      )) as { frames: number; maxGapMs: number; heapBefore?: number; heapAfter?: number }
      if (!paint.frames || paint.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs)
        throw new Error('native-large-paste-paint-budget')
      clearInterval(sampleTimer)
      sampleTimer = undefined
      sample()
      results.push({
        name: fixture.name,
        sourceBytes: fixture.sourceBytes,
        wireBytes: fixture.wireBytes,
        wireSha256: fixture.sha256,
        confirmedUserWrites: 1,
        elapsedMs: performance.now() - started,
        confirmedWriteMs: confirmedAt - started,
        recorderAcknowledgedMs: recorderAcknowledgedAt - started,
        paint,
      })
      current = false
    }
    await write('\x1dquit\x1d')
    await wait(async () => (await read()).includes(PREFIX + 'RETURNED__'), 'return')
    if (
      ptys.list().length !== 1 ||
      ptys.get(managed.id)?.instanceId !== managed.instanceId
    )
      throw new Error('native-large-paste-instance')
    return {
      programmaticPaste: true,
      ordinaryPasteQualified: true,
      largeAdmissionQualified: true,
      systemClipboardQualified: false,
      physicalPeakMemoryQualified: false,
      samplesKiB: samples,
      cases: results,
    }
  } finally {
    if (sampleTimer) clearInterval(sampleTimer)
    current = false
    native.input = originalInput
    ptys.writeConfirmed = originalWrite
    await win.webContents
      .executeJavaScript(
        'if(window.nativeLargePasteObservation)window.nativeLargePasteObservation.active=false;true',
      )
      .catch(() => undefined)
  }
}
