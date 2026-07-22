import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

export interface TerminalRenderStats {
  readonly parsedWrites: number
  readonly renderRequests: number
  readonly renderFrames: number
  readonly fullRenderFrames: number
  readonly paused: boolean
  readonly pendingFrame: boolean
}

export interface TerminalPresentationSample extends TerminalRenderStats {
  readonly sessionId: string
  readonly visible: boolean
  readonly delivery: TerminalDeliverySample
}

export interface TerminalDeliverySample {
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly receivedBytes: number
  readonly deliveredBytes: number
  readonly peakBufferedBytes: number
  readonly bufferedBytes: number
  readonly pending: boolean
  readonly presentation: 'visible' | 'hidden'
}

export interface TerminalActivityReport {
  readonly hiddenPanes: number
  readonly hiddenParsedWrites: number
  readonly hiddenPresentationFrames: number
  readonly visiblePresentationFrames: number
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly terminalWrites: number
  readonly peakBufferedBytes: number
}

export async function waitForCapacityTerminalCount(
  win: BrowserWindow,
  expected: number,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const expected = ${expected};
        const deadline = Date.now() + 20000;
        const snapshot = () => ({
          rows: document.querySelectorAll('.terminal-list-row').length,
          surfaces: document.querySelectorAll('.terminal-surface').length,
          activeStatus: document.querySelector('.terminal-surface.active')
            ?.getAttribute('data-terminal-status') || ''
        });
        const poll = () => {
          const current = snapshot();
          if (
            current.rows === expected &&
            current.surfaces === expected &&
            current.activeStatus.startsWith('pid ')
          ) return resolve(undefined);
          if (Date.now() > deadline) {
            return reject(new Error(
              'capacity terminals did not settle: ' + JSON.stringify(current)
            ));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    `capacity did not reach ${expected} terminals`,
    25_000,
  )
}

export async function addCapacityTerminals(
  win: BrowserWindow,
  targetCount: number,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const targetCount = ${targetCount};
        const deadline = Date.now() + 30000;
        const waitFor = (predicate, message) =>
          new Promise((resolve, reject) => {
            const poll = () => {
              const value = predicate();
              if (value) return resolve(value);
              if (Date.now() > deadline) return reject(new Error(message));
              setTimeout(poll, 25);
            };
            poll();
          });
        for (
          let expected = document.querySelectorAll('.terminal-list-row').length + 1;
          expected <= targetCount;
          expected++
        ) {
          const add = await waitFor(
            () => document.querySelector(
              'button[aria-label="New terminal"]:not(:disabled)'
            ),
            'new-terminal button unavailable at ' + expected
          );
          add.click();
          const shell = await waitFor(
            () => [...document.querySelectorAll('.terminal-new-menu button')]
              .find((node) => node.querySelector('strong')?.textContent?.trim() === 'Shell'),
            'shell menu item unavailable at ' + expected
          );
          shell.click();
          await waitFor(() => {
            const active = document.querySelector('.terminal-surface.active');
            return document.querySelectorAll('.terminal-list-row').length === expected &&
              document.querySelectorAll('.terminal-surface').length === expected &&
              (active?.getAttribute('data-terminal-status') || '').startsWith('pid ');
          }, 'terminal did not settle at ' + expected);
        }
      })()
    `),
    `capacity terminal setup timed out at ${targetCount}`,
    35_000,
  )
}

export async function activateCapacityTerminal(
  win: BrowserWindow,
  position: number,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const position = ${position};
        const deadline = Date.now() + 5000;
        const rows = [...document.querySelectorAll('.terminal-list-row')];
        const row = rows[position];
        const button = row?.querySelector('.terminal-list-main');
        if (!row || !button) return reject(new Error('terminal row missing at ' + position));
        button.click();
        const poll = () => {
          const visible = [...document.querySelectorAll('.terminal-surface')]
            .filter((surface) => getComputedStyle(surface).visibility === 'visible');
          if (row.classList.contains('active') && visible.length === 1) {
            return resolve(undefined);
          }
          if (Date.now() > deadline) {
            return reject(new Error('terminal did not activate at ' + position));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    `capacity terminal ${position} activation timed out`,
  )
}

export async function readTerminalPresentation(
  win: BrowserWindow,
): Promise<readonly TerminalPresentationSample[]> {
  return (await win.webContents.executeJavaScript(`
    (() => [...document.querySelectorAll('.terminal-surface')].map((surface) => {
      const engine = surface.querySelector('.terminal-engine-host');
      const stats = engine?.__hvirTerminalPerformance;
      const delivery = surface.querySelector('.terminal-container')
        ?.__hvirTerminalDelivery;
      if (!stats) throw new Error('terminal presentation telemetry missing');
      if (!delivery) throw new Error('terminal delivery telemetry missing');
      return {
        sessionId: surface.getAttribute('data-terminal-session') || '',
        visible: getComputedStyle(surface).visibility === 'visible',
        ...stats,
        delivery
      };
    }))()
  `)) as readonly TerminalPresentationSample[]
}

export async function verifyHiddenPresentationSettles(win: BrowserWindow): Promise<void> {
  await delay(1_500)
  const before = await readTerminalPresentation(win)
  assertPresentationTopology(before)
  await delay(1_200)
  const after = await readTerminalPresentation(win)
  assertPresentationTopology(after)
  const previousById = new Map(before.map((sample) => [sample.sessionId, sample]))
  for (const sample of after.filter((candidate) => !candidate.visible)) {
    const previous = previousById.get(sample.sessionId)
    if (!previous || sample.renderFrames !== previous.renderFrames) {
      throw new Error(`hidden terminal ${sample.sessionId} presented a frame while idle`)
    }
  }
}

export function startCapacityOutputFixtures(supervisor: PtySupervisor): void {
  const terminals = supervisor.list()
  if (terminals.length !== 12) {
    throw new Error(`capacity fixtures expected 12 terminals, found ${terminals.length}`)
  }
  const commands = [
    `i=0; while :; do printf 'plain-visible-%06d abcdefghijklmnopqrstuvwxyz\\r\\n' "$i"; i=$((i+1)); sleep 0.01; done\n`,
    `i=0; while :; do printf 'plain-hidden-%06d abcdefghijklmnopqrstuvwxyz\\r\\n' "$i"; i=$((i+1)); sleep 0.01; done\n`,
    `i=0; while :; do printf '\\r\\033[2K\\033[36mThinking %04d…\\033[0m' "$i"; i=$((i+1)); sleep 0.01; done\n`,
    `i=0; while :; do printf '\\033[?2026h\\033[33msync-%04d\\033[0m\\r\\nline-a\\r\\nline-b\\033[?2026l' "$i"; i=$((i+1)); sleep 0.04; done\n`,
  ]
  commands.forEach((command, index) => {
    const terminal = terminals[index]!
    supervisor.write(terminal.id, terminal.ownerId, command)
  })
}

export async function verifyLoadedAdditionalTerminal(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  const existingIds = new Set(supervisor.list().map((terminal) => terminal.id))
  await addCapacityTerminals(win, 13)
  await waitFor(
    () => supervisor.list().length === 13,
    'loaded terminal was not supervised',
  )
  const terminal = supervisor.list().find((candidate) => !existingIds.has(candidate.id))
  if (!terminal) throw new Error('loaded terminal identity was not registered')

  let output = ''
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-16_384)
    },
  })
  try {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `stty -echo; IFS= read -r hvir_input; stty echo; printf '\\r\\nloaded-input:%s\\r\\n' "$hvir_input"\n`,
    )
    await delay(150)
    await win.webContents.executeJavaScript(`
      (() => {
        const sessionId = ${JSON.stringify(terminal.id)};
        const surface = document.querySelector(
          '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
        );
        surface?.querySelector('.terminal-engine-host')?.focus();
      })()
    `)
    for (const keyCode of ['L', 'O', 'A', 'D']) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await waitFor(
      () => output.includes('loaded-input:load'),
      `loaded terminal input was not echoed: ${JSON.stringify(output)}`,
    )
    await delay(250)
    if (countOccurrences(output, 'loaded-input:load') !== 1) {
      throw new Error(`loaded terminal input was duplicated: ${JSON.stringify(output)}`)
    }
    console.log('[smoke] loaded thirteenth terminal readiness + exact input echo OK')
  } finally {
    void detach()
    await closeTerminal(win, terminal.id)
    await waitFor(
      () => supervisor.list().length === 12,
      'loaded terminal did not leave the supervisor',
    )
  }
}

export function verifyTerminalActivity(
  before: readonly TerminalPresentationSample[],
  after: readonly TerminalPresentationSample[],
  activeFixtureIds: readonly string[],
): TerminalActivityReport {
  assertPresentationTopology(after)
  const beforeById = new Map(before.map((sample) => [sample.sessionId, sample]))
  let hiddenParsedWrites = 0
  let hiddenPresentationFrames = 0
  let visiblePresentationFrames = 0
  let nativeDataEvents = 0
  let deliveryCallbacks = 0
  let terminalWrites = 0
  let peakBufferedBytes = 0

  for (const current of after) {
    const previous = beforeById.get(current.sessionId)
    if (!previous)
      throw new Error(`terminal ${current.sessionId} lacked an activity baseline`)
    const parsedDelta = current.parsedWrites - previous.parsedWrites
    const frameDelta = current.renderFrames - previous.renderFrames
    const eventDelta =
      current.delivery.nativeDataEvents - previous.delivery.nativeDataEvents
    const deliveryDelta =
      current.delivery.deliveryCallbacks - previous.delivery.deliveryCallbacks
    nativeDataEvents += eventDelta
    deliveryCallbacks += deliveryDelta
    terminalWrites += parsedDelta
    peakBufferedBytes = Math.max(peakBufferedBytes, current.delivery.peakBufferedBytes)
    if (
      current.delivery.bufferedBytes > 64 * 1024 ||
      current.delivery.peakBufferedBytes > 64 * 1024
    ) {
      throw new Error(`terminal ${current.sessionId} exceeded its delivery byte cap`)
    }
    if (current.visible) {
      visiblePresentationFrames += frameDelta
      continue
    }
    hiddenParsedWrites += parsedDelta
    hiddenPresentationFrames += frameDelta
    if (frameDelta !== 0 || current.pendingFrame || !current.paused) {
      throw new Error(
        `hidden terminal ${current.sessionId} presented work: frames=${frameDelta} ` +
          `pending=${current.pendingFrame} paused=${current.paused}`,
      )
    }
    if (activeFixtureIds.includes(current.sessionId) && parsedDelta <= 0) {
      throw new Error(`hidden output fixture ${current.sessionId} did not parse PTY data`)
    }
  }
  if (visiblePresentationFrames <= 0) {
    throw new Error('visible output fixture did not present any frames')
  }
  if (deliveryCallbacks >= nativeDataEvents) {
    throw new Error(
      `terminal output was not coalesced: events=${nativeDataEvents} deliveries=${deliveryCallbacks}`,
    )
  }
  return {
    hiddenPanes: after.filter((sample) => !sample.visible).length,
    hiddenParsedWrites,
    hiddenPresentationFrames,
    visiblePresentationFrames,
    nativeDataEvents,
    deliveryCallbacks,
    terminalWrites,
    peakBufferedBytes,
  }
}

function assertPresentationTopology(
  samples: readonly TerminalPresentationSample[],
): void {
  const visible = samples.filter((sample) => sample.visible)
  const hidden = samples.filter((sample) => !sample.visible)
  if (samples.length !== 12 || visible.length !== 1 || hidden.length !== 11) {
    throw new Error(
      `capacity presentation topology was ${samples.length}/${visible.length}/${hidden.length}`,
    )
  }
  if (visible[0]!.paused)
    throw new Error('visible capacity terminal presentation was paused')
  for (const sample of hidden) {
    if (!sample.paused || sample.pendingFrame) {
      throw new Error(
        `hidden terminal ${sample.sessionId} did not settle: ` +
          `paused=${sample.paused} pending=${sample.pendingFrame}`,
      )
    }
  }
}

async function closeTerminal(win: BrowserWindow, sessionId: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const sessionId = ${JSON.stringify(sessionId)};
      const button = document.querySelector(
        '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
      );
      button?.closest('.terminal-list-row')?.querySelector('.terminal-close-button')?.click();
    })()
  `)
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await delay(25)
  }
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
