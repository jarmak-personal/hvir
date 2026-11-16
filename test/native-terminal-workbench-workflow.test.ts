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

interface TimingFixture {
  mode: 'evidence' | 'controlled'
  crossing?:
    | 'query'
    | 'readonly-query'
    | 'selection'
    | 'readonly-selection'
    | 'effects'
    | 'paste-unicode'
    | 'paste-lnm'
  fault?:
    | 'missing-mode'
    | 'invalid-mode'
    | 'omit-violation'
    | 'invent-violation'
    | 'round-maximum'
    | 'missing-phase'
    | 'raised-limit'
    | 'invalid-samples'
    | 'invalid-maximum'
    | 'capacity-claim'
    | 'wrong-minimum'
    | 'missing-loop'
    | 'phase-limit'
    | 'unsafe-samples'
    | 'negative-maximum'
}

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
  badAppearance?: 'selection' | 'geometry' | 'cursor' | 'unicode' | 'context',
  badLifetime?:
    | 'identity'
    | 'authority'
    | 'resource'
    | 'refit'
    | 'recovery'
    | 'ssh-input'
    | 'ssh-resource',
  timing?: TimingFixture,
) {
  const directory = mkdtempSync(join(tmpdir(), 'hvir-native-workbench-report-'))
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    mkdirSync(join(directory, 'hvir-native-bindings'))
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
  nativeAppearance:{fractionalScale:{refitCanvas:{eligible:true,retained:true},cursor:{shape:'underline',pixels:16},before:1,after:1.25,currentDraw:true},actualNative:true,initialFontAppliedBeforeDraw:true,restoredBuiltinPalettePixels:true,samePty:true,gallery:{cancel:true,pairedSave:true},cursorShapes:['block','hollow-block','bar','underline'],cursorQueryCodes:[2,2,6,4],applicationCursorOverride:true,ligatureSettings:{onOff:true,exactPointerCopy:true},hardwareQualified:false,palettes:Object.fromEntries(['dark','light'].map(theme=>[theme,{queryRepliesExact:true,configuredSelectionPixels:true,samples:{background:100,foreground:100,green:100,blue:100}}])),hiddenFontReveal:{missingFamilyFallback:true,currentDraw:true,before:{serial:2,cellHeight:16},after:{serial:3,cellHeight:22,rows:20,columns:80},stty:{rows:20,columns:80},unicodeExactPointerCopy:{bytes:Buffer.byteLength('漢字🙂 e\\u0301'),sha256:require('node:crypto').createHash('sha256').update('漢字🙂 e\\u0301').digest('hex')}}},
  nativeEffects:{phases:10,causalEventSerials:true,titleProductDelivery:true,remoteCwdCopied:true,readQueriesRefused:true,newClipboardProtocolsRefused:true,queriesExact:true,linkUserIntentPortHostCorrect:true,semanticObservations:4,semanticOccurrenceIdentityQualified:false,linkGestureQualified:false,hardwareQualified:false,nativeOsActionsQualified:false,osc777AndProgressDisposition:'ignored',quietAttentionEvents:2,clipboardWrites:['native-effects','a'.repeat(49152)].map(text=>({bytes:Buffer.byteLength(text),sha256:require('node:crypto').createHash('sha256').update(text).digest('hex')})),responsiveness:{maximumMs:500,main:{samples:4,maxMs:10},renderer:{samples:4,maxMs:18}}},
  nativeSelection:{pendingPressAck:{pointerId:1,heldMoveButtons:1,trustedOutsideMove:true,trustedOutsideUp:true,ackHeldUntilOutsideUp:true,nativeOriginalViewOrder:true,captureReleasedBeforeAck:true,captureReleasedAfterAck:true,exactSelectedBytes:5,exactSelectedSha256:require('node:crypto').createHash('sha256').update('alpha').digest('hex')},samePty:true,originalReadyBeforeClear:true,clearScreenScrollback:true,resetTerminal:true,parserInputAlive:true,drag:true,word:true,line:true,unicodeWhitespace:true,softwrap:true,selectAll:true,menu:true,metaCopy:true,controlShiftCopy:true,fileUriAndPlainIntent:true,linkRootsMatched:true,loopbackRouteContent:true,externalOpenerObserved:true,osExternalOpenerInvoked:false,hardwareGpuQualified:false,retentionEpoch:'HVIR_M9_RETENTION_EPOCH',fixtureColumns:80,linkIntents:4,copies:[['drag','alpha'],['word','alpha'],['line','alpha beta'],['unicode-whitespace','  A界e\\u0301B  '],['all-softwrap','w'.repeat(100)],['continuous-drag','alpha']].map(([name,text])=>({name,bytes:Buffer.byteLength(text),sha256:require('node:crypto').createHash('sha256').update(text).digest('hex')})),continuous:{producedBytes:65536,copiedWhileActive:true},largeCopy:{fixtureBytes:4096*81-1,copyFinished:false,copyStale:true,refusalCode:6,inputWhilePending:false,writeWhilePending:false,userWrites:1,mutation:8},mainSamples:4,mainMaxMs:20,rendererSamples:4,rendererMaxMs:20,isolatedOsClipboardReadback:process.env.RUNNER_OS==='Linux'&&process.env.HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD==='1',clipboardIntercepted:process.env.RUNNER_OS!=='Linux'},
  readonlySelection:{gestureBlur:{pointerId:1,heldMoveButtons:1,acknowledgedDrag:true,tabChangedFocus:true,nativeFocusCleanup:true,captureReleased:true,ptyWrites:0,ptyCount:0,selectedRangePreserved:true},rendererSamples:4,rendererMaxMs:20,readonlyDrag:true,readonlyCopy:true,bytes:Buffer.byteLength('HVIR_READONLY_SELECTION'),sha256:require('node:crypto').createHash('sha256').update('HVIR_READONLY_SELECTION').digest('hex'),isolatedOsClipboardReadback:process.env.RUNNER_OS==='Linux'&&process.env.HVIR_NATIVE_TERMINAL_ISOLATED_CLIPBOARD==='1'},
  readonlyQuery:{retainedAfterExit:true,matches:1,exactCopy:{bytes:Buffer.byteLength('HVIR_READONLY_SELECTION'),sha256:require('node:crypto').createHash('sha256').update('HVIR_READONLY_SELECTION').digest('hex')},frames:10,maximumFrameGapMs:20},
  nativeLifetimes:{samePty:true,sameNativeState:true,hiddenOutput:true,realSessionsHandoff:true,realHostQualified:false,hiddenInputRefusals:3,cycles:[0,1,2].map(cycle=>({cycle,canvases:1,queuedReplyBytes:0,serial:cycle+1}))},
  nativeFailureLifetimes:{additionalLaunches:3,explicitRestart:true,readonlyInstanceRetired:true,explicitRecoveryDecision:true,pendingNativeInputLoss:{sent:true,rejected:true,observedEpoch:true},splitClosed:true,documentReplacement:true,oldOwnerRejected:true,samePtyOnDocumentReplacement:true,rejectedRefit:true,noReplacementGrantOnRefusal:true,mainUnavailableCanResume:true,staleFailureIgnored:true,nativeHostLoss:true,lostReadRejected:true,silentRelaunches:0,explicitClose:true,contextLoss:{eligible:true,parserPreserved:true},final:{livePtys:0,nativeSessionPresent:false,canvases:0},realHostQualified:false,hardwareQualified:false},
  nativeSshLifetimes:{ordinaryTerminalUi:true,realSsh2Transport:true,realNativeParser:true,syntheticFilesystemMetadata:true,syntheticRemoteProgram:true,sameNamedHostPathsIsolated:true,hiddenOutputAndReply:true,ordinaryWorkspaceNavigation:true,ordinarySessionsHandoff:true,controlReconnectRetainedPty:true,terminalDisconnectRetainedParser:true,explicitUiClose:true,returnedInputLease:true,externalSshHostQualified:false,remoteOsPtyQualified:false,sharedNativeHostLossQualified:false,inputBytes:43,replyBytes:4,inputAndReplySha256:require('node:crypto').createHash('sha256').update('hvir-m13-ssh-input\\x1b[0nhvir-m13-ssh-return-input').digest('hex'),terminalStarts:1,remainingConnections:0,remainingChannels:0,remainingHostTransports:0},
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
if(process.env.HVIR_TEST_BAD_APPEARANCE==='context')proof.nativeAppearance.fractionalScale.refitCanvas.retained=false;
if(process.env.HVIR_TEST_BAD_APPEARANCE==='unicode')proof.nativeAppearance.hiddenFontReveal.unicodeExactPointerCopy.sha256='incorrect';
if(process.env.HVIR_TEST_BAD_LIFETIME==='ssh-input')proof.nativeSshLifetimes.inputAndReplySha256='incorrect';
if(process.env.HVIR_TEST_BAD_LIFETIME==='ssh-resource')proof.nativeSshLifetimes.remainingHostTransports=1;
if(process.env.HVIR_TEST_BAD_LIFETIME==='identity')proof.nativeLifetimes.sameNativeState=false;
if(process.env.HVIR_TEST_BAD_LIFETIME==='authority')proof.nativeFailureLifetimes.oldOwnerRejected=false;
if(process.env.HVIR_TEST_BAD_LIFETIME==='resource')proof.nativeFailureLifetimes.final.canvases=1;
if(process.env.HVIR_TEST_BAD_LIFETIME==='refit')proof.nativeFailureLifetimes.noReplacementGrantOnRefusal=false;
if(process.env.HVIR_TEST_BAD_LIFETIME==='recovery')proof.nativeFailureLifetimes.silentRelaunches=1;
proof.largePaste={cases:['unicode','lnm'].map(name=>({name,paint:{frames:4,maxGapMs:20}}))};
const timingMode=process.env.HVIR_CAPACITY_PERFORMANCE_GATE==='controlled'?'controlled':'evidence';
const crossing=process.env.HVIR_TEST_TIMING_CROSSING;
if(crossing==='query')proof.nativeQuery.maximumFrameGapMs=518.5;
if(crossing==='readonly-query')proof.readonlyQuery.maximumFrameGapMs=518.5;
if(crossing==='selection')proof.nativeSelection.rendererMaxMs=518.5;
if(crossing==='readonly-selection')proof.readonlySelection.rendererMaxMs=518.5;
if(crossing==='effects')proof.nativeEffects.responsiveness.main.maxMs=518.5;
if(crossing==='paste-unicode')proof.largePaste.cases[0].paint.maxGapMs=518.5;
if(crossing==='paste-lnm')proof.largePaste.cases[1].paint.maxGapMs=518.5;
if(process.env.HVIR_TEST_TIMING_FAULT==='invalid-samples')proof.nativeQuery.frames=0;
if(process.env.HVIR_TEST_TIMING_FAULT==='invalid-maximum')proof.nativeQuery.maximumFrameGapMs=NaN;
if(process.env.HVIR_TEST_TIMING_FAULT==='negative-maximum')proof.nativeQuery.maximumFrameGapMs=-1;
if(process.env.HVIR_TEST_TIMING_FAULT==='unsafe-samples')proof.nativeQuery.frames=1e20;
const renderer=(samples,minimumSamples,maximumMs)=>({loop:'renderer',samples,minimumSamples,maximumMs});
const main=(samples,minimumSamples,maximumMs)=>({loop:'main',samples,minimumSamples,maximumMs});
const phases=[
 ['query',[renderer(proof.nativeQuery.frames,2,proof.nativeQuery.maximumFrameGapMs)]],
 ['effects',[main(proof.nativeEffects.responsiveness.main.samples,2,proof.nativeEffects.responsiveness.main.maxMs),renderer(proof.nativeEffects.responsiveness.renderer.samples,2,proof.nativeEffects.responsiveness.renderer.maxMs)]],
 ['selection',[main(proof.nativeSelection.mainSamples,1,proof.nativeSelection.mainMaxMs),renderer(proof.nativeSelection.rendererSamples,1,proof.nativeSelection.rendererMaxMs)]],
 ...proof.largePaste.cases.map(item=>['paste-'+item.name,[renderer(item.paint.frames,1,item.paint.maxGapMs)]]),
 ['readonly-selection',[renderer(proof.readonlySelection.rendererSamples,2,proof.readonlySelection.rendererMaxMs)]],
 ['readonly-query',[renderer(proof.readonlyQuery.frames,2,proof.readonlyQuery.maximumFrameGapMs)]],
].map(([phase,loops])=>({phase,mode:timingMode,maximumInclusiveMs:500,loops,violations:loops.filter(item=>item.maximumMs>500).map(item=>({loop:item.loop,actualMs:item.maximumMs,maximumInclusiveMs:500}))}));
proof.performance={mode:timingMode,maximumInclusiveMs:500,controlledCapacityQualified:false,phases};
const timingFault=process.env.HVIR_TEST_TIMING_FAULT;
if(timingFault==='missing-mode')delete proof.performance.mode;
if(timingFault==='invalid-mode')proof.performance.mode='automatic';
if(timingFault==='omit-violation')phases.find(item=>item.violations.length).violations=[];
if(timingFault==='invent-violation')phases[0].violations=[{loop:'renderer',actualMs:501,maximumInclusiveMs:500}];
if(timingFault==='round-maximum')phases.find(item=>item.violations.length).loops[0].maximumMs=500;
if(timingFault==='missing-phase')phases.pop();
if(timingFault==='raised-limit')proof.performance.maximumInclusiveMs=501;
if(timingFault==='capacity-claim')proof.performance.controlledCapacityQualified=true;
if(timingFault==='wrong-minimum')phases[0].loops[0].minimumSamples=1;
if(timingFault==='missing-loop')phases.find(item=>item.phase==='effects').loops.pop();
if(timingFault==='phase-limit')phases[0].maximumInclusiveMs=501;
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
        HVIR_TEST_BAD_LIFETIME: badLifetime ?? '',
        HVIR_CAPACITY_PERFORMANCE_GATE: timing?.mode === 'controlled' ? 'controlled' : '',
        HVIR_TEST_TIMING_CROSSING: timing?.crossing ?? '',
        HVIR_TEST_TIMING_FAULT: timing?.fault ?? '',
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
  const timingResult = (timing: TimingFixture) =>
    executeQualification(
      qualification,
      'macOS',
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      timing,
    )
  it.each([
    'query',
    'readonly-query',
    'selection',
    'readonly-selection',
    'effects',
    'paste-unicode',
    'paste-lnm',
  ] as const)(
    'retains hosted %s crossings as exact evidence and enforces the same 500 ms controlled limit',
    (phase) => {
      const hosted = timingResult({ mode: 'evidence', crossing: phase })
      expect(hosted.error).toBeUndefined()
      expect(hosted.status).toBe(0)
      const receipt = JSON.parse(hosted.proof.split('HVIR_NATIVE_WORKBENCH_OK ')[1]!) as {
        performance: {
          phases: Array<{
            phase: string
            violations: Array<{ actualMs: number; maximumInclusiveMs: number }>
          }>
        }
      }
      expect(
        receipt.performance.phases.find((item) => item.phase === phase)?.violations,
      ).toEqual([
        {
          loop: phase === 'effects' ? 'main' : 'renderer',
          actualMs: 518.5,
          maximumInclusiveMs: 500,
        },
      ])
      const controlled = timingResult({ mode: 'controlled', crossing: phase })
      expect(controlled.status).not.toBe(0)
      expect(controlled.stderr).toContain('AssertionError')
    },
  )
  it.each([
    'missing-mode',
    'invalid-mode',
    'omit-violation',
    'invent-violation',
    'round-maximum',
    'missing-phase',
    'raised-limit',
    'invalid-samples',
    'invalid-maximum',
    'capacity-claim',
    'wrong-minimum',
    'missing-loop',
    'phase-limit',
    'unsafe-samples',
    'negative-maximum',
  ] as const)('rejects malformed or dishonest performance evidence: %s', (fault) => {
    const result = timingResult({
      mode: 'evidence',
      fault,
      crossing:
        fault === 'omit-violation' || fault === 'round-maximum' ? 'query' : undefined,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AssertionError')
  })
  it.each(['clipboard', 'pixels', 'progress', 'streaming-deadline'] as const)(
    'keeps controlled functional query facts blocking: %s',
    (fault) => {
      const result = executeQualification(
        qualification,
        'macOS',
        false,
        undefined,
        undefined,
        fault,
        undefined,
        undefined,
        { mode: 'controlled' },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('AssertionError')
    },
  )

  it.each([
    'identity',
    'authority',
    'resource',
    'refit',
    'recovery',
    'ssh-input',
    'ssh-resource',
  ] as const)('rejects false lifecycle evidence: %s', (kind) => {
    const result = executeQualification(
      qualification,
      'macOS',
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      kind,
    )
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AssertionError')
  })
  it.each([
    'clipboard',
    'pixels',
    'progress',
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
  it.each(['selection', 'geometry', 'cursor', 'unicode', 'context'] as const)(
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
    const merged = qualification.replaceAll(
      'native-terminal-workbench \\\n',
      'native-terminal-workbench 2>&1 \\\n',
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
  it.each(['clipboard', 'disposition'] as const)(
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
