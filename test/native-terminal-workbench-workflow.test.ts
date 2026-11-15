import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
}
const workflow = parse(
  readFileSync(
    new URL('../.github/workflows/native-terminal.yml', import.meta.url),
    'utf8',
  ),
) as Workflow
const qualification = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .find((step) => step.name === 'Qualify the ordinary native workbench runtime')?.run
if (!qualification) throw new Error('Native workbench qualification step missing')

/** Executes the real workflow shell and JSON assertions; only build/display/producer are fixtures. */
function executeQualification(
  command: string,
  platform: 'macOS' | 'Linux',
  invalid = false,
  badEffect?: 'clipboard' | 'responsiveness' | 'disposition',
  badSelection?:
    | 'clipboard'
    | 'liveness'
    | 'authority'
    | 'responsiveness'
    | 'os-clipboard'
    | 'readonly'
    | 'pending-ack'
    | 'pointer-capture'
    | 'readonly-cleanup'
    | 'readonly-write'
    | 'held-buttons',
  badQuery?:
    | 'clipboard'
    | 'pixels'
    | 'progress'
    | 'responsiveness'
    | 'lost-selection'
    | 'streaming-deadline',
  badAppearance?: 'selection' | 'geometry' | 'cursor' | 'unicode',
) {
  const directory = mkdtempSync(join(tmpdir(), 'hvir-native-workbench-report-'))
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    mkdirSync(join(directory, 'hvir-native-bindings'))
    mkdirSync(join(directory, 'hvir-native-trace'))
    const producer = join(directory, 'producer.cjs')
    writeFileSync(
      producer,
      `
const proof = {
  platform: process.env.RUNNER_OS === 'Linux' ? 'linux' : 'darwin',
  actualWorkbench: true, resizeControl: 'terminal-rail',
  stack: {successfulExplicitSelection: {backend: 'x11'}},
  rendererSandboxed: true, rendererContextIsolated: true, supervisorSpawns: 1,
  nativeInstanceMatched: true, parserMarker: true, retainedExitTail: true,
  rendererCanvas: true, nativeEncodedKeyboard: true, capturedAnsiRedPixels: 501,
  resizeAcknowledgedByStty: {rows: 21, columns: 80}, development: true,
  hardwareQualified: process.env.HVIR_TEST_INVALID === 'true',
  nativeQuery:{actualNative:true,matches:3,exactCopy:{bytes:23,sha256:require('node:crypto').createHash('sha256').update('hvir-native-query-match').digest('hex')},semanticCopy:{bytes:7,sha256:require('node:crypto').createHash('sha256').update('output\\n').digest('hex')},semanticNavigation:['Output 3 of 3','Command 2 of 3','Output 3 of 3'],selectedHighlight:{first:{left:1,top:1,right:200,bottom:16,pixels:300,expectedWidth:200,expectedHeight:16},second:{left:1,top:20,right:200,bottom:35,pixels:300,expectedWidth:200,expectedHeight:16},returned:{left:1,top:1,right:200,bottom:16,pixels:300,expectedWidth:200,expectedHeight:16},moved:{left:1,top:20,right:200,bottom:35,pixels:300,expectedWidth:200,expectedHeight:16}},movedOccurrence:{rowEdit:'insert-line',sameSelection:true,noRevealGesture:true,exactCopy:{bytes:23,sha256:require('node:crypto').createHash('sha256').update('hvir-native-query-match').digest('hex')}},frames:10,maximumFrameGapMs:20,existingHighMatchFrameBudgetMs:500,highMatch:{initial:12000,observedReducedCount:16,observedAtMs:1000,observationWindowMs:3000,latestCount:0,latestStatus:'empty',latestAtMs:6200,selectionUnavailable:true,sameOpenQuery:true,removal:'capacity-eviction',rendererGrowthKiB:100},streaming:{elapsedMs:1000,evidenceBudgetMs:2500,completionBudgetMs:7000,selectedIndex:1,copiedWhileProducing:true}},
  nativeAppearance:{fractionalScale:{cursor:{shape:'underline',pixels:16},before:1,after:1.25,currentDraw:true},actualNative:true,initialFontAppliedBeforeDraw:true,restoredBuiltinPalettePixels:true,samePty:true,gallery:{cancel:true,pairedSave:true},cursorShapes:['block','hollow-block','bar','underline'],cursorQueryCodes:[2,2,6,4],applicationCursorOverride:true,ligatureSettings:{onOff:true,exactPointerCopy:true},hardwareQualified:false,palettes:Object.fromEntries(['dark','light'].map(theme=>[theme,{queryRepliesExact:true,configuredSelectionPixels:true,samples:{background:100,foreground:100,green:100,blue:100}}])),hiddenFontReveal:{missingFamilyFallback:true,currentDraw:true,before:{serial:2,cellHeight:16},after:{serial:3,cellHeight:22,rows:20,columns:80},stty:{rows:20,columns:80},unicodeExactPointerCopy:{bytes:Buffer.byteLength('漢字🙂 e\\u0301'),sha256:require('node:crypto').createHash('sha256').update('漢字🙂 e\\u0301').digest('hex')}}},
  nativeEffects:{phases:10,causalEventSerials:true,titleProductDelivery:true,remoteCwdCopied:true,readQueriesRefused:true,newClipboardProtocolsRefused:true,queriesExact:true,linkUserIntentPortHostCorrect:true,semanticObservations:4,semanticOccurrenceIdentityQualified:false,linkGestureQualified:false,hardwareQualified:false,nativeOsActionsQualified:false,osc777AndProgressDisposition:'ignored',quietAttentionEvents:2,clipboardWrites:['native-effects','a'.repeat(49152)].map(text=>({bytes:Buffer.byteLength(text),sha256:require('node:crypto').createHash('sha256').update(text).digest('hex')})),responsiveness:{maximumMs:500,main:{samples:4,maxMs:10},renderer:{samples:4,maxMs:18}}},
  nativeSelection:{pendingPressAck:{pointerId:1,heldMoveButtons:1,trustedOutsideMove:true,trustedOutsideUp:true,ackHeldUntilOutsideUp:true,nativeOriginalViewOrder:true,captureReleasedBeforeAck:true,captureReleasedAfterAck:true,exactSelectedBytes:5,exactSelectedSha256:require('node:crypto').createHash('sha256').update('alpha').digest('hex')},samePty:true,originalReadyBeforeClear:true,clearScreenScrollback:true,resetTerminal:true,parserInputAlive:true,drag:true,word:true,line:true,unicodeWhitespace:true,softwrap:true,selectAll:true,menu:true,metaCopy:true,controlShiftCopy:true,fileUriAndPlainIntent:true,linkRootsMatched:true,loopbackRouteContent:true,externalOpenerObserved:true,osExternalOpenerInvoked:false,hardwareGpuQualified:false,retentionEpoch:'HVIR_M9_RETENTION_EPOCH',fixtureColumns:80,linkIntents:4,copies:[['drag','alpha'],['word','alpha'],['line','alpha beta'],['unicode-whitespace','  A界e\\u0301B  '],['all-softwrap','w'.repeat(100)],['continuous-drag','alpha']].map(([name,text])=>({name,bytes:Buffer.byteLength(text),sha256:require('node:crypto').createHash('sha256').update(text).digest('hex')})),continuous:{producedBytes:65536,copiedWhileActive:true},largeCopy:{fixtureBytes:4096*81-1,copyFinished:false,copyStale:true,refusalCode:6,inputWhilePending:false,writeWhilePending:false,userWrites:1,mutation:8},mainSamples:4,mainMaxMs:20,rendererSamples:4,rendererMaxMs:20,isolatedOsClipboardReadback:process.env.RUNNER_OS==='Linux'&&process.env.HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD==='1',clipboardIntercepted:process.env.RUNNER_OS!=='Linux'},
  readonlySelection:{gestureBlur:{pointerId:1,heldMoveButtons:1,acknowledgedDrag:true,tabChangedFocus:true,nativeFocusCleanup:true,captureReleased:true,ptyWrites:0,ptyCount:0,selectedRangePreserved:true},rendererSamples:4,rendererMaxMs:20,readonlyDrag:true,readonlyCopy:true,bytes:Buffer.byteLength('HVIR_READONLY_SELECTION'),sha256:require('node:crypto').createHash('sha256').update('HVIR_READONLY_SELECTION').digest('hex'),isolatedOsClipboardReadback:process.env.RUNNER_OS==='Linux'&&process.env.HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD==='1'},
  readonlyQuery:{retainedAfterExit:true,matches:1,exactCopy:{bytes:Buffer.byteLength('HVIR_READONLY_SELECTION'),sha256:require('node:crypto').createHash('sha256').update('HVIR_READONLY_SELECTION').digest('hex')},frames:10,maximumFrameGapMs:20},
  diagnosticPadding: 'x'.repeat(90000),
};
if(process.env.HVIR_TEST_BAD_EFFECT==='clipboard')proof.nativeEffects.clipboardWrites[1].sha256='incorrect';
if(process.env.HVIR_TEST_BAD_EFFECT==='responsiveness')proof.nativeEffects.responsiveness.main.maxMs=501;
if(process.env.HVIR_TEST_BAD_EFFECT==='disposition')proof.nativeEffects.quietAttentionEvents=3;
if(process.env.HVIR_TEST_BAD_SELECTION==='clipboard')proof.nativeSelection.copies[0].sha256='incorrect';
if(process.env.HVIR_TEST_BAD_SELECTION==='liveness')proof.nativeSelection.largeCopy.copyStale=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='authority')proof.nativeSelection.linkRootsMatched=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='responsiveness')proof.nativeSelection.mainMaxMs=501;
if(process.env.HVIR_TEST_BAD_SELECTION==='os-clipboard')proof.nativeSelection.isolatedOsClipboardReadback=!proof.nativeSelection.isolatedOsClipboardReadback;
if(process.env.HVIR_TEST_BAD_SELECTION==='readonly')proof.readonlySelection.readonlyCopy=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='pending-ack')proof.nativeSelection.pendingPressAck.ackHeldUntilOutsideUp=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='pointer-capture')proof.nativeSelection.pendingPressAck.captureReleasedAfterAck=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='readonly-cleanup')proof.readonlySelection.gestureBlur.nativeFocusCleanup=false;
if(process.env.HVIR_TEST_BAD_SELECTION==='readonly-write')proof.readonlySelection.gestureBlur.ptyWrites=1;
if(process.env.HVIR_TEST_BAD_SELECTION==='held-buttons')proof.nativeSelection.pendingPressAck.heldMoveButtons=0;
if(process.env.HVIR_TEST_BAD_QUERY==='clipboard')proof.nativeQuery.semanticCopy.sha256='incorrect';
if(process.env.HVIR_TEST_BAD_QUERY==='pixels')proof.nativeQuery.selectedHighlight.second.top=1;
if(process.env.HVIR_TEST_BAD_QUERY==='progress')proof.nativeQuery.streaming.copiedWhileProducing=false;
if(process.env.HVIR_TEST_BAD_QUERY==='responsiveness')proof.nativeQuery.maximumFrameGapMs=501;
if(process.env.HVIR_TEST_BAD_QUERY==='lost-selection')proof.nativeQuery.highMatch.observedReducedCount=12000;
if(process.env.HVIR_TEST_BAD_QUERY==='streaming-deadline')proof.nativeQuery.streaming.elapsedMs=2501;
if(process.env.HVIR_TEST_BAD_APPEARANCE==='selection')proof.nativeAppearance.palettes.light.configuredSelectionPixels=false;
if(process.env.HVIR_TEST_BAD_APPEARANCE==='geometry')proof.nativeAppearance.hiddenFontReveal.after.cellHeight=16;
if(process.env.HVIR_TEST_BAD_APPEARANCE==='cursor')proof.nativeAppearance.applicationCursorOverride=false;
if(process.env.HVIR_TEST_BAD_APPEARANCE==='unicode')proof.nativeAppearance.hiddenFontReveal.unicodeExactPointerCopy.sha256='incorrect';
const line = 'HVIR_NATIVE_WORKBENCH_OK ' + JSON.stringify(proof) + '\\n';
process.stdout.write(line.slice(0, 65536), () => {
  process.stderr.write('controlled native cleanup diagnostic\\n', () => {
    process.stdout.write(line.slice(65536));
  });
});
`,
    )
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'xvfb-run'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh
if [ "$1" = "scripts/run-smoke-scenarios.mts" ]; then
  exec "$HVIR_TEST_NODE" "$HVIR_TEST_PRODUCER"
fi
exec "$HVIR_TEST_NODE" "$@"
`,
      { mode: 0o755 },
    )
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: directory,
        RUNNER_OS: platform,
        HVIR_TEST_NODE: process.execPath,
        HVIR_TEST_PRODUCER: producer,
        HVIR_TEST_INVALID: String(invalid),
        HVIR_TEST_BAD_EFFECT: badEffect ?? '',
        HVIR_TEST_BAD_SELECTION: badSelection ?? '',
        HVIR_TEST_BAD_QUERY: badQuery ?? '',
        HVIR_TEST_BAD_APPEARANCE: badAppearance ?? '',
      },
    })
    const proof = readFileSync(
      join(directory, 'hvir-native-bindings/workbench-proof.jsonl'),
      'utf8',
    )
    return { status: result.status, error: result.error, stderr: result.stderr, proof }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('native workbench machine-readable workflow stream', () => {
  it.each([
    'clipboard',
    'pixels',
    'progress',
    'responsiveness',
    'lost-selection',
    'streaming-deadline',
  ] as const)('rejects false native retained-query evidence: %s', (kind) => {
    const result = executeQualification(
      qualification,
      'macOS',
      false,
      undefined,
      undefined,
      kind,
    )
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AssertionError')
  })
  it.each(['macOS', 'Linux'] as const)(
    'keeps interleaved %s diagnostics out of a large stdout receipt',
    (platform) => {
      const result = executeQualification(qualification, platform)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('controlled native cleanup diagnostic')
      expect(result.proof).not.toContain('controlled native cleanup diagnostic')
      expect(result.proof.length).toBeGreaterThan(65536)
      expect(result.proof.split('\n').filter(Boolean)).toHaveLength(1)
    },
  )

  it.each([
    'clipboard',
    'liveness',
    'authority',
    'responsiveness',
    'os-clipboard',
    'readonly',
    'pending-ack',
    'pointer-capture',
    'readonly-cleanup',
    'readonly-write',
    'held-buttons',
  ] as const)(
    'rejects a missing or false selection acceptance fact: %s',
    (badSelection) => {
      const result = executeQualification(
        qualification,
        'Linux',
        false,
        undefined,
        badSelection,
      )
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
    },
  )
  it.each(['selection', 'geometry', 'cursor', 'unicode'] as const)(
    'rejects an incorrect native appearance %s fact with the actual workflow reader',
    (kind) => {
      const result = executeQualification(
        qualification,
        'macOS',
        false,
        undefined,
        undefined,
        undefined,
        kind,
      )
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('AssertionError')
    },
  )
  it('reproduces corruption when diagnostic stderr is merged before the strict reader', () => {
    const merged = qualification.replace(
      '2> >(tee "$RUNNER_TEMP/hvir-native-trace/original.stderr.log" >&2)',
      '2>&1',
    )
    expect(merged).not.toBe(qualification)
    const result = executeQualification(merged, 'macOS')
    expect(result.status).not.toBe(0)
    expect(result.proof).toContain('controlled native cleanup diagnostic')
    const firstLine = result.proof.split('\n')[0]!
    expect(() => {
      JSON.parse(firstLine.slice('HVIR_NATIVE_WORKBENCH_OK '.length))
    }).toThrow(SyntaxError)
  })

  it('retains the workflow acceptance assertions after separating diagnostic output', () => {
    const result = executeQualification(qualification, 'macOS', true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AssertionError')
  })
  it.each(['clipboard', 'responsiveness', 'disposition'] as const)(
    'rejects an incorrect native effect %s proof with the actual reader',
    (kind) => {
      const result = executeQualification(qualification, 'macOS', false, kind)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('AssertionError')
      const line = result.proof
        .split('\n')
        .find((value) => value.startsWith('HVIR_NATIVE_WORKBENCH_OK '))!
      expect(() => {
        JSON.parse(line.slice('HVIR_NATIVE_WORKBENCH_OK '.length))
      }).not.toThrow()
    },
  )
})
