import { evaluateInstalledRendererWithPixelSnapshot } from './installed-renderer-probe.mts'
import type { HvirApi } from '../src/shared/ipc'

interface BrowserElement {
  readonly id: string
  readonly textContent: string | null
  readonly disabled?: boolean
  readonly width?: number
  readonly height?: number
  readonly isConnected?: boolean
  getBoundingClientRect(): { x: number; y: number; width: number; height: number }
  click(): void
  querySelector(selector: string): BrowserElement | null
}
interface BrowserScope {
  readonly hvir: HvirApi
  readonly crypto: { randomUUID(): string }
  readonly document: {
    querySelector(selector: string): BrowserElement | null
    querySelectorAll(selector: string): Iterable<BrowserElement>
  }
}

/** Runs against production UI and public IPC, never a smoke-only renderer service. */
export async function runInstalledNativeTerminalExercise(
  retainForSnapshot = false,
): Promise<string> {
  const scope = globalThis as unknown as BrowserScope
  const { document, hvir, crypto } = scope
  const waitFor = async <T,>(
    read: () => T | undefined | Promise<T | undefined>,
    stage: string,
  ): Promise<T> => {
    const deadline = Date.now() + 12_000
    do {
      const value = await read()
      if (value !== undefined) return value
      await new Promise<void>((done) => setTimeout(done, 25))
    } while (Date.now() < deadline)
    throw new Error(`Installed native terminal: ${stage}`)
  }
  if (!hvir.diagnostics.processSandboxed || !hvir.diagnostics.contextIsolated)
    throw new Error('Installed native terminal: renderer isolation')
  const presentations = new Map<string, string>()
  const snapshots = new Map<
    string,
    { matchCount: number; pending: boolean; unavailable?: true }
  >()
  const stopStatus = hvir.nativeTerminalPresentation.onStatus((status) =>
    presentations.set(status.viewId, status.mode),
  )
  const stopQueries = hvir.on('native-terminal:query-update', (update) =>
    snapshots.set(update.queryId, update.snapshot),
  )
  let viewId: string | undefined
  let queryId: string | undefined
  let result: string | undefined
  let failure: unknown
  try {
    const newTerminal = await waitFor(() => {
      const action = document.querySelector('button[aria-label="New terminal"]')
      return action && action.disabled === false ? action : undefined
    }, 'new terminal action')
    newTerminal.click()
    const shell = await waitFor(
      () =>
        [...document.querySelectorAll('.terminal-new-menu button')].find(
          (button) => button.querySelector('strong')?.textContent?.trim() === 'Shell',
        ),
      'ordinary shell profile',
    )
    shell.click()
    const surface = await waitFor(() => {
      const pane = document.querySelector('.native-terminal-pane')
      const native = pane?.querySelector('[id^="native-terminal-"]')
      const canvas = native?.querySelector('canvas')
      return native && canvas && Number(canvas.width) >= 32 && Number(canvas.height) >= 32
        ? native
        : undefined
    }, 'native completed-frame canvas')
    viewId = surface.id.slice('native-terminal-'.length)
    if (!/^[a-f0-9-]{36}$/.test(viewId))
      throw new Error('Installed native terminal: view identity')
    await waitFor(
      () =>
        ['native-gpu', 'native-pixels'].includes(presentations.get(viewId!) ?? '')
          ? true
          : undefined,
      'native presentation',
    )
    await hvir.invoke('native-terminal:input', {
      viewId,
      input: { kind: 'focus', focused: true },
    })
    // The complete marker is absent from the echoed command, so retained readback
    // proves actual shell execution and authoritative native output processing.
    await hvir.invoke('native-terminal:input', {
      viewId,
      input: {
        kind: 'paste',
        text: "printf '\\033[48;2;83;83;83m\\033[2J\\033[H%s%s\\n' 'HVIR_INSTALLED_' 'NATIVE_OK'",
      },
    })
    await hvir.invoke('native-terminal:input', {
      viewId,
      input: {
        kind: 'key',
        key: 58,
        modifiers: 0,
        consumedModifiers: 0,
        action: 1,
        text: '',
        unshiftedCodepoint: 0,
        composing: false,
        optionAsAlt: false,
      },
    })
    const query = await hvir.invoke('native-terminal:query', {
      viewId,
      requestId: crypto.randomUUID(),
      kind: 'begin',
      text: 'HVIR_INSTALLED_NATIVE_OK',
      caseSensitive: true,
    })
    if (query.kind !== 'query')
      throw new Error('Installed native terminal: query creation')
    queryId = query.queryId
    snapshots.set(queryId, snapshots.get(queryId) ?? query.snapshot)
    await waitFor(() => {
      const snapshot = snapshots.get(queryId!)
      if (snapshot?.unavailable)
        throw new Error('Installed native terminal: unavailable query')
      return snapshot && !snapshot.pending && snapshot.matchCount === 1 ? true : undefined
    }, 'exact shell output')
    const occurrence = await hvir.invoke('native-terminal:query', {
      viewId,
      queryId,
      requestId: crypto.randomUUID(),
      kind: 'at',
      index: 0,
    })
    if (occurrence.kind !== 'occurrence' || !occurrence.occurrenceId)
      throw new Error('Installed native terminal: output occurrence')
    const readback = await hvir.invoke('native-terminal:query', {
      viewId,
      queryId,
      requestId: crypto.randomUUID(),
      kind: 'read',
      occurrenceId: occurrence.occurrenceId,
    })
    if (readback.kind !== 'text' || readback.text !== 'HVIR_INSTALLED_NATIVE_OK')
      throw new Error('Installed native terminal: exact retained readback')
    const mode = presentations.get(viewId)
    if (!['native-gpu', 'native-pixels'].includes(mode ?? ''))
      throw new Error('Installed native terminal: presentation lost')
    const evidence = JSON.stringify({
      kind: 'installed-native-terminal',
      passed: true,
      mode,
      rendererSandboxed: true,
      contextIsolated: true,
      nativeCanvas: true,
      exactShellReadback: true,
      hardwareGpuQualified: false,
      controlledCapacityQualified: false,
    })
    const bounds = surface.getBoundingClientRect()
    const point = {
      x: Math.floor(bounds.x + bounds.width / 2),
      y: Math.floor(bounds.y + bounds.height / 2),
    }
    if (
      ![point.x, point.y].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 32768,
      )
    )
      throw new Error('Installed native terminal: snapshot location')
    result = retainForSnapshot ? JSON.stringify({ evidence, point }) : evidence
  } catch (error) {
    failure = error
  } finally {
    if (viewId && queryId)
      await hvir
        .invoke('native-terminal:query', {
          viewId,
          queryId,
          requestId: crypto.randomUUID(),
          kind: 'close',
        })
        .catch(() => undefined)
    try {
      await stopQueries()
    } catch (error) {
      failure ??= error
    } finally {
      stopStatus()
    }
    if (!retainForSnapshot || failure) {
      try {
        document.querySelector('button[title="Close terminal"]')?.click()
        await waitFor(
          () => (document.querySelector('.native-terminal-pane') ? undefined : true),
          'ordinary terminal close',
        )
      } catch (error) {
        failure ??= error
      }
    }
  }
  if (failure)
    throw failure instanceof Error
      ? failure
      : new Error('Installed native terminal exercise failed', { cause: failure })
  if (result === undefined) throw new Error('Installed native terminal: missing evidence')
  return result
}

/** Public DOM status refuses a stale retained image after presentation loss. */
export function installedNativeTerminalVisible(): string {
  const { document } = globalThis as unknown as BrowserScope
  const pane = document.querySelector('.native-terminal-pane')
  const canvas = pane?.querySelector('canvas')
  if (
    !pane ||
    !canvas?.isConnected ||
    Number(canvas.width) < 32 ||
    Number(canvas.height) < 32 ||
    [...document.querySelectorAll('.native-terminal-pane [role="status"]')].some(
      (status) => /unavailable/i.test(status.textContent ?? ''),
    )
  )
    throw new Error('Installed native terminal: presentation unavailable before snapshot')
  return 'visible'
}

/** Separate CDP invocation keeps the ordinary terminal live through compositor capture. */
export async function closeInstalledNativeTerminal(): Promise<string> {
  const { document } = globalThis as unknown as BrowserScope
  document.querySelector('button[title="Close terminal"]')?.click()
  const deadline = Date.now() + 12_000
  while (document.querySelector('.native-terminal-pane')) {
    if (Date.now() >= deadline)
      throw new Error('Installed native terminal: ordinary terminal close')
    await new Promise<void>((done) => setTimeout(done, 25))
  }
  return 'closed'
}

export async function exerciseInstalledNativeTerminal(
  readActivePort: () => Promise<string>,
): Promise<string> {
  const result = await evaluateInstalledRendererWithPixelSnapshot(
    readActivePort,
    `(${runInstalledNativeTerminalExercise.toString()})(true)`,
    `(${closeInstalledNativeTerminal.toString()})()`,
    [83, 83, 83],
    `(${installedNativeTerminalVisible.toString()})()`,
  )
  return JSON.stringify({
    ...(JSON.parse(result.evidence) as Record<string, unknown>),
    syntheticFramePixels: true,
  })
}
