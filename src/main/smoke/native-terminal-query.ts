import { app, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import { CAPACITY_PERFORMANCE_BUDGETS } from './capacity-performance'
import {
  clipboardInstall,
  nativeSelectionBrowser,
  paneScript,
} from './native-terminal-selection-browser'
import { NATIVE_READONLY_SELECTION } from './native-terminal-selection-fixture'
import {
  terminalSearchEvictionProducer,
  terminalSearchStreamProducer,
} from './terminal-search-stream-producer'

const MATCH = 'hvir-native-query-match'
const FIND_BAR_SHADOW_CLEARANCE = 24

/** Real retained-query controls and pixels on the same native workbench Surface. */
export async function verifyNativeTerminalQuery(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const browser = nativeSelectionBrowser(win, native, managed)
  const diagnostics =
    typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
    __HVIR_SMOKE_BUILD__ &&
    !!process.env['HVIR_SMOKE']
  const scope = paneScript(managed.id)
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async()=>{${scope}${body}})()`) as Promise<T>
  const click = (label: string) =>
    evaluate(
      `const button=panel.querySelector('button[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-query-action-unavailable');button.click();`,
    )
  const status = () =>
    evaluate<string>(
      `return panel.querySelector('.terminal-search-status')?.textContent?.trim()??'';`,
    )
  const query = (text: string) =>
    evaluate(
      `const query=panel.querySelector('[aria-label="Find in terminal"]');if(!(query instanceof HTMLInputElement))throw new Error('native-query-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(query,${JSON.stringify(text)});query.dispatchEvent(new Event('input',{bubbles:true}));`,
    )
  await browser.ready()
  if (diagnostics) {
    const initialLayout = await browser.layout()
    console.error('HVIR_NATIVE_QUERY_INITIAL_LAYOUT', {
      geometry: initialLayout.geometry,
      canvas: {
        width: initialLayout.bounds.canvasWidth,
        height: initialLayout.bounds.canvasHeight,
        cssWidth: initialLayout.bounds.canvasCssWidth,
        cssHeight: initialLayout.bounds.canvasCssHeight,
        dpr: initialLayout.bounds.dpr,
      },
    })
  }
  await browser.focus()
  await browser.menu('Clear Screen and Scrollback')
  await win.webContents.executeJavaScript(clipboardInstall(false))
  let phase = 'initial-query'
  try {
    await evaluate(
      `input.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',shiftKey:true,...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true}),bubbles:true,cancelable:true}));`,
    )
    await browser.wait(
      () => evaluate(`return !!panel.querySelector('.terminal-search');`),
      'query-open',
    )
    // This pixel fixture samples the leftmost 23 cells, including historical
    // reveals at viewport top. Keep that stripe outside the Find bar's shadow;
    // a narrow-window overlap is presentation occlusion, not a native mask.
    const pixelFixture = await queryPixelFixture(browser, evaluate)
    // Seed after accommodation so reflow cannot move this left-edge pixel fixture.
    await ptys.writeConfirmed(
      managed.id,
      managed.ownerId,
      `hvir_native_query='hvir-native-''query-match'; printf '\\033[H\\r\\n%s\\r\\n%s\\r\\n%s\\r\\n' "$hvir_native_query" "$hvir_native_query" "$hvir_native_query"\r`,
      managed.ownerGeneration,
    )
    await query(MATCH)
    await browser.wait(
      async () => ['1 of 3', '3 matches'].includes(await status()),
      'query-three',
    )
    await browser.wait(async () => (await status()) === '1 of 3', 'query-first')
    const first = await selectedHighlight(win, managed.id, browser)
    await click('Next terminal match')
    await browser.wait(async () => (await status()) === '2 of 3', 'query-next')
    const second = await selectedHighlight(win, managed.id, browser, first)
    await click('Previous terminal match')
    await browser.wait(async () => (await status()) === '1 of 3', 'query-previous')
    const returned = await selectedHighlight(win, managed.id, browser, second)
    if (
      Math.abs(first.top - returned.top) > 1 ||
      Math.abs(first.left - returned.left) > 1
    )
      throw new Error('native-query-highlight-did-not-return')
    const copy = await browser.copied(
      MATCH,
      () =>
        evaluate(
          `const button=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match');if(!(button instanceof HTMLButtonElement))throw new Error('native-query-copy');button.click();`,
        ),
      false,
    )
    phase = 'selected-movement'
    // True row movement preserves the selected occurrence; no navigation/reveal
    // action occurs between the parser edit and observing its native pixels.
    await ptys.writeConfirmed(
      managed.id,
      managed.ownerId,
      `printf '\\0337\\033[1;1H\\033[L\\0338'\r`,
      managed.ownerGeneration,
    )
    const moved = await selectedHighlight(win, managed.id, browser, returned)
    if (moved.top <= returned.top || (await status()) !== '1 of 3')
      throw new Error('native-query-selected-row-did-not-follow-insert')
    const movedCopy = await browser.copied(
      MATCH,
      () =>
        evaluate(
          `const button=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match');if(!(button instanceof HTMLButtonElement))throw new Error('native-query-moved-copy');button.click();`,
        ),
      false,
    )
    await click('Close terminal search')
    phase = 'streaming-setup'
    // Match the existing streaming fixture: selected occurrences are already
    // retained history before the producer and acquisition clock begin.
    let setupOutput = ''
    const setupMarker = '__HVIR_M10_STREAM_SETUP__'
    const detachSetup = ptys.attach(managed.id, managed.ownerId, {
      onData: (data) => {
        setupOutput = (setupOutput + data).slice(-8192)
      },
    })
    try {
      const setupDeadline = performance.now() + 3000
      await ptys.writeConfirmed(
        managed.id,
        managed.ownerId,
        `hvir_m10_setup='__HVIR_M10_STREAM_''SETUP__'; hvir_m10_i=0; while [ "$hvir_m10_i" -lt 120 ]; do printf 'history filler\\r\\n'; hvir_m10_i=$((hvir_m10_i+1)); done; printf '%s\\r\\n' "$hvir_m10_setup"\r`,
        managed.ownerGeneration,
      )
      await browser.wait(() => {
        if (performance.now() > setupDeadline)
          throw new Error('native-query-stream-setup-deadline')
        return setupOutput.includes(setupMarker)
      }, 'query-stream-setup')
    } finally {
      await detachSetup()
    }
    phase = 'streaming-evidence'
    // The unchanged canonical streaming clock includes its own fresh acquisition.
    const streamingStarted = performance.now(),
      streamingDeadline = streamingStarted + 2500
    await evaluate(
      `input.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',shiftKey:true,...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true}),bubbles:true,cancelable:true}));`,
    )
    await browser.wait(
      () => evaluate(`return !!panel.querySelector('.terminal-search');`),
      'query-stream-open',
    )
    await query(MATCH)
    await browser.wait(
      async () => ['1 of 3', '3 matches'].includes(await status()),
      'query-stream-three',
    )
    await browser.wait(async () => (await status()) === '1 of 3', 'query-stream-first')
    await click('Next terminal match')
    await browser.wait(async () => (await status()) === '2 of 3', 'query-stream-second')
    const streamingSelected = await selectedHighlight(win, managed.id, browser)
    const checkpoints = {
      acquiredMs: performance.now() - streamingStarted,
      countMs: 0,
      pixelsMs: 0,
      copyMs: 0,
      previousClickedMs: 0,
      previousMs: 0,
      nextClickedMs: 0,
    }
    const producerMilestones = {
      submitted: false,
      submittedAtMs: null as number | null,
      writeAckAtMs: null as number | null,
      firstFillerAtMs: null as number | null,
      firstMatchAtMs: null as number | null,
      completedAtMs: null as number | null,
      maximumFillerOrdinal: -1,
    }
    let streamOutput = '',
      streamCompleted = false
    const streamDetach = ptys.attach(managed.id, managed.ownerId, {
      onData: (data) => {
        streamOutput = (streamOutput + data).slice(-8192)
        streamCompleted ||= streamOutput.includes('__HVIR_M10_STREAM_DONE__')
        if (diagnostics && producerMilestones.submitted) {
          const elapsedMs = performance.now() - streamingStarted
          for (const match of streamOutput.matchAll(
            /(?:^|[\r\n])stream filler ([0-9]{1,3})(?=[\r\n])/g,
          )) {
            const ordinal = Number(match[1])
            if (ordinal < 150) {
              producerMilestones.firstFillerAtMs ??= elapsedMs
              producerMilestones.maximumFillerOrdinal = Math.max(
                producerMilestones.maximumFillerOrdinal,
                ordinal,
              )
            }
          }
          if (('\n' + streamOutput.replaceAll('\r', '')).includes('\n' + MATCH + '\n'))
            producerMilestones.firstMatchAtMs ??= elapsedMs
          if (streamCompleted) producerMilestones.completedAtMs ??= elapsedMs
        }
      },
    })
    // Attach can synchronously replay launch output. Fence this producer's
    // observations after attachment and before submitting its command.
    streamOutput = ''
    streamCompleted = false
    let streaming: {
      elapsedMs: number
      evidenceBudgetMs: number
      completionBudgetMs: number
      selectedIndex: number
      copiedWhileProducing: boolean
    }
    const withinStreaming = () => {
      if (performance.now() > streamingDeadline)
        throw new Error(
          'native-query-streaming-absolute-deadline ' +
            JSON.stringify({
              elapsedMs: performance.now() - streamingStarted,
              ...checkpoints,
            }),
        )
      if (streamCompleted)
        throw new Error('native-query-streaming-evidence-after-producer')
    }
    try {
      producerMilestones.submitted = true
      producerMilestones.submittedAtMs = performance.now() - streamingStarted
      await ptys.writeConfirmed(
        managed.id,
        managed.ownerId,
        `hvir_m10_stream_done='__HVIR_M10_STREAM_''DONE__'; ${terminalSearchStreamProducer({ matchVariable: 'hvir_native_query', doneVariable: 'hvir_m10_stream_done', lineEnding: 'crlf' })}\r`,
        managed.ownerGeneration,
      )
      producerMilestones.writeAckAtMs = performance.now() - streamingStarted
      await browser.wait(async () => {
        withinStreaming()
        return (await status()) === '2 of 4'
      }, 'query-stream-count')
      checkpoints.countMs = performance.now() - streamingStarted
      for (let index = 0; index < 12; index++) {
        withinStreaming()
        if ((await status()) !== '2 of 4')
          throw new Error('native-query-stream-selection-changed')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const stable = await selectedHighlight(win, managed.id, browser)
      checkpoints.pixelsMs = performance.now() - streamingStarted
      if (
        ['top', 'left', 'right', 'bottom'].some(
          (axis) =>
            Math.abs(
              stable[axis as keyof Highlight] -
                streamingSelected[axis as keyof Highlight],
            ) > 1,
        )
      )
        throw new Error('native-query-stream-viewport-changed')
      withinStreaming()
      await browser.copied(
        MATCH,
        () =>
          evaluate(
            `const button=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match');if(!(button instanceof HTMLButtonElement))throw new Error('native-query-stream-copy');button.click();`,
          ),
        false,
      )
      checkpoints.copyMs = performance.now() - streamingStarted
      withinStreaming()
      await click('Previous terminal match')
      checkpoints.previousClickedMs = performance.now() - streamingStarted
      await browser.wait(async () => {
        withinStreaming()
        return (await status()) === '1 of 4'
      }, 'query-stream-previous')
      checkpoints.previousMs = performance.now() - streamingStarted
      await click('Next terminal match')
      checkpoints.nextClickedMs = performance.now() - streamingStarted
      await browser.wait(async () => {
        withinStreaming()
        return (await status()) === '2 of 4'
      }, 'query-stream-next')
      streaming = {
        elapsedMs: performance.now() - streamingStarted,
        evidenceBudgetMs: 2500,
        completionBudgetMs: 7000,
        selectedIndex: 1,
        copiedWhileProducing: true,
      }
      const completionDeadline = performance.now() + 7000
      await browser.wait(() => {
        if (performance.now() > completionDeadline)
          throw new Error('native-query-stream-completion-deadline')
        return streamCompleted
      }, 'query-stream-completion')
    } catch (error) {
      if (diagnostics) {
        try {
          console.error('HVIR_NATIVE_QUERY_STREAM_PRODUCER_FAILURE', {
            ...producerMilestones,
            elapsedMs: performance.now() - streamingStarted,
          })
        } catch {
          /* Keep the original qualification failure. */
        }
      }
      throw error
    } finally {
      await streamDetach()
    }
    await click('Close terminal search')
    phase = 'semantic-query'
    // Genuine parser boundaries, current-body extraction, and native viewport reveal.
    await browser.menu('Clear Screen and Scrollback')
    await ptys.writeConfirmed(
      managed.id,
      managed.ownerId,
      `printf '\\033]133;A\\007prompt\\r\\n\\033]133;B\\007command\\r\\n\\033]133;C\\007output\\r\\n\\033]133;D;0\\007'\r`,
      managed.ownerGeneration,
    )
    await browser.wait(
      () =>
        evaluate(
          `return panel.querySelector('.terminal-container')?.getAttribute('data-terminal-semantic-regions')==='3';`,
        ),
      'query-semantic-regions',
    )
    await click('Previous transcript region')
    await browser.wait(
      () =>
        evaluate(
          `return panel.querySelector('.terminal-semantic-region')?.textContent?.trim()==='Output 3 of 3';`,
        ),
      'query-output-region',
    )
    await click('Previous transcript region')
    await browser.wait(
      () =>
        evaluate(
          `return panel.querySelector('.terminal-semantic-region')?.textContent?.trim()==='Command 2 of 3';`,
        ),
      'query-command-region',
    )
    await click('Next transcript region')
    await browser.wait(
      () =>
        evaluate(
          `return panel.querySelector('.terminal-semantic-region')?.textContent?.trim()==='Output 3 of 3';`,
        ),
      'query-next-region',
    )
    await evaluate(
      `input.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',shiftKey:true,...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true}),bubbles:true,cancelable:true}));`,
    )
    await browser.wait(
      () => evaluate(`return !!panel.querySelector('.terminal-search');`),
      'query-region-copy-open',
    )
    const semanticCopy = await browser.copied(
      'output\n',
      () =>
        evaluate(
          `const button=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Semantic Region');if(!(button instanceof HTMLButtonElement))throw new Error('native-query-semantic-copy');button.click();`,
        ),
      false,
    )
    phase = 'high-match-setup'
    // Broad native metadata stays indexed while a finite 50 Hz producer continues.
    let output = '',
      completed = false
    let highProducerStarted = 0,
      highLine = '',
      highLineOverflow = false
    const highProducer = {
      submitted: false,
      submittedAtMs: null as number | null,
      writeAckAtMs: null as number | null,
      firstRowAtMs: null as number | null,
      completedAtMs: null as number | null,
      rows: 0,
    }
    const memoryKiB = () => {
      const value = app
        .getAppMetrics()
        .find((metric) => metric.pid === win.webContents.getOSProcessId())
        ?.memory.workingSetSize
      if (value === undefined || !Number.isFinite(value) || value <= 0)
        throw new Error('native-query-renderer-memory-unavailable')
      return value
    }
    const beforeKiB = memoryKiB()
    const detach = ptys.attach(managed.id, managed.ownerId, {
      onData: (data) => {
        output = (output + data).slice(-8192)
        completed ||= output.includes('__HVIR_M10_DONE__')
        if (diagnostics && highProducer.submitted) {
          const elapsedMs = performance.now() - highProducerStarted
          for (const character of data) {
            if (character === '\n') {
              if (
                !highLineOverflow &&
                highLine.replace(/\r+$/, '') === 'unrelated output'
              ) {
                highProducer.rows++
                highProducer.firstRowAtMs ??= elapsedMs
              }
              highLine = ''
              highLineOverflow = false
            } else if (highLine.length < 64) highLine += character
            else highLineOverflow = true
          }
          if (completed) highProducer.completedAtMs ??= elapsedMs
        }
      },
    })
    let highMatch: {
      initial: number
      observedReducedCount: number
      observedAtMs: number
      observationWindowMs: number
      latestCount: number
      latestStatus: string
      latestAtMs: number
      selectionUnavailable: boolean
      sameOpenQuery: boolean
      removal: string
      rendererGrowthKiB: number
    }
    try {
      const highStarted = performance.now()
      const highSetupMarker = '__HVIR_M10_HIGH_SETUP__'
      try {
        await ptys.writeConfirmed(
          managed.id,
          managed.ownerId,
          `hvir_m10_high_setup='__HVIR_M10_HIGH_''SETUP__'; hvir_m10_hit='hvir-m10-''hit'; hvir_m10_i=0; while [ "$hvir_m10_i" -lt 1500 ]; do printf '%s %s %s %s %s %s %s %s\\r\\n' "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit" "$hvir_m10_hit"; hvir_m10_i=$((hvir_m10_i+1)); done; printf '%s\\r\\n' "$hvir_m10_high_setup"\r`,
          managed.ownerGeneration,
        )
        await browser.wait(() => output.includes(highSetupMarker), 'query-high-setup')
        await query('hvir-m10-hit')
        await browser.wait(
          async () => (await status()) === '1 of 12000',
          'query-high-match',
        )
      } catch (cause) {
        const observed = await evaluate<{
          status: string
          count: number
          unavailable: boolean
        }>(
          `const search=panel.querySelector('.terminal-search');const status=search?.querySelector('.terminal-search-status')?.textContent?.trim()??'';return{status,count:Number(status.match(/of ([0-9]+)/)?.[1]??status.match(/^([0-9]+) matches$/)?.[1]??0),unavailable:!!search?.querySelector('.terminal-search-unavailable')};`,
        ).catch(() => undefined)
        const columns = await browser.layout().then(
          (value) => value.geometry.columns,
          () => undefined,
        )
        throw new Error(
          'native-query-high-initial-observation ' +
            JSON.stringify({
              observed,
              columns,
              setupCompleted: output.includes(highSetupMarker),
              elapsedMs: performance.now() - highStarted,
            }),
          { cause },
        )
      }
      phase = 'high-match-selection'
      await click('Next terminal match')
      await browser.wait(
        async () => (await status()) === '2 of 12000',
        'query-high-match-next',
      )
      await evaluate(
        `window.nativeSelectionProbe.retainedSearch=panel.querySelector('.terminal-search');`,
      )
      phase = 'high-match-producer'
      // Ignore any synchronous replay/setup output before this producer starts.
      output = ''
      completed = false
      highLine = ''
      highLineOverflow = false
      highProducerStarted = performance.now()
      highProducer.submitted = true
      highProducer.submittedAtMs = 0
      await ptys.writeConfirmed(
        managed.id,
        managed.ownerId,
        `hvir_m10_done='__HVIR_M10_''DONE__'; ${terminalSearchEvictionProducer({ doneVariable: 'hvir_m10_done', lineEnding: 'crlf' })}\r`,
        managed.ownerGeneration,
      )
      highProducer.writeAckAtMs = performance.now() - highProducerStarted
      phase = 'high-match-observation'
      let observedReducedCount = 0,
        observedAtMs = 0
      const highMatchStarted = performance.now()
      const observe = () =>
        evaluate<{ unavailable: boolean; count: number; status: string }>(
          `const search=panel.querySelector('.terminal-search');if(search!==window.nativeSelectionProbe.retainedSearch||search?.querySelector('[aria-label="Find in terminal"]')?.value!=='hvir-m10-hit')throw new Error('native-query-loss-replaced-open-query');const text=search.querySelector('.terminal-search-status')?.textContent??'';const match=text.match(/^([0-9]+) match(?:es)?$/);const status=match?'unselected':text==='No matches'?'empty':text==='Searching…'?'pending':'unexpected';return{unavailable:!!search.querySelector('.terminal-search-unavailable'),count:Number(match?.[1]??0),status};`,
        )
      await browser.wait(async () => {
        const observed = await observe()
        if (completed) throw new Error('native-query-progress-arrived-after-producer')
        if (
          !observedReducedCount &&
          observed.unavailable &&
          observed.count > 0 &&
          observed.count < 12000
        ) {
          observedReducedCount = observed.count
          observedAtMs = performance.now() - highMatchStarted
        }
        return observedReducedCount > 0 && performance.now() - highMatchStarted >= 3000
      }, 'query-removed-scrollback-progress')
      const observationWindowMs = performance.now() - highMatchStarted
      await browser.wait(() => completed, 'query-producer-completion')
      const latest = await observe()
      if (!latest.unavailable || latest.status === 'unexpected')
        throw new Error('native-query-lost-selection-notice-or-count')
      const rendererGrowthKiB = Math.max(0, memoryKiB() - beforeKiB)
      if (rendererGrowthKiB > CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB)
        throw new Error('native-query-high-match-memory-budget')
      highMatch = {
        initial: 12000,
        observedReducedCount,
        observedAtMs,
        observationWindowMs,
        latestCount: latest.count,
        latestStatus: latest.status,
        latestAtMs: performance.now() - highMatchStarted,
        selectionUnavailable: true,
        sameOpenQuery: true,
        removal: 'capacity-eviction',
        rendererGrowthKiB,
      }
    } catch (error) {
      if (diagnostics && highProducer.submitted) {
        try {
          console.error('HVIR_NATIVE_QUERY_HIGH_PRODUCER_FAILURE', {
            ...highProducer,
            elapsedMs: performance.now() - highProducerStarted,
          })
        } catch {
          /* Keep the original qualification failure. */
        }
      }
      throw error
    } finally {
      await detach()
    }
    phase = 'post-query-cleanup'
    await click('Close terminal search')
    // Clear this destructive fixture before M9 creates its original READY marker.
    // Productive copy remains uncapped; the existing diagnostic reader is unchanged.
    await browser.menu('Clear Screen and Scrollback')
    await browser.ready()
    phase = 'query-frame-proof'
    const proof = await browser.proof()
    if (proof.frames < 2 || proof.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs)
      throw nativeQueryFrameBudgetError('query', proof, browser.captureTiming())
    return {
      actualNative: true,
      matches: 3,
      exactCopy: copy,
      pixelFixture,
      selectedHighlight: { first, second, returned, moved },
      movedOccurrence: {
        rowEdit: 'insert-line',
        sameSelection: true,
        noRevealGesture: true,
        exactCopy: movedCopy,
      },
      semanticNavigation: ['Output 3 of 3', 'Command 2 of 3', 'Output 3 of 3'],
      semanticCopy,
      highMatch,
      streaming,
      frames: proof.frames,
      maximumFrameGapMs: proof.maxGapMs,
      existingHighMatchFrameBudgetMs: CAPACITY_PERFORMANCE_BUDGETS.responsivenessMaxMs,
    }
  } catch (cause) {
    if (diagnostics) {
      const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
      const [producer, renderer, ui] = await Promise.all([
        native.inspectRetained(managed.id, owner).catch(() => undefined),
        native.rendererInfo(managed.id, owner).catch(() => undefined),
        evaluate<{ status: string; unavailable: boolean }>(
          `return {status:panel.querySelector('.terminal-search-status')?.textContent?.trim()??'',unavailable:!!panel.querySelector('.terminal-search-unavailable')};`,
        ).catch(() => undefined),
      ])
      console.error('HVIR_NATIVE_QUERY_FAILURE_FACTS', {
        phase,
        ui,
        geometry: producer?.geometry,
        ioAppliedSequence: producer?.ioAppliedSequence,
        ioAppliedMutation: producer?.ioAppliedMutation,
        producerFailure: producer?.failure,
        rendererHealth: producer?.rendererHealth,
        presentationFailure: producer?.presentationFailure,
        nativeLastFrame: renderer?.lastFrame && {
          screen: renderer.lastFrame.screen,
          streamSequence: renderer.lastFrame.streamSequence,
          snapshotMutation: renderer.lastFrame.snapshotMutation,
          geometrySerial: renderer.lastFrame.geometrySerial,
          kind: renderer.lastFrame.kind,
          width: renderer.lastFrame.width,
          height: renderer.lastFrame.height,
          colorSpace: renderer.lastFrame.colorSpace,
          origin: renderer.lastFrame.origin,
          premultiplied: renderer.lastFrame.premultiplied,
        },
      })
    }
    throw new Error('native-query-phase ' + phase, { cause })
  } finally {
    await win.webContents.executeJavaScript(`window.nativeSelectionProbe?.restore()`)
  }
}

interface Highlight {
  left: number
  top: number
  right: number
  bottom: number
  pixels: number
  expectedWidth: number
  expectedHeight: number
}

/** Exited PTYs retain native query authority without reviving terminal input. */
export async function verifyNativeReadonlyQuery(
  win: BrowserWindow,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const browser = nativeSelectionBrowser(win, native, managed)
  const scope = paneScript(managed.id)
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async()=>{${scope}${body}})()`) as Promise<T>
  if (!native.sessions.get(managed.id)?.readonly)
    throw new Error('native-query-not-readonly')
  await browser.menu('Search Terminal…')
  await browser.wait(
    () => evaluate(`return !!panel.querySelector('.terminal-search');`),
    'readonly-query-open',
  )
  await win.webContents.executeJavaScript(clipboardInstall(false))
  try {
    await evaluate(
      `const query=panel.querySelector('[aria-label="Find in terminal"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(query,${JSON.stringify(NATIVE_READONLY_SELECTION)});query.dispatchEvent(new Event('input',{bubbles:true}));`,
    )
    let count = 0
    await browser.wait(async () => {
      const status = await evaluate<string>(
        `return panel.querySelector('.terminal-search-status')?.textContent??'';`,
      )
      count = Number(
        status.match(/of ([0-9]+)/)?.[1] ?? status.match(/^([0-9]+) matches$/)?.[1] ?? 0,
      )
      return count > 0
    }, 'readonly-query-count')
    await evaluate(
      `const copy=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match');if(copy?.disabled)panel.querySelector('[aria-label="Next terminal match"]').click();`,
    )
    await browser.wait(
      () =>
        evaluate(
          `return [...panel.querySelectorAll('.terminal-search button')].some(node=>node.textContent?.trim()==='Copy Match'&&!node.disabled);`,
        ),
      'readonly-query-selected',
    )
    const copy = await browser.copied(
      NATIVE_READONLY_SELECTION,
      () =>
        evaluate(
          `[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match').click();`,
        ),
      false,
    )
    await evaluate(`panel.querySelector('[aria-label="Close terminal search"]').click();`)
    await browser.wait(
      async () => (await browser.proof()).frames >= 2,
      'readonly-query-paint-samples',
    )
    const timing = await browser.proof()
    if (
      timing.frames < 2 ||
      timing.maxGapMs > UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs
    )
      throw nativeQueryFrameBudgetError('readonly-query', timing, browser.captureTiming())
    return {
      retainedAfterExit: true,
      matches: count,
      exactCopy: copy,
      frames: timing.frames,
      maximumFrameGapMs: timing.maxGapMs,
    }
  } finally {
    await win.webContents.executeJavaScript(`window.nativeSelectionProbe?.restore()`)
  }
}
function nativeQueryFrameBudgetError(
  phase: 'query' | 'readonly-query',
  proof: { frames: number; maxGapMs: number; rendererTiming: unknown },
  captureTiming: unknown,
): Error {
  return new Error(
    `native-${phase}-renderer-frame-budget ` +
      JSON.stringify({
        phase,
        frames: proof.frames,
        maxGapMs: proof.maxGapMs,
        minimumFrames: 2,
        budgetMs: UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs,
        rendererTiming: proof.rendererTiming,
        captureTiming,
      }),
  )
}

async function queryPixelFixture(
  browser: ReturnType<typeof nativeSelectionBrowser>,
  evaluate: <T>(body: string) => Promise<T>,
) {
  const shadowClearance = FIND_BAR_SHADOW_CLEARANCE
  const read = async () => {
    const layout = await browser.layoutWhenReady()
    if (!layout) return undefined
    const { geometry, bounds } = layout
    const bar = await evaluate<{
      left: number
      right: number
      top: number
      bottom: number
    }>(
      `const bar=panel.querySelector('.terminal-search');if(!(bar instanceof HTMLElement))throw new Error('native-query-fixture-bar');const r=bar.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};`,
    )
    const scale = bounds.canvasCssWidth / bounds.canvasWidth
    const sampleRight =
      bounds.x + (geometry.paddingLeft + geometry.cellWidth * MATCH.length) * scale
    return {
      geometrySerial: geometry.serial,
      canvas: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.canvasCssWidth,
        height: bounds.canvasCssHeight,
      },
      sampleLeft: bounds.x + geometry.paddingLeft * scale,
      sampleRight,
      bar,
      shadowClearance,
    }
  }
  let observed: Awaited<ReturnType<typeof read>>
  await browser.wait(async () => {
    observed = await read()
    return !!observed
  }, 'query-pixel-fixture-layout')
  if (!observed) throw new Error('native-query-pixel-fixture-layout')
  const before = observed
  let accommodation = false
  if (observed.bar.left < observed.sampleRight + shadowClearance) {
    console.error('HVIR_NATIVE_QUERY_PIXEL_FIXTURE', { ...observed, unoccluded: false })
    accommodation = await evaluate<boolean>(
      `const collapse=document.querySelector('button[aria-label="Collapse file explorer"]');if(!(collapse instanceof HTMLButtonElement)||collapse.disabled||!collapse.checkVisibility())return false;collapse.click();return true;`,
    )
  }
  await browser.ready()
  await browser.wait(async () => {
    const latest = await read()
    if (!latest) return false
    observed = latest
    if (accommodation && latest.geometrySerial <= before.geometrySerial) return false
    return latest.bar.left >= latest.sampleRight + shadowClearance
  }, 'query-unoccluded-pixel-fixture')
  const result = { ...observed, before, accommodation, unoccluded: true }
  console.error('HVIR_NATIVE_QUERY_PIXEL_FIXTURE', result)
  return result
}

async function selectedHighlight(
  win: BrowserWindow,
  session: string,
  browser: ReturnType<typeof nativeSelectionBrowser>,
  previous?: Highlight,
): Promise<Highlight> {
  let observed: Highlight | undefined, latest: Highlight | undefined
  let latestCapture: object | undefined
  try {
    await browser.wait(async () => {
      const { geometry, bounds } = await browser.layout()
      const rect = (await win.webContents.executeJavaScript(
        `(()=>{${paneScript(session)}const r=canvas.getBoundingClientRect(),bar=panel.querySelector('.terminal-search')?.getBoundingClientRect();return{x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width),height:Math.floor(r.height),bar:bar?{left:bar.left,right:bar.right,top:bar.top,bottom:bar.bottom}:undefined};})()`,
      )) as {
        x: number
        y: number
        width: number
        height: number
        bar?: { left: number; right: number; top: number; bottom: number }
      }
      const image = await win.webContents.capturePage({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
      const { width, height } = image.getSize(1)
      const pixels = image.toBitmap({ scaleFactor: 1 })
      const result = {
        left: width,
        top: height,
        right: -1,
        bottom: -1,
        pixels: 0,
        expectedWidth: (geometry.cellWidth * MATCH.length * width) / bounds.canvasWidth,
        expectedHeight: (geometry.cellHeight * height) / bounds.canvasHeight,
      }
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4
          // Pinned native default search-selected-background, not a DOM overlay.
          if (
            Math.abs(pixels[offset]! - 0x7e) > 8 ||
            Math.abs(pixels[offset + 1]! - 0xa5) > 8 ||
            Math.abs(pixels[offset + 2]! - 0xf2) > 8
          )
            continue
          result.pixels++
          result.left = Math.min(result.left, x)
          result.right = Math.max(result.right, x)
          result.top = Math.min(result.top, y)
          result.bottom = Math.max(result.bottom, y)
        }
      latest = result
      latestCapture = {
        geometry,
        canvas: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          backingWidth: bounds.canvasWidth,
          backingHeight: bounds.canvasHeight,
          cssWidth: bounds.canvasCssWidth,
          cssHeight: bounds.canvasCssHeight,
          dpr: bounds.dpr,
        },
        capture: { rect, width, height, bitmapBytes: pixels.byteLength },
      }
      if (
        result.pixels < MATCH.length * 8 ||
        (previous && result.top === previous.top && result.left === previous.left)
      )
        return false
      if (
        Math.abs(result.right - result.left + 1 - result.expectedWidth) > 3 ||
        Math.abs(result.bottom - result.top + 1 - result.expectedHeight) > 3
      )
        // Native application/status can precede compositor presentation. Only
        // the complete required cell geometry certifies the selected pixels.
        return false
      const sample = {
        left: rect.x + (result.left * rect.width) / width,
        right: rect.x + ((result.right + 1) * rect.width) / width,
        top: rect.y + (result.top * rect.height) / height,
        bottom: rect.y + ((result.bottom + 1) * rect.height) / height,
      }
      if (
        rect.bar &&
        sample.right > rect.bar.left - FIND_BAR_SHADOW_CLEARANCE &&
        sample.left < rect.bar.right + FIND_BAR_SHADOW_CLEARANCE &&
        sample.bottom > rect.bar.top - FIND_BAR_SHADOW_CLEARANCE &&
        sample.top < rect.bar.bottom + FIND_BAR_SHADOW_CLEARANCE
      )
        throw new Error('native-query-pixel-fixture-occluded')
      observed = result
      return true
    }, 'query-native-highlight')
  } catch (cause) {
    const status = (await win.webContents.executeJavaScript(
      `(()=>{${paneScript(session)}return { status:panel.querySelector('.terminal-search-status')?.textContent?.trim()??'', unavailable:!!panel.querySelector('.terminal-search-unavailable') };})()`,
    )) as { status: string; unavailable: boolean }
    throw new Error(
      'native-query-highlight-observation ' +
        JSON.stringify({ previous, latest, latestCapture, status }),
      { cause },
    )
  }
  return observed!
}
