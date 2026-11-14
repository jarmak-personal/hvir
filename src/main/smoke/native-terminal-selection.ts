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
import {
  nativeSelectionBrowser,
  nativeSelectionPointerObservation,
  nativeSelectionHitCensusScript,
  paneScript,
  clipboardInstall,
} from './native-terminal-selection-browser'

import {
  PREFIX,
  NATIVE_SELECTION_RETENTION_MARKER,
  NATIVE_READONLY_SELECTION,
  nativeSelectionFixture,
  nativeSelectionLargeExpected,
  nativeSelectionRecorderSource,
} from './native-terminal-selection-fixture'
export {
  NATIVE_SELECTION_RETENTION_MARKER,
  NATIVE_READONLY_SELECTION,
} from './native-terminal-selection-fixture'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

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
    const gridAccommodation = await browser.accommodateGrid(
      () => ptys.get(managed.id)?.instanceId === managed.instanceId,
    )
    console.log('HVIR_NATIVE_SELECTION_LAYOUT ' + JSON.stringify(gridAccommodation))
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
      gridAccommodation,
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
