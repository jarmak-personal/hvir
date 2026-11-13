/** Real production presenter/receiver/canvas proof. Capture is observer-only. */
import assert from 'node:assert/strict'
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, sharedTexture } from 'electron'
import { localPath } from '../../src/shared/host-path'
import type {
  NativeTerminalSession,
  NativeTerminalStatus,
} from '../../src/shared/native-terminal'
import { NativeTerminalHost } from '../../src/main/terminal/native-terminal-host'
import { NativeTerminalProcess } from '../../src/main/terminal/native-terminal-process'
import { NativeTerminalFrameImports } from '../../src/main/terminal/native-terminal-import'
import { NativeTerminalPresenter } from '../../src/main/terminal/native-terminal-presenter'
import { NativeTerminalPresentationTargets } from '../../src/main/terminal/native-terminal-presentation-target'
import { IpcAuthorityRouter } from '../../src/main/ipc/authority-router'
import { RendererResourceScopes } from '../../src/main/renderer-resource-scopes'
import { registerNativeTerminalPresentationIpc } from '../../src/main/ipc/features/native-terminal-presentation'

const library = process.argv.find((a) => a.startsWith('--library='))?.slice(10)
if (!library || process.platform !== 'darwin')
  throw new Error('presenter-probe requires macOS and --library')
const compatibility = process.argv.includes('--compatibility')
if (compatibility) app.disableHardwareAcceleration()
let window: BrowserWindow | undefined
let host: NativeTerminalHost | undefined
let targets: NativeTerminalPresentationTargets | undefined
let router: IpcAuthorityRouter | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let failed = false
let stage = 'startup'
function phase(value: string): void {
  stage = value
  writeSync(2, `native-presenter:phase ${value}\n`)
}
process.on('uncaughtExceptionMonitor', (error) => {
  failed = true
  writeSync(2, `native-probe:uncaught ${error.name}\n`)
})
app.on('window-all-closed', () => {
  /* The proof owns asynchronous cleanup. */
})
void app
  .whenReady()
  .then(async () => {
    timer = setTimeout(() => app.exit(1), 60000)
    const processPort = new NativeTerminalProcess(library, __dirname)
    phase('create-window')
    const sessions = new Map<string, NativeTerminalSession>()
    const session = (id: string): NativeTerminalSession => ({
      sessionId: id,
      instanceId: `${id}-instance`,
      ownerId: 1,
      ownerGeneration: 1,
      workspaceRoot: localPath('/tmp'),
    })
    const first = session('presenter-first'),
      second = session('presenter-second')
    sessions.set(first.sessionId, first)
    sessions.set(second.sessionId, second)
    host = new NativeTerminalHost(processPort, {
      resolve: (id) => sessions.get(id),
      isRendererCurrent: (id, generation) => id === 1 && generation === 1,
    })
    window = new BrowserWindow({
      show: false,
      width: 680,
      height: 400,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    const targetWindow = window,
      contents = targetWindow.webContents
    await targetWindow.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="margin:0;background:white"><div id="first" style="position:absolute;left:0;top:0;width:320px;height:192px;overflow:hidden"></div><div id="second" style="position:absolute;left:340px;top:0;width:320px;height:192px;overflow:hidden"></div><div id="detail" style="position:absolute;left:0;top:0;width:320px;height:192px;overflow:hidden;display:none"></div>',
        ),
    )
    await contents.executeJavaScript(
      'document.body.insertAdjacentHTML(\'beforeend\', \'<div style="position:absolute;left:0;top:200px;width:320px"><div style="height:20px;background:rgb(128,32,192)"></div><div style="height:20px;background:rgb(64,176,96)"></div><div style="height:20px;background:rgb(128,128,128)"></div></div>\');true',
    )
    const isolation = (await contents.executeJavaScript(
      '({sandboxed:window.hvir.diagnostics.processSandboxed, api:!!window.hvir.nativeTerminalPresentation})',
    )) as { sandboxed: boolean; api: boolean }
    assert.equal(isolation.sandboxed, true)
    assert.equal(isolation.api, true)
    await contents.executeJavaScript(
      `window.nativeHeartbeat={gaps:[],last:performance.now()};window.nativeHeartbeatTimer=setInterval(()=>{const h=window.nativeHeartbeat,now=performance.now();if(h.gaps.length<12000)h.gaps.push(now-h.last);h.last=now},10);true`,
    )
    const imports = new NativeTerminalFrameImports(processPort, sharedTexture)
    targets = new NativeTerminalPresentationTargets()
    const scopes = new RendererResourceScopes()
    scopes.activateOwner(contents.id)
    router = new IpcAuthorityRouter({
      rendererResources: scopes,
      getProject: () => {
        throw new Error('No project operation in presentation proof')
      },
      getProjectState: () => {
        throw new Error('No project operation in presentation proof')
      },
      getRegisteredWorkspaceRoot: () => undefined,
      recordIpcContractDiagnostic: () => undefined,
    })
    registerNativeTerminalPresentationIpc(router, targets)
    const presenter = new NativeTerminalPresenter(host, imports)
    phase('prepare')
    const firstHandle = await host.prepare(first, 320, 192)
    const secondHandle = await host.prepare(second, 320, 192)
    const utilityPid = processPort.pid
    assert(utilityPid && utilityPid !== process.pid)
    const target = () =>
      targets!.create(
        contents.mainFrame,
        () => !targetWindow.isDestroyed() && !contents.isDestroyed(),
        () => true,
      )
    const firstTarget = target()
    const view = await presenter.attach(firstHandle, first, firstTarget)
    phase('attach')
    const otherView = await presenter.attach(secondHandle, second, target())
    await contents.executeJavaScript(
      `window.hvir.nativeTerminalPresentation.mount(${JSON.stringify(view)},'first');window.hvir.nativeTerminalPresentation.mount(${JSON.stringify(otherView)},'second');window.nativeStatuses=[];window.hvir.nativeTerminalPresentation.onStatus(s=>window.nativeStatuses.push(s));true`,
    )
    const mainGaps: number[] = []
    let mainMaxGapMs = 0,
      lastBeat = performance.now(),
      samples = 0
    const beat = setInterval(() => {
      const now = performance.now()
      mainMaxGapMs = Math.max(mainMaxGapMs, now - lastBeat)
      assert(mainGaps.length < 12000)
      mainGaps.push(now - lastBeat)
      lastBeat = now
      samples++
    }, 5)
    const draw = async (id: string): Promise<void> => {
      const deadline = performance.now() + 10000
      for (;;) {
        const delivered = await presenter.demand(id)
        const drawn: unknown = await contents.executeJavaScript(
          `!!document.querySelector('#${id === view ? 'first' : 'second'} canvas')`,
        )
        if (drawn && delivered) return
        if (performance.now() > deadline) throw new Error('presenter-draw-timeout')
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
    }
    const paint = async (
      handle: string,
      s: NativeTerminalSession,
      base: number,
    ): Promise<void> => {
      const state = await host!.inspect(handle, 1, 1)
      const halfway = Math.max(2, Math.floor(state.geometry.rows / 2))
      let bytes = `\x1b[48;2;${base === 41 ? '220;0;0' : '220;0;220'}m\x1b[2J\x1b[Hnative`
      for (let row = halfway; row <= state.geometry.rows; row++)
        bytes += `\x1b[${row};1H\x1b[48;2;${base === 41 ? '0;0;220' : '0;220;0'}m\x1b[2K`
      await host!.feed(handle, s.instanceId, new TextEncoder().encode(bytes))
    }
    const capture = async (): Promise<{ redTop: number; blueBottom: number }> => {
      await contents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      )
      const image = await contents.capturePage({ x: 0, y: 0, width: 320, height: 192 })
      const { width, height } = image.getSize(1)
      const bytes = image.toBitmap({ scaleFactor: 1 })
      assert.equal(bytes.length, width * height * 4, 'observer-bitmap-extent')
      let redTop = 0,
        blueBottom = 0
      for (let y = 8; y < height - 8; y++)
        for (let x = 8; x < width - 8; x++) {
          const offset = (y * width + x) * 4
          const b = bytes[offset]!,
            g = bytes[offset + 1]!,
            r = bytes[offset + 2]!
          if (y < height / 3 && r > 100 && r > b * 1.5 && r > g * 1.5) redTop++
          if (y > (height * 2) / 3 && b > 100 && b > r * 1.5 && b > g * 1.5) blueBottom++
        }
      return { redTop, blueBottom }
    }
    const captureFixture = async (): Promise<{ redTop: number; blueBottom: number }> => {
      const deadline = performance.now() + 10000
      for (;;) {
        await presenter.demand(view)
        const colors = await capture()
        if (colors.redTop > 100 && colors.blueBottom > 100) return colors
        if (performance.now() > deadline)
          throw new Error('presenter-fixture-paint-timeout')
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
    }
    for (const scale of [1, 2, 1]) {
      phase(`scale-${scale}`)
      await presenter.update(view, {
        width: 320,
        height: 192,
        backingScale: scale,
        visible: true,
      })
      const status: NativeTerminalStatus = await host.inspect(firstHandle, 1, 1)
      assert.equal(status.geometry.backingScale, scale)
      assert.equal(status.geometry.width, 320 * scale)
      await paint(firstHandle, first, 41)
      await draw(view)
      await captureFixture()
    }
    await presenter.update(otherView, {
      width: 320,
      height: 192,
      backingScale: 1,
      visible: true,
    })
    await paint(secondHandle, second, 45)
    await draw(otherView)
    let colors = await captureFixture()
    writeSync(2, `native-presenter:colors ${JSON.stringify(colors)}\n`)
    assert(
      colors.redTop > 100 && colors.blueBottom > 100,
      'native canvas orientation/color',
    )
    const firstSerial = (await host.inspect(firstHandle, 1, 1)).geometry.serial
    await presenter.update(view, {
      width: 320,
      height: 192,
      backingScale: 1,
      visible: true,
    })
    assert((await host.inspect(firstHandle, 1, 1)).geometry.serial > firstSerial)
    await presenter.update(view, {
      width: 320,
      height: 192,
      backingScale: 1,
      visible: false,
    })
    await host.feed(
      firstHandle,
      first.instanceId,
      new TextEncoder().encode('\x1b[Hhidden-output'),
    )
    assert(
      new TextDecoder()
        .decode(await host.read(firstHandle, 1, 1))
        .includes('hidden-output'),
    )
    await presenter.demand(view)
    await contents.executeJavaScript(
      "document.getElementById('detail').appendChild(document.getElementById('first'));document.getElementById('detail').style.display='block';true",
    )
    await contents.executeJavaScript(
      "document.body.appendChild(document.getElementById('first'));document.getElementById('detail').style.display='none';true",
    )
    const currentGrant = await presenter.update(view, {
      width: 320,
      height: 192,
      backingScale: 1,
      visible: true,
    })
    await paint(firstHandle, first, 41)
    await draw(view)
    colors = await captureFixture()
    assert(colors.redTop > 100 && colors.blueBottom > 100)
    phase('color-midtones')
    const colorRows = (await host.inspect(firstHandle, 1, 1)).geometry.rows
    let midtones = '\x1b[48;2;128;32;192m\x1b[2J\x1b[H'
    for (let row = Math.floor(colorRows / 3) + 1; row <= colorRows; row++)
      midtones += `\x1b[${row};1H\x1b[48;2;${row <= Math.floor((2 * colorRows) / 3) ? '64;176;96' : '128;128;128'}m\x1b[2K`
    await host.feed(firstHandle, first.instanceId, new TextEncoder().encode(midtones))
    let colorMaximumDifference = Infinity
    let colorSamples: { actual: number[]; reference: number[] }[] = []
    const colorDeadline = performance.now() + 10000
    while (colorMaximumDifference > 4) {
      await presenter.demand(view)
      await contents.executeJavaScript(
        'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      )
      const image = await contents.capturePage({ x: 0, y: 0, width: 320, height: 260 })
      const size = image.getSize(1),
        bytes = image.toBitmap({ scaleFactor: 1 })
      const sample = (y: number): number[] => {
        const offset =
          (Math.floor((y * size.height) / 260) * size.width +
            Math.floor(size.width / 2)) *
          4
        assert.equal(bytes[offset + 3], 255, 'opaque baseline')
        return [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!]
      }
      colorSamples = []
      colorMaximumDifference = Math.max(
        ...[32, 96, 160].flatMap((y, index) => {
          const actual = sample(y),
            reference = sample(210 + 20 * index)
          colorSamples.push({ actual, reference })
          return actual.map((channel, c) => Math.abs(channel - reference[c]!))
        }),
      )
      if (performance.now() > colorDeadline) {
        console.error('native-presenter:color-samples', JSON.stringify(colorSamples))
        throw new Error(`presenter-color-reference-difference:${colorMaximumDifference}`)
      }
      if (colorMaximumDifference > 4)
        await new Promise((resolve) => setTimeout(resolve, 16))
    }
    let maximumCompatibilityUploadBytes = 0
    let compatibilityBoundRefused = false
    if (compatibility) {
      phase('pixel-upload-bound')
      await contents.executeJavaScript(
        "document.getElementById('first').style.width='1024px';document.getElementById('first').style.height='1024px';true",
      )
      await presenter.update(view, {
        width: 1024,
        height: 1024,
        backingScale: 2,
        visible: true,
      })
      await paint(firstHandle, first, 41)
      await draw(view)
      maximumCompatibilityUploadBytes = 16 * 1024 * 1024
      const beforeRefusal = (await host.inspect(firstHandle, 1, 1)).frameCopies
      await presenter.update(view, {
        width: 1025,
        height: 1024,
        backingScale: 2,
        visible: true,
      })
      const boundDeadline = performance.now() + 10000
      while (!compatibilityBoundRefused) {
        try {
          await presenter.demand(view)
        } catch (error) {
          assert.match((error as Error).message, /native-pixel-bound/)
          compatibilityBoundRefused = true
        }
        if (performance.now() > boundDeadline)
          throw new Error('presenter-bound-refusal-timeout')
        if (!compatibilityBoundRefused)
          await new Promise((resolve) => setTimeout(resolve, 16))
      }
      assert.equal((await host.inspect(firstHandle, 1, 1)).frameCopies, beforeRefusal)
      await host.feed(
        firstHandle,
        first.instanceId,
        new TextEncoder().encode('\x1b[Hparser-after-pixel-bound'),
      )
      assert(
        new TextDecoder()
          .decode(await host.read(firstHandle, 1, 1))
          .includes('parser-after-pixel-bound'),
      )
    }
    const copied = (await host.inspect(firstHandle, 1, 1)).frameCopies
    assert(
      compatibility ? copied > 0 : copied === 0,
      'copy count distinguishes compatibility',
    )
    const statuses = (await contents.executeJavaScript(
      'window.nativeStatuses.map(s=>s.mode)',
    )) as string[]
    assert(statuses.includes(compatibility ? 'native-pixels' : 'native-gpu'))
    let contextLossReported = false
    let contextLossNativeOccluded = false,
      occludedCompletedFrames = 0,
      occludedFeeds = 0
    if (!compatibility) {
      phase('context-loss')
      const triggered: unknown = await contents.executeJavaScript(
        `(()=>{const canvas=document.querySelector('#first canvas'),gl=canvas?.getContext('webgl2'),extension=gl?.getExtension('WEBGL_lose_context');if(!extension)return false;extension.loseContext();return true})()`,
      )
      assert.equal(triggered, true)
      const contextDeadline = performance.now() + 10000
      while (!contextLossReported) {
        contextLossReported = (await contents.executeJavaScript(
          `window.nativeStatuses.some(s=>s.viewId===${JSON.stringify(view)}&&s.mode==='unavailable')`,
        )) as boolean
        if (performance.now() > contextDeadline)
          throw new Error('presenter-context-loss-timeout')
        if (!contextLossReported) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert(currentGrant)
      const attachment = currentGrant.attachment
      while (firstTarget.isCurrent()) {
        if (performance.now() > contextDeadline)
          throw new Error('presenter-loss-notification-timeout')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await host.inspect(firstHandle, 1, 1)
      const take = async (): Promise<number> => {
        const frame = await host!.takeFrame(firstHandle, 1, 1, attachment)
        if (!frame) return 0
        await frame.release()
        return 1
      }
      // Drain an already completed image, then keep the failed view ATTACHED.
      // Every subsequent feed dirties the terminal; a visible producer would
      // export frames. No observer pixel readback occurs in this phase.
      const warmUntil = performance.now() + 100
      while (performance.now() < warmUntil) {
        await take()
        await new Promise((r) => setTimeout(r, 5))
      }
      const occludedUntil = performance.now() + 700
      while (performance.now() < occludedUntil) {
        await host.feed(
          firstHandle,
          first.instanceId,
          new TextEncoder().encode(
            `\x1b[48;2;${occludedFeeds % 2 ? '30;150;80' : '90;40;170'}m\x1b[2J\x1b[Hcontext-loss-progress`,
          ),
        )
        occludedFeeds++
        occludedCompletedFrames += await take()
        await new Promise((r) => setTimeout(r, 25))
      }
      assert(
        occludedFeeds >= 10 && occludedCompletedFrames === 0,
        'unavailable attached producer stays occluded',
      )
      contextLossNativeOccluded = true
      await host.feed(
        firstHandle,
        first.instanceId,
        new TextEncoder().encode('\x1b[Hparser-after-context-loss'),
      )
      assert(
        new TextDecoder()
          .decode(await host.read(firstHandle, 1, 1))
          .includes('parser-after-context-loss'),
      )
    }
    const rendererGaps = (await contents.executeJavaScript(
      `clearInterval(window.nativeHeartbeatTimer);window.nativeHeartbeat.gaps.push(performance.now()-window.nativeHeartbeat.last);window.nativeHeartbeat.gaps`,
    )) as number[]
    mainGaps.push(performance.now() - lastBeat)
    const gapSummary = (values: number[]) => {
      assert(
        values.length >= 2 &&
          values.length <= 12001 &&
          values.every((n) => Number.isFinite(n) && n >= 0),
      )
      const sorted = values.slice().sort((a, b) => a - b)
      return {
        samples: sorted.length,
        p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1]!,
        maxMs: sorted.at(-1)!,
      }
    }
    const responsiveness = {
      main: gapSummary(mainGaps),
      renderer: gapSummary(rendererGaps),
    }
    assert(
      responsiveness.main.maxMs <= 500 && responsiveness.renderer.maxMs <= 500,
      'presenter-heartbeat-maximum',
    )
    clearInterval(beat)
    assert(samples > 1 && mainMaxGapMs <= 500)
    await presenter.detach(view)
    await presenter.detach(otherView)
    await host.end(firstHandle, first.instanceId)
    await host.end(secondHandle, second.instanceId)
    targets.dispose()
    router.dispose()
    assert.equal(processPort.pid, undefined, 'final utility exits')
    host.dispose()
    const destroyed = new Promise<void>((resolve) => contents.once('destroyed', resolve))
    targetWindow.destroy()
    await destroyed
    clearTimeout(timer)
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(
        JSON.stringify({
          nativeUtilityBoundary: 'passed',
          nativePresenter: 'passed',
          mainPid: process.pid,
          utilityPid,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          realGhostty: true,
          receiverSandboxed: true,
          receiverContextIsolated: true,
          hardwareGpuQualified: false,
          orientationQualified: true,
          mode: compatibility ? 'native-pixels' : 'native-gpu',
          routineGpuReadbacks: compatibility ? null : copied,
          frameCopies: copied,
          contextLossReported,
          contextLossNativeOccluded,
          occludedCompletedFrames,
          occludedFeeds,
          maximumCompatibilityUploadBytes,
          compatibilityBoundRefused,
          translucentAlphaQualified: false,
          colorMaximumDifference,
          colorReference: 'opaque-css-srgb-midtones',
          scales: [1, 2, 1],
          equalSizeSerial: true,
          hiddenParsing: true,
          retainedReparent: true,
          independentViews: 2,
          colors,
          mainMaxGapMs,
          responsiveness,
          responsivenessMaximumInclusiveMs: 500,
          finalUtilityExit: true,
          controlledCapacityQualified: false,
          manualMultiDisplayQualified: false,
          observerReadback: 'capture-page-only',
        }) + '\n',
        (error) => (error ? reject(error) : resolve()),
      ),
    )
    app.exit(failed ? 1 : 0)
  })
  .catch(async (error: unknown) => {
    console.error(
      'native-presenter:failed',
      JSON.stringify({
        stage,
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message.slice(0, 512) : undefined,
      }),
    )
    if (window && !window.isDestroyed()) {
      try {
        const status: unknown = await window.webContents.executeJavaScript(
          '({statuses:window.nativeStatuses?.slice(-8).map(s=>({mode:s.mode,reason:s.reason})),canvases:Array.from(document.querySelectorAll("canvas")).map(c=>({width:c.width,height:c.height}))})',
        )
        console.error('native-presenter:failure-state', JSON.stringify(status))
      } catch {
        /* Preserve the original failure. */
      }
    }
    if (timer) clearTimeout(timer)
    targets?.dispose()
    router?.dispose()
    host?.dispose()
    window?.destroy()
    app.exit(1)
  })
