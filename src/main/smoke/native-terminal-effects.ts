import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import type { PtySupervisor, ManagedPty } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import { terminalProbeSourceDelivery } from './terminal-probe-source'

const PREFIX = '__HVIR_NATIVE_EFFECTS_'

/** Fixed protocol fixtures. Printed bytes never authorize an OS operation. */
export function nativeEffectsFixtureCases() {
  const osc = (body: string) => '\x1b]' + body + '\x1b\\'
  return [
    {
      name: 'title',
      parts: ['\x1b]2;HVIR_NATIVE_', 'EFFECTS_TITLE\x1b\\'],
      reply: '\x1b[0n',
    },
    {
      name: 'cwd',
      parts: [osc('7;file://remote-fixture.invalid/work/native-effects')],
      reply: '\x1b[0n',
    },
    {
      name: 'attention',
      parts: [
        '\x07',
        osc('9;quiet fixture notification'),
        osc('777;notify;ignored;ignored'),
        osc('9;4;1;42'),
      ],
      reply: '\x1b[0n',
    },
    { name: 'clipboard', parts: [osc('52;pc;bmF0aXZlLWVmZmVjdHM=')], reply: '\x1b[0n' },
    { name: 'fullClipboard', parts: [], generated: 'full', reply: '\x1b[0n' },
    {
      name: 'refusedClipboard',
      parts: [
        osc('52;c;?'),
        osc('52;p;bm8='),
        osc('52;c;!!!!'),
        osc('52;c;/w=='),
        osc('1337;Copy=:bm8='),
        osc('5522;type=read;dGV4dC9wbGFpbg=='),
      ],
      generated: 'oversized',
      reply: '\x1b[0n',
    },
    {
      name: 'semantic',
      parts: [
        osc('133;A'),
        'prompt ',
        osc('133;B'),
        'command\r\n',
        osc('133;C'),
        'output\r\n',
        osc('133;D;0'),
      ],
      reply: '\x1b[0n',
    },
    {
      name: 'link',
      parts: [
        '\x1b[999;1H',
        osc('8;id=effects-fixture;https://effects-fixture.invalid/path'),
        'native-link',
        osc('8;;'),
      ],
      reply: '\x1b[0n',
    },
    {
      name: 'palette',
      parts: [osc('4;1;#123456'), osc('4;1;?')],
      reply: '\x1b]4;1;rgb:1212/3434/5656\x1b\\\x1b[0n',
    },
    { name: 'reset', parts: ['\x1b[!p'], reply: '\x1b[0n' },
  ] as const
}

/** Tiny same-PTY raw recorder; full payloads are generated only inside its child. */
export function nativeEffectsRecorderSource(): string {
  return `
const phases=${JSON.stringify(nativeEffectsFixtureCases())},prefix=${JSON.stringify(PREFIX)};
let active,received=Buffer.alloc(0),command=null,closed=false;
const marker=value=>process.stdout.write(prefix+value+'__\\r\\n');
const finish=code=>{if(closed)return;closed=true;clearTimeout(timer);process.stdin.setRawMode(false);process.stdin.pause();process.exitCode=code;process.stdout.write('',()=>process.exit(code));};
const fail=()=>{marker('FAILED');finish(2);};
const timer=setTimeout(fail,45000);
function control(value){if(value==='quit'){if(active)return fail();marker('CLOSED');return finish(0);}if(active)return fail();active=phases.find(p=>p.name===value);if(!active)return fail();received=Buffer.alloc(0);const parts=[...active.parts];if(active.generated)parts.push('\\x1b]52;c;'+'YWFh'.repeat(active.generated==='full'?16384:16385)+'\\x1b\\\\');let index=0;const write=()=>{if(closed)return;if(index<parts.length){const part=parts[index++];if(process.stdout.write(part)===false)process.stdout.once('drain',write);else setImmediate(write);}else process.stdout.write('\\x1b[5n');};write();}
function reply(bytes){if(!bytes.length)return;if(!active)return fail();received=Buffer.concat([received,bytes]);const expected=Buffer.from(active.reply);if(received.length>expected.length||!received.equals(expected.subarray(0,received.length)))return fail();if(received.length===expected.length){marker(active.name+'_OK');active=undefined;received=Buffer.alloc(0);}}
process.stdin.setRawMode(true);process.stdin.on('data',bytes=>{let start=0;for(let i=0;i<bytes.length&&!closed;i++){if(command!==null){if(bytes[i]===29){const value=command;command=null;control(value);}else{command+=String.fromCharCode(bytes[i]);if(command.length>24)return fail();}start=i+1;}else if(bytes[i]===29){reply(bytes.subarray(start,i));command='';start=i+1;}}if(!closed&&command===null&&start<bytes.length)reply(bytes.subarray(start));});process.stdin.resume();marker('READY');
`
}

/** Same injected main policy port as production, with no operating-system clipboard action. */
export class NativeEffectsClipboardObservation {
  private readonly entries: Array<{ bytes: number; sha256: string }> = []
  writeText(text: string): void {
    if (this.entries.length >= 32)
      throw new Error('native-effects-clipboard-observation-bound')
    this.entries.push({
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  }
  snapshot() {
    return this.entries.map((value) => ({ ...value }))
  }
}

export async function verifyNativeTerminalEffects(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
  clipboard: NativeEffectsClipboardObservation,
) {
  if (!native.effects) throw new Error('native-effects-policy-unavailable')
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const write = (body: string) =>
    ptys.writeConfirmed(managed.id, owner.id, body, owner.generation)
  const read = async () => {
    const text = new TextDecoder().decode(await native.readRetained(managed.id, owner))
    if (text.includes(PREFIX + 'FAILED__')) throw new Error('native-effects-recorder')
    return text
  }
  const wait = async (check: () => Promise<boolean>, phase: string) => {
    const deadline = Date.now() + 15000
    do {
      if (await check()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    throw new Error('native-effects-' + phase + '-timeout')
  }
  let observationFailure: Error | undefined
  let lastSerial = 0,
    effectCount = 0,
    semantics = 0,
    bells = 0,
    osc9 = 0,
    palette = 0,
    maximumDrops = 0
  let linkUserIntentPort = false
  let title = false,
    cwd = false,
    fullClipboard = false
  const before = clipboard.snapshot().length
  const stop = native.effects.observe(({ session, batch, executionFailures }) => {
    if (executionFailures) {
      observationFailure = new Error('native-effects-execution-failure')
      return
    }
    if (session.sessionId !== managed.id || session.instanceId !== managed.instanceId) {
      observationFailure = new Error('native-effects-observed-foreign-instance')
      return
    }
    maximumDrops = Math.max(maximumDrops, batch.droppedEffects)
    for (const effect of batch.effects) {
      if (effect.sequence <= 0 || effect.eventSerial <= lastSerial) {
        observationFailure = new Error('native-effects-causal-provenance')
        return
      }
      lastSerial = effect.eventSerial
      effectCount++
      if (effect.kind === 'title' && effect.title === 'HVIR_NATIVE_EFFECTS_TITLE')
        title = true
      if (
        effect.kind === 'cwd' &&
        effect.uri === 'file://remote-fixture.invalid/work/native-effects'
      )
        cwd = true
      if (
        effect.kind === 'clipboard' &&
        effect.data.length === 65536 &&
        effect.selection.includes('c')
      )
        fullClipboard = true
      if (effect.kind === 'semantic') semantics++
      if (effect.kind === 'bell') bells++
      if (effect.kind === 'notification' && effect.source === 'osc-9') osc9++
      if (effect.kind === 'palette') palette++
    }
  })
  let mainSamples = 0,
    mainMaximum = 0,
    lastMainBeat = performance.now()
  const mainHeartbeat = setInterval(() => {
    const now = performance.now()
    mainSamples++
    mainMaximum = Math.max(mainMaximum, now - lastMainBeat)
    lastMainBeat = now
  }, 5)
  try {
    await win.webContents.executeJavaScript(
      `(() => {window.nativeEffectsProduct={titles:0,bells:0};const beat={samples:0,last:performance.now(),maxMs:0,active:true};window.nativeEffectsResponsiveness=beat;const tick=now=>{if(!beat.active)return;beat.samples++;beat.maxMs=Math.max(beat.maxMs,now-beat.last);beat.last=now;requestAnimationFrame(tick)};requestAnimationFrame(tick);window.nativeEffectsStop=window.hvir.on('native-terminal:effect',value=>{if(value.id!==${JSON.stringify(managed.id)}||value.instanceId!==${JSON.stringify(managed.instanceId)})return;if(value.effect.kind==='title')window.nativeEffectsProduct.titles++;if(value.effect.kind==='bell')window.nativeEffectsProduct.bells++;});return true;})()`,
    )
    const productCounts = () =>
      win.webContents.executeJavaScript('({...window.nativeEffectsProduct})') as Promise<{
        titles: number
        bells: number
      }>
    await write("stty -echo; printf '__HVIR_NATIVE_EFFECTS_ECHO_OFF__\\n'\r")
    await wait(async () => (await read()).includes(PREFIX + 'ECHO_OFF__'), 'echo-off')
    for (const { command, marker } of terminalProbeSourceDelivery(
      nativeEffectsRecorderSource(),
      'HVIR_EFFECTS_B64',
      PREFIX + 'DELIVERY_',
    )) {
      await write(command)
      await wait(async () => (await read()).includes(marker), 'delivery')
    }
    await write(
      `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_EFFECTS_B64"; unset HVIR_EFFECTS_B64; stty echo; printf '${PREFIX}RETURNED__\\n'\r`,
    )
    await wait(async () => (await read()).includes(PREFIX + 'READY__'), 'recorder')
    for (const fixture of nativeEffectsFixtureCases()) {
      console.log('[native-workbench] effects-' + fixture.name)
      const productBefore = await productCounts()
      await write('\x1d' + fixture.name + '\x1d')
      await wait(
        async () => (await read()).includes(PREFIX + fixture.name + '_OK__'),
        fixture.name,
      )
      if (observationFailure) throw observationFailure
      if (fixture.name === 'attention')
        await wait(async () => {
          const product = await productCounts()
          if (
            product.bells > productBefore.bells + 2 ||
            product.titles !== productBefore.titles
          )
            throw new Error('native-effects-ignored-notification-side-effect')
          return product.bells === productBefore.bells + 2
        }, 'quiet-attention-disposition')
      if (fixture.name === 'title')
        await wait(
          () =>
            win.webContents.executeJavaScript(
              "document.body.textContent.includes('HVIR_NATIVE_EFFECTS_TITLE')",
            ) as Promise<boolean>,
          'product-title',
        )
      if (fixture.name === 'link') {
        let query:
          import('../../shared/native-terminal-link').NativeTerminalLinkQuery | undefined
        await wait(async () => {
          const status = await native.inspectRetained(managed.id, owner)
          const frame = (await native.rendererInfo(managed.id, owner)).lastFrame
          if (
            !frame ||
            frame.streamSequence !== status.appliedSequence ||
            frame.geometrySerial !== status.geometry.serial
          )
            return false
          // Query the native viewport instead of inferring scroll/wrap from marker text.
          for (let row = status.geometry.rows - 1; row >= 0; row--) {
            const candidate = {
              row,
              column: 0,
              screen: 0 as const,
              expectedSequence: status.appliedSequence,
              expectedMutation: frame.snapshotMutation,
              expectedGeometrySerial: status.geometry.serial,
            }
            const link = await native.readLink(managed.id, owner, candidate)
            if (!link) continue
            if (
              link.uri !== 'https://effects-fixture.invalid/path' ||
              JSON.stringify(link.workspaceRoot) !== JSON.stringify(managed.workspaceRoot)
            )
              throw new Error('native-effects-link-target')
            query = candidate
            return true
          }
          return false
        }, 'link-readback')
        if (!query) throw new Error('native-effects-link-query-missing')
        let activations = 0
        await native.activateLink(managed.id, owner, query, (link) => {
          if (
            link.uri !== 'https://effects-fixture.invalid/path' ||
            JSON.stringify(link.workspaceRoot) !== JSON.stringify(managed.workspaceRoot)
          )
            throw new Error('native-effects-link-intent-target')
          activations++
        })
        if (activations !== 1) throw new Error('native-effects-link-intent-count')
        linkUserIntentPort = true
      }
    }
    await wait(
      () =>
        Promise.resolve(
          title &&
            cwd &&
            fullClipboard &&
            semantics >= 3 &&
            bells >= 1 &&
            osc9 >= 1 &&
            palette >= 1,
        ),
      'copied-observations',
    )
    const accepted = clipboard.snapshot().slice(before)
    const expected = ['native-effects', 'a'.repeat(49152)].map((text) => ({
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex'),
    }))
    if (JSON.stringify(accepted) !== JSON.stringify(expected))
      throw new Error('native-effects-clipboard-policy')
    await write('\x1dquit\x1d')
    await wait(async () => (await read()).includes(PREFIX + 'RETURNED__'), 'shell-return')
    if (
      ptys.list().length !== 1 ||
      ptys.get(managed.id)?.instanceId !== managed.instanceId
    )
      throw new Error('native-effects-pty-identity')
    const renderer = (await win.webContents.executeJavaScript(
      '(() => {const beat=window.nativeEffectsResponsiveness;beat.active=false;return{samples:beat.samples,maxMs:Math.max(beat.maxMs,performance.now()-beat.last)}})()',
    )) as { samples: number; maxMs: number }
    const main = {
      samples: mainSamples,
      maxMs: Math.max(mainMaximum, performance.now() - lastMainBeat),
    }
    for (const loop of [main, renderer])
      if (loop.samples < 2 || loop.maxMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs)
        throw new Error('native-effects-responsiveness-budget')
    return {
      responsiveness: {
        main,
        renderer,
        maximumMs: UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs,
      },
      phases: nativeEffectsFixtureCases().length,
      effectCount,
      causalEventSerials: true,
      titleProductDelivery: true,
      remoteCwdCopied: true,
      semanticObservations: semantics,
      semanticOccurrenceIdentityQualified: false,
      clipboardWrites: accepted.map((value) => ({ ...value })),
      readQueriesRefused: true,
      newClipboardProtocolsRefused: true,
      maximumDroppedEffects: maximumDrops,
      queriesExact: true,
      linkUserIntentPortHostCorrect: linkUserIntentPort,
      linkGestureQualified: false,
      osc777AndProgressDisposition: 'ignored',
      quietAttentionEvents: 2,
      reset: 'decstr-soft-reset',
      nativeOsActionsQualified: false,
      hardwareQualified: false,
    }
  } finally {
    clearInterval(mainHeartbeat)
    stop()
    await win.webContents
      .executeJavaScript(
        'window.nativeEffectsStop?.();if(window.nativeEffectsResponsiveness)window.nativeEffectsResponsiveness.active=false;delete window.nativeEffectsResponsiveness;delete window.nativeEffectsStop;delete window.nativeEffectsProduct;true',
      )
      .catch(() => undefined)
  }
}
