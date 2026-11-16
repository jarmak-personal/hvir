import type { BrowserWindow } from 'electron'
import type { CapacityTerminalComparisonMeasurement as Measurement } from './capacity-terminal-comparison'
import { nativeTerminalViewRect } from './native-terminal-browser-coordinates'
import { matchesCapacityFrameColor } from './capacity-frame-observation'

export interface CapacityWorkbenchCaptureTiming {
  requestedAtMs: number
  completedAtMs: number
  captureMs: number
}

/** The selected real control and its compositor background must both match.
 * Only compact synthetic/color evidence leaves this capture; no bitmap is retained. */
export async function workbenchClick(
  win: BrowserWindow,
  sequence: number,
  captures: CapacityWorkbenchCaptureTiming[],
): Promise<Measurement & { uiClickLatencyMs: number }> {
  const label = sequence % 2 === 0 ? 'Git' : 'Files'
  const expectedInputSequence = (await win.webContents.executeJavaScript(
    'globalThis.__hvirCapacityPairStatus.clickSequence+1',
  )) as number
  const started = performance.now()
  await win.webContents.executeJavaScript(`(()=>{
    const b=[...document.querySelectorAll('.rail-nav button:not(:disabled)')].find(n=>n.textContent.trim().startsWith(${JSON.stringify(label)}));
    if(!(b instanceof HTMLButtonElement))throw new Error('capacity-pair-workbench-control');b.click();return true;
  })()`)
  const deadline = started + 15000
  while (performance.now() < deadline) {
    const state = (await win.webContents.executeJavaScript(`(()=>{
      const b=[...document.querySelectorAll('.rail-nav button')].find(n=>n.textContent.trim().startsWith(${JSON.stringify(label)}));
      if(!b?.classList.contains('active'))return null;
      const r=b.getBoundingClientRect(),color=getComputedStyle(b).backgroundColor;
      const click=globalThis.__hvirCapacityPairStatus.lastClick;
      if(!click||!click.label.startsWith(${JSON.stringify(label)}))return null;
      return {x:r.x+6,y:r.y+3,width:2,height:2,color,inputSequence:click.sequence,
        label:b.textContent.trim().startsWith('Git')?'Git':'Files',clickLatencyMs:performance.now()-click.receivedAtMs};
    })()`)) as {
      x: number
      y: number
      width: number
      height: number
      color: string
      inputSequence: number
      label: string
      clickLatencyMs: number
    } | null
    if (state) {
      const rgb = state.color
        .match(/^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/)
        ?.slice(1)
        .map(Number)
      if (!rgb || rgb.length !== 3)
        throw new Error('capacity-pair-workbench-opaque-color')
      const rect = nativeTerminalViewRect(state, win.webContents.getZoomFactor())
      if (captures.length >= 8192)
        throw new Error('capacity-pair-workbench-capture-bound')
      const requestedAtMs = performance.now()
      const image = await win.webContents.capturePage({
        x: Math.floor(rect.x),
        y: Math.floor(rect.y),
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
      })
      const completed = performance.now()
      if (!image.getScaleFactors().includes(1))
        throw new Error('capacity-pair-workbench-capture-representation')
      captures.push({
        requestedAtMs,
        completedAtMs: completed,
        captureMs: completed - requestedAtMs,
      })
      if (
        matchesCapacityFrameColor(
          image.toBitmap({ scaleFactor: 1 }),
          rgb as [number, number, number],
        )
      ) {
        const after = (await win.webContents.executeJavaScript(`(()=>{
          const b=[...document.querySelectorAll('.rail-nav button.active')].find(n=>n.textContent.trim().startsWith(${JSON.stringify(label)}));
          if(!b)return null;const r=b.getBoundingClientRect();
          return {x:r.x+6,y:r.y+3,width:2,height:2};
        })()`)) as { x: number; y: number; width: number; height: number } | null
        if (!after) continue
        const observedGeometry = nativeTerminalViewRect(
          after,
          win.webContents.getZoomFactor(),
        )
        if (JSON.stringify(observedGeometry) !== JSON.stringify(rect)) continue
        const expectedWitness = label + ':' + expectedInputSequence
        const observedWitness = state.label + ':' + state.inputSequence
        return {
          sequence,
          durationMs: completed - started,
          uiClickLatencyMs: state.clickLatencyMs,
          expectedTag: expectedWitness,
          observedTag: observedWitness,
          expectedGeometry: JSON.stringify(rect),
          observedGeometry: JSON.stringify(observedGeometry),
          expectedInputSequence,
          observedInputSequence: state.inputSequence,
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('capacity-pair-workbench-compositor-timeout')
}
