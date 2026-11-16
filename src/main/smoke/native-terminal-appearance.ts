import { nativeTerminalViewRect } from './native-terminal-browser-coordinates'
import type { BrowserWindow } from 'electron'
import type { NativeTerminalGeometry } from '../../shared/native-terminal'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { terminalProbeSourceDelivery } from './terminal-probe-source'
import {
  clipboardInstall,
  nativeSelectionBrowser,
  paneScript,
} from './native-terminal-selection-browser'

const PREFIX = '__HVIR_NATIVE_APPEARANCE_'
// Keep opaque stems beside the shaping sample so small antialiased fonts
// qualify the configured selection foreground with the same pixel checks.
const SHAPING = 'MMMM ffi -> !== === <= >='
const UNICODE = '漢字🙂 é'
interface Palette {
  background: string
  foreground: string
  cursor: string
  cursorText: string
  selection: string
  selectionText: string
  green: string
  blue: string
}

/** Real settings, palette replies, native pixels, and retained hidden-state geometry.
 * Native C coverage separately qualifies shaping and Unicode/font fallback internals. */
export async function verifyNativeTerminalAppearance(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
) {
  const browser = nativeSelectionBrowser(win, native, managed)
  const initialZoom = win.webContents.getZoomFactor()
  const owner = browser.owner
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async()=>{${body}})()`)
  const status = () => native.inspectRetained(managed.id, owner)
  const text = async () =>
    new TextDecoder().decode(await native.readRetained(managed.id, owner))
  const write = (value: string) =>
    ptys.writeConfirmed(managed.id, owner.id, value, owner.generation)
  const retained = () => {
    const current = ptys.list().filter((value) => value.id === managed.id)
    if (
      current.length !== 1 ||
      current[0]?.instanceId !== managed.instanceId ||
      native.sessions.get(managed.id)?.session.instanceId !== managed.instanceId
    )
      throw new Error('native-appearance-replaced-pty')
  }
  const waitMarker = (marker: string) =>
    browser.wait(async () => {
      const current = await text()
      if (current.includes(PREFIX + 'FAILED__'))
        throw new Error('native-appearance-recorder')
      return current.includes(PREFIX + marker + '__')
    }, 'appearance-' + marker)
  const control = async (kind: string, values: Record<string, unknown> = {}) => {
    await write('\x1d' + JSON.stringify({ kind, ...values }) + '\x1d')
    await waitMarker(typeof values.name === 'string' ? values.name : kind)
  }
  const click = (selector: string) =>
    evaluate(
      `const button=document.querySelector(${JSON.stringify(selector)});if(!(button instanceof HTMLElement))throw new Error('native-appearance-control');button.click();`,
    )
  const openSettings = async (section: 'Appearance' | 'Terminal') => {
    await click('.settings-toggle')
    await browser.wait(
      () => evaluate(`return !!document.querySelector('.settings-dialog');`),
      'appearance-settings-open',
    )
    await evaluate(
      `const button=[...document.querySelectorAll('.settings-section-index button')].find(n=>n.textContent?.trim()===${JSON.stringify(section)});if(!(button instanceof HTMLButtonElement))throw new Error('native-appearance-section');button.click();`,
    )
  }
  const set = (selector: string, value: string | number | boolean) =>
    evaluate(`
    const control=document.querySelector(${JSON.stringify(selector)}),value=${JSON.stringify(value)};
    if(control instanceof HTMLSelectElement){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(control,String(value));control.dispatchEvent(new Event('change',{bubbles:true}));}
    else if(control instanceof HTMLInputElement){if(control.type==='checkbox'){if(control.checked!==value)control.click();}else{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(control,String(value));control.dispatchEvent(new Event('input',{bubbles:true}));}}
    else throw new Error('native-appearance-settings-field');`)
  const closeSettings = async (save: boolean) => {
    await evaluate(
      `const button=[...document.querySelectorAll('.settings-dialog button')].find(n=>n.textContent?.trim()===${JSON.stringify(save ? 'Save app settings' : 'Close settings')});if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-appearance-save');button.click();`,
    )
    await browser.wait(
      () => evaluate(`return !document.querySelector('.settings-dialog');`),
      'appearance-settings-close',
    )
  }
  const apply = async (
    section: 'Appearance' | 'Terminal',
    fields: Record<string, string | number | boolean>,
    hidden = false,
  ) => {
    const before = await status()
    await openSettings(section)
    for (const [id, value] of Object.entries(fields)) {
      await browser.wait(
        () => evaluate(`return !!document.querySelector(${JSON.stringify('#' + id)});`),
        'appearance-field',
      )
      await set('#' + id, value)
    }
    await closeSettings(true)
    if (!hidden) {
      await browser.wait(
        async () =>
          (await status()).appliedAppearanceSerial > before.appliedAppearanceSerial,
        'appearance-applied',
      )
      await browser.ready()
    }
    retained()
  }
  const theme = () =>
    evaluate<'dark' | 'light'>(
      `const value=document.documentElement.dataset.theme;if(value!=='dark'&&value!=='light')throw new Error('native-appearance-theme');return value;`,
    )
  const selectAppearance = async (expected: 'dark' | 'light') => {
    if ((await theme()) === expected) return
    const before = await status()
    await click('.theme-toggle')
    await browser.wait(
      async () =>
        (await theme()) === expected &&
        (await status()).appliedAppearanceSerial > before.appliedAppearanceSerial,
      'appearance-toggle',
    )
    await browser.ready()
  }
  const chooseThemes = async (save: boolean) => {
    const before = await status()
    const stored = await evaluate<string | null>(
      `return localStorage.getItem('hvir:settings:v1');`,
    )
    await openSettings('Appearance')
    await click('.terminal-theme-gallery summary')
    const palettes: Partial<Record<'dark' | 'light', Palette>> = {}
    for (const [target, name] of [
      ['dark', 'Catppuccin Mocha'],
      ['light', 'Alabaster'],
    ] as const) {
      await click(`input[name="terminal-theme-target"][value="${target}"]`)
      await set('#settings-terminal-theme-search', name)
      await browser.wait(
        () =>
          evaluate(
            `return [...document.querySelectorAll('.terminal-theme-results > button')].some(n=>n.querySelector('strong')?.textContent?.trim()===${JSON.stringify(name)});`,
          ),
        'appearance-theme-result',
      )
      palettes[target] = await evaluate<Palette>(
        `const button=[...document.querySelectorAll('.terminal-theme-results > button')].find(n=>n.querySelector('strong')?.textContent?.trim()===${JSON.stringify(name)}),screen=button?.querySelector('.terminal-theme-preview-screen');if(!(button instanceof HTMLButtonElement)||!(screen instanceof HTMLElement))throw new Error('native-appearance-theme-preview');const keys={background:'background',foreground:'foreground',cursor:'cursor',cursorText:'cursor-text',selection:'selection',selectionText:'selection-text',green:'green',blue:'blue'},result={};for(const[key,suffix]of Object.entries(keys)){const color=screen.style.getPropertyValue('--theme-'+suffix).trim();if(!/^#[0-9a-f]{6}$/i.test(color))throw new Error('native-appearance-preview-color');result[key]=color;}button.click();return result;`,
      )
    }
    await closeSettings(save)
    if (save) {
      await browser.wait(
        async () =>
          (await status()).appliedAppearanceSerial > before.appliedAppearanceSerial,
        'appearance-gallery-save',
      )
      await browser.ready()
      if ((await status()).geometry.serial !== before.geometry.serial)
        throw new Error('native-appearance-palette-reflow')
    } else if (
      (await evaluate(`return localStorage.getItem('hvir:settings:v1');`)) !== stored ||
      (await status()).appliedAppearanceSerial !== before.appliedAppearanceSerial
    ) {
      throw new Error('native-appearance-gallery-cancel')
    }
    retained()
    return palettes as Record<'dark' | 'light', Palette>
  }
  type Layout = Awaited<ReturnType<typeof browser.layout>>
  const capture = async (
    layout: Layout,
    column: number,
    row: number,
    columns: number,
    rows = 1,
  ) => {
    const { geometry: g, bounds: b } = layout
    const pageZoom = win.webContents.getZoomFactor()
    const view = nativeTerminalViewRect(
      {
        x: b.x + (g.paddingLeft + column * g.cellWidth) / g.backingScale,
        y: b.y + (g.paddingTop + row * g.cellHeight) / g.backingScale,
        width: (columns * g.cellWidth) / g.backingScale,
        height: (rows * g.cellHeight) / g.backingScale,
      },
      pageZoom,
    )
    const region = {
      x: Math.ceil(view.x),
      y: Math.ceil(view.y),
      width: Math.max(1, Math.ceil(view.width)),
      height: Math.max(1, Math.ceil(view.height)),
    }
    return {
      image: await win.webContents.capturePage(region),
      region,
      backingScale: g.backingScale,
      pageZoom,
      cellViewWidth: (g.cellWidth / g.backingScale) * pageZoom,
      cellViewHeight: (g.cellHeight / g.backingScale) * pageZoom,
    }
  }
  const colorPixels = async (
    layout: Layout,
    color: string,
    column: number,
    row: number,
    columns: number,
    rows = 1,
    diagnosticBackground?: string,
  ) => {
    const { image, region, backingScale, pageZoom, cellViewWidth, cellViewHeight } =
      await capture(layout, column, row, columns, rows)
    const scaleFactors = image.getScaleFactors()
    const scaleFactor = scaleFactors.reduce(
      (nearest, value) =>
        Math.abs(value - backingScale) < Math.abs(nearest - backingScale)
          ? value
          : nearest,
      scaleFactors[0] ?? 1,
    )
    // Bind the bitmap and its dimensions to the same existing representation.
    // A capture's scale-factor label alone does not imply CSS-sized bitmap pixels.
    const size = image.getSize(scaleFactor)
    const bytes = image.toBitmap({ scaleFactor })
    if (bytes.length !== size.width * size.height * 4) {
      console.error(
        'HVIR_NATIVE_APPEARANCE_BITMAP_OBSERVATION',
        JSON.stringify({
          region,
          backingScale,
          scaleFactors,
          scaleFactor,
          size,
          defaultSize: image.getSize(),
          bitmapBytes: bytes.length,
        }),
      )
      throw new Error('native-appearance-bitmap-representation-size')
    }
    const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
    let pixels = 0,
      left = Infinity,
      top = Infinity,
      right = -1,
      bottom = -1
    const width = size.width
    const background =
      diagnosticBackground &&
      [1, 3, 5].map((offset) =>
        parseInt(diagnosticBackground.slice(offset, offset + 2), 16),
      )
    const histogram = new Map<number, number>()
    let nonbackgroundPixels = 0,
      nonbackgroundLeft = Infinity,
      nonbackgroundTop = Infinity,
      nonbackgroundRight = -1,
      nonbackgroundBottom = -1
    for (let i = 0; i < bytes.length; i += 4) {
      if (background) {
        const color = bytes[i + 2]! * 65536 + bytes[i + 1]! * 256 + bytes[i]!
        histogram.set(color, (histogram.get(color) ?? 0) + 1)
        if (
          Math.abs(bytes[i + 2]! - background[0]!) > 4 ||
          Math.abs(bytes[i + 1]! - background[1]!) > 4 ||
          Math.abs(bytes[i]! - background[2]!) > 4
        ) {
          const x = (i / 4) % width,
            y = Math.floor(i / 4 / width)
          nonbackgroundPixels++
          nonbackgroundLeft = Math.min(nonbackgroundLeft, x)
          nonbackgroundTop = Math.min(nonbackgroundTop, y)
          nonbackgroundRight = Math.max(nonbackgroundRight, x)
          nonbackgroundBottom = Math.max(nonbackgroundBottom, y)
        }
      }
      if (
        Math.abs(bytes[i + 2]! - rgb[0]!) <= 4 &&
        Math.abs(bytes[i + 1]! - rgb[1]!) <= 4 &&
        Math.abs(bytes[i]! - rgb[2]!) <= 4
      ) {
        const x = (i / 4) % width,
          y = Math.floor(i / 4 / width)
        pixels++
        left = Math.min(left, x)
        top = Math.min(top, y)
        right = Math.max(right, x)
        bottom = Math.max(bottom, y)
      }
    }
    return {
      pixels,
      bitmapBytes: bytes.length,
      region,
      backingScale,
      pageZoom,
      scaleFactors,
      scaleFactor,
      defaultSize: image.getSize(),
      area: bytes.length / 4,
      width: size.width,
      height: size.height,
      cellWidth: (cellViewWidth * size.width) / region.width,
      cellHeight: (cellViewHeight * size.height) / region.height,
      inkLeft: pixels ? left : null,
      inkTop: pixels ? top : null,
      inkRight: pixels ? right : null,
      inkBottom: pixels ? bottom : null,
      inkWidth: right - left + 1,
      inkHeight: bottom - top + 1,
      ...(background
        ? {
            expectedBackgroundRgb: parseInt(diagnosticBackground.slice(1), 16),
            expectedCursorRgb: parseInt(color.slice(1), 16),
            topColors: [...histogram]
              .sort((a, b) => b[1] - a[1] || a[0] - b[0])
              .slice(0, 6)
              .map(([rgb, pixels]) => ({ rgb, pixels })),
            nonbackground: {
              tolerance: 4,
              pixels: nonbackgroundPixels,
              left: nonbackgroundPixels ? nonbackgroundLeft : null,
              top: nonbackgroundPixels ? nonbackgroundTop : null,
              right: nonbackgroundPixels ? nonbackgroundRight : null,
              bottom: nonbackgroundPixels ? nonbackgroundBottom : null,
            },
          }
        : {}),
    }
  }
  const domPresentation = () =>
    evaluate(`
    const panel=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===${JSON.stringify(managed.id)}),pane=panel?.querySelector('.native-terminal-pane'),canvas=pane?.querySelector('canvas'),container=panel?.querySelector('.terminal-container'),surface=canvas?.parentElement;
    const rect=node=>{if(!(node instanceof HTMLElement))return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const css=canvas instanceof HTMLElement?getComputedStyle(canvas):undefined,input=pane?.querySelector('textarea');
    return {pane:rect(pane),canvas:rect(canvas),container:rect(container),surface:rect(surface),dpr:devicePixelRatio,input:input instanceof HTMLTextAreaElement?{focused:document.activeElement===input,disabled:input.disabled,readOnly:input.readOnly}:null,canvasBacking:canvas instanceof HTMLCanvasElement?{width:canvas.width,height:canvas.height}:null,canvasCss:css?{transform:css.transform.slice(0,256),imageRendering:css.imageRendering.slice(0,32),filter:css.filter.slice(0,128),opacity:css.opacity.slice(0,16)}:null};
  `)
  const initial = await evaluate<{
    theme: 'dark' | 'light'
    settings: Record<string, unknown>
  }>(
    `return {theme:document.documentElement.dataset.theme,settings:JSON.parse(localStorage.getItem('hvir:settings:v1')||'{}')};`,
  )
  await browser.ready()
  const initialStatus = await status()
  const originalGeometry = initialStatus.geometry
  if (initialStatus.appliedAppearanceSerial < 1)
    throw new Error('native-appearance-initial-settings-unapplied')
  assertGeometry(originalGeometry, (await browser.layout()).bounds)
  await write("stty -echo; printf '__HVIR_NATIVE_APPEARANCE_ECHO_OFF__\\n'\r")
  await waitMarker('ECHO_OFF')
  for (const delivery of terminalProbeSourceDelivery(
    appearanceRecorderSource(),
    'HVIR_APPEARANCE_B64',
    PREFIX + 'DELIVERY_',
  )) {
    await write(delivery.command)
    await browser.wait(
      async () => (await text()).includes(delivery.marker),
      'appearance-delivery',
    )
  }
  await write(
    `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_APPEARANCE_B64"; unset HVIR_APPEARANCE_B64; stty echo; printf '${PREFIX}RETURNED__\\n'\r`,
  )
  await waitMarker('READY')
  let recorder = true
  await win.webContents.executeJavaScript(clipboardInstall(false))
  try {
    await chooseThemes(false)
    const palettes = await chooseThemes(true)
    const pixelProof: Record<string, unknown> = {}
    for (const target of ['dark', 'light'] as const) {
      await selectAppearance(target)
      const palette = palettes[target]
      const before = await status()
      let sample: unknown
      await browser.wait(
        async () => {
          const layout = await browser.layoutWhenReady()
          if (!layout) return false
          const [background, foreground, green, blue] = await Promise.all([
            colorPixels(layout, palette.background, 10, 0, 5),
            colorPixels(layout, palette.foreground, 0, 2, 4),
            colorPixels(layout, palette.green, 0, 0, 3),
            colorPixels(layout, palette.blue, 4, 0, 3),
          ])
          sample = {
            background: background.pixels,
            foreground: foreground.pixels,
            green: green.pixels,
            blue: blue.pixels,
          }
          return (
            background.pixels > background.area / 2 &&
            foreground.pixels > 2 &&
            green.pixels > green.area / 2 &&
            blue.pixels > blue.area / 2
          )
        },
        'appearance-' + target + '-pixels',
      )
      await control('query', {
        name: target,
        background: palette.background,
        foreground: palette.foreground,
        appearance: target,
      })
      await browser.ready()
      await browser.drag(4.5, 0.1, SHAPING.length - 0.1)
      let lastSelection: unknown, lastForeground: unknown
      try {
        await browser.wait(
          async () => {
            const layout = await browser.layoutWhenReady()
            if (!layout) return false
            const selection = await colorPixels(
              layout,
              palette.selection,
              0,
              4,
              SHAPING.length,
            )
            const foreground = await colorPixels(
              layout,
              palette.selectionText,
              0,
              4,
              SHAPING.length,
            )
            lastSelection = selection
            lastForeground = foreground
            return selection.pixels > selection.area / 3 && foreground.pixels > 2
          },
          'appearance-' + target + '-selection-pixels',
        )
      } catch (error) {
        try {
          const current = await status()
          console.error(
            'HVIR_NATIVE_APPEARANCE_SELECTION_CENSUS',
            JSON.stringify({
              target,
              geometry: current.geometry,
              appliedAppearanceSerial: current.appliedAppearanceSerial,
              selection: lastSelection,
              foreground: lastForeground,
              histogram: await colorPixels(
                await browser.layout(),
                palette.selection,
                0,
                4,
                SHAPING.length,
                1,
                palette.background,
              ),
            }),
          )
        } catch {
          console.error('HVIR_NATIVE_APPEARANCE_SELECTION_CENSUS_UNAVAILABLE')
        }
        throw error
      }
      if ((await status()).geometry.serial !== before.geometry.serial)
        throw new Error('native-appearance-palette-geometry')
      pixelProof[target] = {
        queryRepliesExact: true,
        configuredSelectionPixels: true,
        samples: sample,
      }
      await browser.clear()
    }
    await selectAppearance('dark')
    const cursorShapes: string[] = []
    const cursorQueryCodes: number[] = []
    for (const shape of ['block', 'hollow-block', 'bar', 'underline']) {
      await control('cursor', { name: 'cursor-' + shape, code: 0 })
      await apply('Terminal', {
        'settings-terminal-cursor-shape': shape,
        'settings-terminal-cursor-blink': 'steady',
      })
      await browser.focus()
      const queryCode = shape === 'bar' ? 6 : shape === 'underline' ? 4 : 2
      // Ghostty centers the bar across the cell's left boundary (sprite
      // cursor_bar.x = -ceil(thickness/2)). A cell-only crop can omit it entirely.
      // Include a half-cell left gutter, but retain the original cell-width test.
      const sampleColumns = shape === 'bar' ? 1.5 : 1
      // Native cursor_underline may use the sprite's quarter-cell bottom padding.
      // Ceil the CSS capture extent: 30px*1.25/2 =18.75 CSS px must cover
      // physical row36 (a floored18px crop ends just before that underline).
      const sampleRows = shape === 'underline' ? 1.25 : 1
      const matchesCursor = (ink: Awaited<ReturnType<typeof colorPixels>>) => {
        if (!ink.pixels) return false
        if (shape === 'bar')
          return ink.inkWidth < ink.cellWidth / 2 && ink.inkHeight > ink.cellHeight / 2
        if (shape === 'underline')
          return ink.inkWidth > ink.cellWidth / 2 && ink.inkHeight < ink.cellHeight / 2
        if (shape === 'hollow-block')
          return (
            ink.inkWidth > ink.cellWidth / 2 &&
            ink.inkHeight > ink.cellHeight / 2 &&
            ink.pixels < (ink.cellWidth * ink.cellHeight) / 2
          )
        return ink.pixels > (ink.cellWidth * ink.cellHeight) / 2
      }
      const sampleCursor = (layout: Layout) =>
        colorPixels(
          layout,
          palettes.dark.cursor,
          shape === 'bar' ? 3.5 : 4,
          7,
          sampleColumns,
          sampleRows,
        )
      const beforeQuery = await status()
      let preQueryInk: Awaited<ReturnType<typeof colorPixels>> | undefined
      let preQueryFailure: Error | undefined
      try {
        // Preserve the original appearance-only paint assertion before any extra
        // PTY query output can wake native rendering.
        await browser.wait(async () => {
          const layout = await browser.layoutWhenReady()
          if (!layout) return false
          preQueryInk = await sampleCursor(layout)
          return matchesCursor(preQueryInk)
        }, 'appearance-cursor-' + shape)
      } catch (error) {
        preQueryFailure =
          error instanceof Error
            ? error
            : new Error('Native cursor observation failed', { cause: error })
      }
      const afterPreQueryCapture = await status()
      const preQuery = {
        passed: preQueryFailure === undefined,
        ink: preQueryInk,
        ...(preQueryFailure !== undefined
          ? {
              presentation: await domPresentation(),
              neighborhood: await colorPixels(
                await browser.layout(),
                palettes.dark.cursor,
                3,
                6,
                3,
                3,
                palettes.dark.background,
              ),
            }
          : {}),
        before: {
          appliedAppearanceSerial: beforeQuery.appliedAppearanceSerial,
          ioAppliedMutation: beforeQuery.ioAppliedMutation,
          appliedSequence: beforeQuery.appliedSequence,
          frameCopies: beforeQuery.frameCopies,
          geometrySerial: beforeQuery.geometry.serial,
        },
        after: {
          appliedAppearanceSerial: afterPreQueryCapture.appliedAppearanceSerial,
          ioAppliedMutation: afterPreQueryCapture.ioAppliedMutation,
          appliedSequence: afterPreQueryCapture.appliedSequence,
          frameCopies: afterPreQueryCapture.frameCopies,
          geometrySerial: afterPreQueryCapture.geometry.serial,
        },
      }
      console.log(
        'HVIR_NATIVE_APPEARANCE_CURSOR_PRE_QUERY',
        JSON.stringify({ shape, sampleColumns, sampleRows, ...preQuery }),
      )
      try {
        let queryFailure: Error | undefined
        try {
          await control('cursor-query', {
            name: 'cursor-query-' + shape,
            expected: queryCode,
          })
          cursorQueryCodes.push(queryCode)
        } catch (error) {
          queryFailure =
            error instanceof Error
              ? error
              : new Error('Native cursor query failed', { cause: error })
        }
        const postQueryInk = await sampleCursor(await browser.layout())
        const postQueryMatches = matchesCursor(postQueryInk)
        console.log(
          'HVIR_NATIVE_APPEARANCE_CURSOR_OBSERVATION',
          JSON.stringify({
            shape,
            passed:
              preQueryFailure === undefined &&
              queryFailure === undefined &&
              postQueryMatches,
            sampleColumns,
            sampleRows,
            ink: postQueryInk,
            cursorQueryCode: queryCode,
            queryPassed: queryFailure === undefined,
            preQuery,
            ...(preQueryFailure !== undefined || !postQueryMatches
              ? {
                  neighborhood: await colorPixels(
                    await browser.layout(),
                    palettes.dark.cursor,
                    3,
                    6,
                    3,
                    3,
                    palettes.dark.background,
                  ),
                  presentation: await domPresentation(),
                  geometry: (await status()).geometry,
                  appliedAppearanceSerial: (await status()).appliedAppearanceSerial,
                }
              : {}),
          }),
        )
        // A query-caused redraw is diagnostic evidence, never a replacement pass.
        if (preQueryFailure !== undefined) throw preQueryFailure
        if (queryFailure !== undefined) throw queryFailure
        if (!postQueryMatches)
          throw new Error('native-appearance-cursor-post-query-mismatch')
      } catch (error) {
        // Any diagnostic query or capture failure must
        // retain the original appearance-only assertion and its stack.
        if (preQueryFailure !== undefined) throw preQueryFailure
        throw error
      }
      cursorShapes.push(shape)
    }
    await control('cursor', { name: 'application-block', code: 2 })
    await apply('Terminal', {
      'settings-terminal-cursor-shape': 'bar',
      'settings-terminal-cursor-blink': 'blinking',
      'settings-terminal-ligatures': false,
    })
    await browser.focus()
    await control('cursor-query', { name: 'application-cursor-query', expected: 2 })
    await browser.wait(async () => {
      const layout = await browser.layoutWhenReady()
      if (!layout) return false
      const ink = await colorPixels(layout, palettes.dark.cursor, 4, 7, 1)
      return ink.pixels > ink.area / 2
    }, 'appearance-application-cursor-authority')
    await apply('Terminal', { 'settings-terminal-ligatures': true })
    const beforeHidden = (await status()).geometry
    await click('.terminal-collapse-toggle')
    await browser.wait(
      () =>
        evaluate(
          `return document.querySelector('.workbench')?.classList.contains('terminal-collapsed')===true;`,
        ),
      'appearance-hidden',
    )
    await apply(
      'Appearance',
      {
        'settings-monospace-font-mode': 'custom',
        'settings-monospace-font': 'Definitely Missing hvir Font',
        'settings-terminal-text-size': 17,
      },
      true,
    )
    await apply('Terminal', { 'settings-terminal-ligatures': false }, true)
    await click('.terminal-collapse-toggle')
    await browser.wait(async () => {
      const geometry = (await status()).geometry
      return (
        geometry.serial > beforeHidden.serial &&
        geometry.cellHeight !== beforeHidden.cellHeight
      )
    }, 'appearance-hidden-font-reveal')
    await browser.ready()
    const revealed = await browser.layout()
    assertGeometry(revealed.geometry, revealed.bounds)
    const refitCanvasEligible = await evaluate<boolean>(
      `${paneScript(managed.id)}window.nativeSelectionProbe.refitCanvas=canvas;return canvas.getContext('webgl2')!==null;`,
    )
    const zoomBefore = revealed.geometry
    win.webContents.setZoomFactor(initialZoom * (revealed.bounds.dpr <= 3 ? 1.25 : 0.875))
    await browser.wait(async () => {
      const geometry = (await status()).geometry
      return (
        geometry.serial > zoomBefore.serial &&
        geometry.backingScale !== zoomBefore.backingScale
      )
    }, 'appearance-fractional-scale')
    await browser.ready()
    const fractional = await browser.layout()
    assertGeometry(fractional.geometry, fractional.bounds)
    const refitCanvasRetained = await evaluate<boolean>(
      `${paneScript(managed.id)}const retained=canvas===window.nativeSelectionProbe.refitCanvas;delete window.nativeSelectionProbe.refitCanvas;return retained;`,
    )
    if (refitCanvasEligible && !refitCanvasRetained)
      throw new Error('native-appearance-visible-refit-replaced-canvas')
    await control('cursor', { name: 'fractional-underline', code: 4 })
    await browser.focus()
    let fractionalCursor: Awaited<ReturnType<typeof colorPixels>> | undefined
    try {
      await browser.wait(async () => {
        const layout = await browser.layoutWhenReady()
        if (!layout) return false
        fractionalCursor = await colorPixels(layout, palettes.dark.cursor, 4, 7, 1, 1.25)
        return (
          fractionalCursor.pixels > 0 &&
          fractionalCursor.inkWidth > fractionalCursor.cellWidth / 2 &&
          fractionalCursor.inkHeight < fractionalCursor.cellHeight / 2
        )
      }, 'appearance-fractional-underline')
    } catch (error) {
      try {
        const before = await status()
        const presentation = await domPresentation()
        const neighborhood = await colorPixels(
          await browser.layout(),
          palettes.dark.cursor,
          3,
          6,
          3,
          3,
          palettes.dark.background,
        )
        let queryPassed = false
        try {
          await control('cursor-query', { name: 'fractional-cursor-query', expected: 4 })
          queryPassed = true
        } catch {
          /* The original pixel failure remains authoritative. */
        }
        console.error(
          'HVIR_NATIVE_APPEARANCE_FRACTIONAL_OBSERVATION',
          JSON.stringify({
            ink: fractionalCursor,
            presentation,
            neighborhood,
            nativeStatus: before,
            pageZoom: win.webContents.getZoomFactor(),
            queryCode: 4,
            queryPassed,
            postQuery: await colorPixels(
              await browser.layout(),
              palettes.dark.cursor,
              4,
              7,
              1,
              1.25,
            ),
          }),
        )
      } catch {
        // Diagnostic failure must not replace the original appearance assertion.
      }
      throw error
    }
    await control('paint', { name: 'revealed-font' })
    await browser.wait(async () => {
      const layout = await browser.layoutWhenReady()
      if (!layout) return false
      return (await colorPixels(layout, palettes.dark.foreground, 0, 5, 8)).pixels > 2
    }, 'appearance-fallback-unicode-painted')
    await browser.copied(
      SHAPING,
      async () => {
        await browser.drag(4.5, 0.1, SHAPING.length - 0.1)
        await browser.menu('Copy Selection')
      },
      false,
    )
    await browser.clear()
    await apply('Terminal', { 'settings-terminal-ligatures': true })
    await browser.copied(
      SHAPING,
      async () => {
        await browser.drag(4.5, 0.1, SHAPING.length - 0.1)
        await browser.menu('Copy Selection')
      },
      false,
    )
    await browser.clear()
    const unicodeCopy = await browser.copied(
      UNICODE,
      async () => {
        await browser.drag(5.5, 0.1, 7.9)
        await browser.menu('Copy Selection')
      },
      false,
    )
    const fontGeometry = (await status()).geometry
    await browser.clear()
    await control('quit')
    recorder = false
    await waitMarker('RETURNED')
    await write("printf '__HVIR_NATIVE_APPEARANCE_STTY_'; stty size\r")
    await browser.wait(
      async () =>
        (await text()).includes(
          PREFIX + 'STTY_' + fontGeometry.rows + ' ' + fontGeometry.columns,
        ),
      'appearance-pty-font-geometry',
    )
    retained()
    win.webContents.setZoomFactor(initialZoom)
    await browser.ready()
    await apply('Appearance', {
      'settings-monospace-font-mode': 'system',
      'settings-terminal-text-size': Number(initial.settings.terminalTextSize ?? 13),
    })
    await apply('Terminal', {
      'settings-terminal-cursor-shape':
        typeof initial.settings.terminalCursorShape === 'string'
          ? initial.settings.terminalCursorShape
          : 'block',
      'settings-terminal-cursor-blink':
        typeof initial.settings.terminalCursorBlink === 'string'
          ? initial.settings.terminalCursorBlink
          : 'terminal',
      'settings-terminal-ligatures': initial.settings.terminalLigatures !== false,
    })
    await selectAppearance(initial.theme)
    // Restore the built-in palette pair for the remaining independent native fixtures.
    const beforeRestore = await status()
    const restoredBackgrounds: Record<string, string> = {}
    await openSettings('Appearance')
    await click('.terminal-theme-gallery summary')
    for (const target of ['dark', 'light']) {
      await click(`input[name="terminal-theme-target"][value="${target}"]`)
      await set(
        '#settings-terminal-theme-search',
        target === 'dark' ? 'Hvir Dark' : 'Hvir Light',
      )
      await browser.wait(
        () =>
          evaluate(
            `return !!document.querySelector('.terminal-theme-results > button[data-terminal-theme-id="hvir-default-${target}"]');`,
          ),
        'appearance-restore-palette',
      )
      restoredBackgrounds[target] = await evaluate<string>(
        `const preview=document.querySelector('.terminal-theme-results > button[data-terminal-theme-id="hvir-default-${target}"] .terminal-theme-preview-screen');if(!(preview instanceof HTMLElement))throw new Error('native-appearance-restore-preview');return preview.style.getPropertyValue('--theme-background').trim();`,
      )
      await click(
        `.terminal-theme-results > button[data-terminal-theme-id="hvir-default-${target}"]`,
      )
    }
    await closeSettings(true)
    await browser.wait(
      async () =>
        (await status()).appliedAppearanceSerial > beforeRestore.appliedAppearanceSerial,
      'appearance-restore-applied',
    )
    await browser.ready()
    await browser.wait(async () => {
      const layout = await browser.layoutWhenReady()
      if (!layout) return false
      const g = layout.geometry
      const sample = await colorPixels(
        layout,
        restoredBackgrounds[initial.theme]!,
        g.columns - 5,
        g.rows - 2,
        3,
      )
      return sample.pixels > sample.area / 2
    }, 'appearance-restore-palette-painted')
    return {
      actualNative: true,
      initialFontAppliedBeforeDraw: true,
      restoredBuiltinPalettePixels: true,
      samePty: true,
      gallery: { cancel: true, pairedSave: true },
      palettes: pixelProof,
      cursorShapes,
      cursorQueryCodes,
      applicationCursorOverride: true,
      ligatureSettings: {
        onOff: true,
        exactPointerCopy: true,
      },
      hiddenFontReveal: {
        missingFamilyFallback: true,
        unicodeExactPointerCopy: unicodeCopy,
        before: beforeHidden,
        after: fontGeometry,
        currentDraw: true,
        stty: { rows: fontGeometry.rows, columns: fontGeometry.columns },
      },
      fractionalScale: {
        refitCanvas: { eligible: refitCanvasEligible, retained: refitCanvasRetained },
        cursor: { shape: 'underline', ...fractionalCursor },
        before: zoomBefore.backingScale,
        after: fractional.geometry.backingScale,
        geometry: fractional.geometry,
        currentDraw: true,
      },
      measuredMetrics: {
        initial: {
          width: originalGeometry.cellWidth,
          height: originalGeometry.cellHeight,
        },
        changed: { width: fontGeometry.cellWidth, height: fontGeometry.cellHeight },
      },
      hardwareQualified: false,
    }
  } finally {
    win.webContents.setZoomFactor(initialZoom)
    await evaluate(`window.nativeSelectionProbe?.restore();`)
    if (recorder)
      await write('\x1d' + JSON.stringify({ kind: 'quit' }) + '\x1d').catch(
        () => undefined,
      )
  }
}

function assertGeometry(
  g: NativeTerminalGeometry,
  b: {
    width: number
    height: number
    canvasWidth: number
    canvasHeight: number
    canvasCssWidth: number
    canvasCssHeight: number
    dpr: number
  },
) {
  if (
    Math.fround(b.dpr) !== g.backingScale ||
    Math.round(b.width * b.dpr) !== g.width ||
    Math.round(b.height * b.dpr) !== g.height ||
    b.canvasWidth !== g.width ||
    b.canvasHeight !== g.height ||
    Math.round(b.canvasCssWidth * b.dpr) !== g.width ||
    Math.round(b.canvasCssHeight * b.dpr) !== g.height ||
    g.columns !== Math.floor(g.contentWidth / g.cellWidth) ||
    g.rows !== Math.floor(g.contentHeight / g.cellHeight)
  ) {
    console.error(
      'HVIR_NATIVE_APPEARANCE_GEOMETRY_FAILURE ' +
        JSON.stringify({
          geometry: {
            serial: g.serial,
            backingScale: g.backingScale,
            width: g.width,
            height: g.height,
            columns: g.columns,
            rows: g.rows,
            contentWidth: g.contentWidth,
            contentHeight: g.contentHeight,
            cellWidth: g.cellWidth,
            cellHeight: g.cellHeight,
          },
          bounds: {
            dpr: b.dpr,
            width: b.width,
            height: b.height,
            canvasWidth: b.canvasWidth,
            canvasHeight: b.canvasHeight,
            canvasCssWidth: b.canvasCssWidth,
            canvasCssHeight: b.canvasCssHeight,
          },
        }),
    )
    throw new Error('native-appearance-measured-geometry')
  }
}

/** Bounded same-PTY fixture reports only named success/failure markers. */
function appearanceRecorderSource(): string {
  return String.raw`
const prefix=${JSON.stringify(PREFIX)},shaping=${JSON.stringify(SHAPING)},unicode=${JSON.stringify(UNICODE)};
let command=null,active=null,received=Buffer.alloc(0),closed=false;
const paint=()=>process.stdout.write('\x1b[0m\x1b[1;1H\x1b[42m   \x1b[0m \x1b[104m   \x1b[0m\x1b[3;1HMMMM\x1b[5;1H'+shaping+'\x1b[6;1H'+unicode+'\x1b[8;5H');
const marker=name=>{process.stdout.write('\x1b[12;1H\x1b[2K'+prefix+name+'__');paint();};
const finish=code=>{if(closed)return;closed=true;clearTimeout(timer);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\x1b[?1049l'+prefix+(code?'FAILED':'quit')+'__\r\n',()=>process.exit(code));};
const fail=()=>{marker('FAILED');finish(2);};
const timer=setTimeout(fail,180000);
const rgb=hex=>hex.slice(1).match(/../g).map(v=>v+v).join('/');
const reply=bytes=>{if(!bytes.length)return;if(!active)return fail();received=Buffer.concat([received,bytes]);if(received.length>active.expected.length||!received.equals(active.expected.subarray(0,received.length)))return fail();if(received.length===active.expected.length){const name=active.name;active=null;marker(name);}};
const control=value=>{let c;try{c=JSON.parse(value);}catch{return fail();}if(c.kind==='quit')return finish(0);if(active)return fail();if(c.kind==='query'){active={name:c.name,expected:Buffer.from('\x1b]10;rgb:'+rgb(c.foreground)+'\x1b\\\x1b]11;rgb:'+rgb(c.background)+'\x1b\\\x1b[?997;'+(c.appearance==='dark'?'1':'2')+'n')};received=Buffer.alloc(0);process.stdout.write('\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?996n');}else if(c.kind==='cursor-query'){active={name:c.name,expected:Buffer.from('\x1bP1$r'+c.expected+' q\x1b\\')};received=Buffer.alloc(0);process.stdout.write('\x1bP$q q\x1b\\');}else if(c.kind==='cursor'){process.stdout.write('\x1b['+c.code+' q');marker(c.name);}else if(c.kind==='paint')marker(c.name);else fail();};
process.stdin.setRawMode(true);process.stdin.on('data',bytes=>{let start=0;for(let i=0;i<bytes.length&&!closed;i++){if(command!==null){if(bytes[i]===29){const value=command;command=null;control(value);}else{command+=String.fromCharCode(bytes[i]);if(command.length>512)return fail();}start=i+1;}else if(bytes[i]===29){reply(bytes.subarray(start,i));command='';start=i+1;}}if(!closed&&command===null&&start<bytes.length)reply(bytes.subarray(start));});process.stdin.resume();process.stdout.write('\x1b[?1049h\x1b[2J\x1b[?25h\x1b[0 q');marker('READY');
`
}
