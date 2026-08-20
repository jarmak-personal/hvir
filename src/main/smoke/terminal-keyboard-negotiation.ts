import type { BrowserWindow, InputEvent as ElectronInputEvent } from 'electron'

import { plainShellProvider } from '../harness/harness-provider'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

interface KeyboardProbePhase {
  readonly name: string
  readonly activateHex: string
  readonly queryResponseHex: string
  readonly inputs: readonly KeyboardProbeInput[]
  readonly deactivateHex: string
}

interface KeyboardProbeInput {
  readonly name: string
  readonly keyCode: string
  readonly modifiers: readonly KeyboardModifier[]
  readonly expectedHex: string
}

type KeyboardModifier = NonNullable<ElectronInputEvent['modifiers']>[number]

const KEYBOARD_PROBE_PHASES = [
  {
    name: 'ordinary-initial',
    activateHex: '1b5b356e',
    queryResponseHex: '1b5b306e',
    inputs: [
      { name: 'ctrl-u', keyCode: 'U', modifiers: ['control'], expectedHex: '15' },
      { name: 'shift-enter', keyCode: 'Enter', modifiers: ['shift'], expectedHex: '0d' },
    ],
    deactivateHex: '',
  },
  {
    name: 'kitty',
    activateHex: '1b5b3e31751b5b3f75',
    queryResponseHex: '1b5b3f3175',
    inputs: [
      {
        name: 'shift-enter',
        keyCode: 'Enter',
        modifiers: ['shift'],
        expectedHex: '1b5b31333b3275',
      },
      {
        name: 'ctrl-a',
        keyCode: 'A',
        modifiers: ['control'],
        expectedHex: '1b5b39373b3575',
      },
      {
        name: 'ctrl-c',
        keyCode: 'C',
        modifiers: ['control'],
        expectedHex: '1b5b39393b3575',
      },
      {
        name: 'ctrl-u',
        keyCode: 'U',
        modifiers: ['control'],
        expectedHex: '1b5b3131373b3575',
      },
      {
        name: 'ctrl-w',
        keyCode: 'W',
        modifiers: ['control'],
        expectedHex: '1b5b3131393b3575',
      },
    ],
    deactivateHex: '1b5b3c75',
  },
  {
    name: 'kitty-restored',
    activateHex: '1b5b3f75',
    queryResponseHex: '1b5b3f3075',
    inputs: [{ name: 'ctrl-u', keyCode: 'U', modifiers: ['control'], expectedHex: '15' }],
    deactivateHex: '',
  },
  {
    name: 'modify-other-keys',
    activateHex: '1b5b3e343b326d1b5b356e',
    queryResponseHex: '1b5b306e',
    inputs: [
      {
        name: 'shift-enter',
        keyCode: 'Enter',
        modifiers: ['shift'],
        expectedHex: '1b5b32373b323b31337e',
      },
    ],
    deactivateHex: '1b5b3e343b306d',
  },
  {
    name: 'ordinary-final',
    activateHex: '1b5b356e',
    queryResponseHex: '1b5b306e',
    inputs: [
      { name: 'shift-enter', keyCode: 'Enter', modifiers: ['shift'], expectedHex: '0d' },
    ],
    deactivateHex: '',
  },
] as const satisfies readonly KeyboardProbePhase[]

const READY_PREFIX = '__HVIR_KEYBOARD_READY__:'
const CLIENT_STARTED_MARKER = '__HVIR_KEYBOARD_CLIENT_STARTED__'
const SUCCESS_PREFIX = '__HVIR_KEYBOARD_OK__:'
const FAILURE_PREFIX = '__HVIR_KEYBOARD_FAIL__:'
const CLOSED_PREFIX = '__HVIR_KEYBOARD_CLOSED__:'
const CLOSED_SUCCESS_MARKER = `${CLOSED_PREFIX}0`
const EXPECTED_SUCCESS_MARKER = `${SUCCESS_PREFIX}${KEYBOARD_PROBE_PHASES.flatMap(
  (phase) =>
    phase.inputs.map((input) => `${phase.name}.${input.name}=${input.expectedHex}`),
).join(',')}`
const RESET_PROTOCOLS_HEX = '1b5b3c751b5b3e343b306d'
const PROBE_SOURCE_VARIABLE = 'HVIR_KEYBOARD_PROBE_B64'
const PROBE_SOURCE_CHUNK_LENGTH = 640

const KEYBOARD_PROBE_SOURCE = `
const phases = ${JSON.stringify(KEYBOARD_PROBE_PHASES)};
const readyPrefix = '__HVIR_' + 'KEYBOARD_READY__:';
const successPrefix = '__HVIR_' + 'KEYBOARD_OK__:';
const failurePrefix = '__HVIR_' + 'KEYBOARD_FAIL__:';
const abortedMarker = '__HVIR_' + 'KEYBOARD_ABORTED__';
const closedPrefix = '__HVIR_' + 'KEYBOARD_CLOSED__:';
const resetProtocols = Buffer.from('${RESET_PROTOCOLS_HEX}', 'hex');
let phaseIndex = 0;
let inputIndex = 0;
let waitingFor = 'query';
let buffered = Buffer.alloc(0);
let finished = false;
const observed = [];

const finish = (requestedCode, requestedMessage) => {
  if (finished) return;
  finished = true;
  process.stdin.pause();
  let code = requestedCode;
  let message = requestedMessage;
  try {
    process.stdin.setRawMode(false);
  } catch {
    code = 2;
    message = failurePrefix + 'tty-restore';
  }
  process.stdout.write(resetProtocols);
  process.stdout.write('\\r\\n' + message + '\\r\\n' + closedPrefix + code + '\\r\\n', () => {
    process.exit(code);
  });
  setTimeout(() => process.exit(code), 100);
};
const fail = (message) => finish(2, failurePrefix + message);
const advance = () => {
  if (finished) return;
  const phase = phases[phaseIndex];
  if (!phase) return fail('missing-phase');
  const queryResponse = Buffer.from(phase.queryResponseHex, 'hex');
  if (waitingFor === 'query') {
    const responseIndex = buffered.indexOf(queryResponse);
    if (responseIndex < 0) return;
    buffered = buffered.subarray(responseIndex + queryResponse.length);
    waitingFor = 'key';
    inputIndex = 0;
    process.stdout.write(
      readyPrefix + phase.name + ':' + phase.inputs[inputIndex].name + '\\r\\n',
    );
  }
  if (waitingFor !== 'key' || buffered.length === 0) return;
  const input = phase.inputs[inputIndex];
  if (!input) return fail(phase.name + ':missing-input');
  const expectedKey = Buffer.from(input.expectedHex, 'hex');
  const prefixLength = Math.min(buffered.length, expectedKey.length);
  if (!buffered.subarray(0, prefixLength).equals(expectedKey.subarray(0, prefixLength))) {
    return fail(phase.name + ':' + input.name + ':unexpected-key');
  }
  if (buffered.length < expectedKey.length) return;
  buffered = buffered.subarray(expectedKey.length);
  if (buffered.length > 0) return fail(phase.name + ':trailing-input');
  observed.push(phase.name + '.' + input.name + '=' + input.expectedHex);
  inputIndex += 1;
  const nextInput = phase.inputs[inputIndex];
  if (nextInput) {
    process.stdout.write(readyPrefix + phase.name + ':' + nextInput.name + '\\r\\n');
    return;
  }
  if (phase.deactivateHex) {
    process.stdout.write(Buffer.from(phase.deactivateHex, 'hex'));
  }
  phaseIndex += 1;
  const next = phases[phaseIndex];
  if (!next) {
    return finish(0, successPrefix + observed.join(','));
  }
  waitingFor = 'query';
  inputIndex = 0;
  process.stdout.write(Buffer.from(next.activateHex, 'hex'));
};

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  process.once(signal, () => finish(130, abortedMarker));
}
process.once('uncaughtException', () => fail('uncaught-exception'));
process.once('unhandledRejection', () => fail('unhandled-rejection'));
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  fail('stdin-not-tty');
} else {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(3)) return finish(130, abortedMarker);
    buffered = Buffer.concat([buffered, chunk]);
    advance();
  });
  process.stdout.write(Buffer.from(phases[0].activateHex, 'hex'));
}
`

const PROBE_SOURCE_CHUNKS = chunkProbeSource(
  Buffer.from(KEYBOARD_PROBE_SOURCE).toString('base64'),
)
const DELIVERY_MARKERS = Array.from(
  { length: PROBE_SOURCE_CHUNKS.length + 1 },
  (_, index) => `__HVIR_KEYBOARD_DELIVERY_${index}__`,
)
const EXPECTED_EVENTS = [
  ...DELIVERY_MARKERS,
  CLIENT_STARTED_MARKER,
  ...KEYBOARD_PROBE_PHASES.flatMap((phase) =>
    phase.inputs.map((input) => keyboardProbeInputMarker(phase, input)),
  ),
  EXPECTED_SUCCESS_MARKER,
  CLOSED_SUCCESS_MARKER,
] as const

/** Prove that the bundled terminal encodes browser input from VT-negotiated state. */
export async function verifyNegotiatedTerminalKeyboard(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  const terminal = requireSolePlainShellTerminal(supervisor, win.webContents.id)
  if (
    terminal.ownerId !== win.webContents.id ||
    supervisor.get(terminal.id)?.instanceId !== terminal.instanceId
  ) {
    throw new Error('keyboard negotiation requires the exact live Shell PTY')
  }

  const observation = new KeyboardProbeObservation()
  let terminalExit: string | undefined
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => observation.consume(data),
    onExit: (exit) => {
      terminalExit = exit.signal ? `signal ${exit.signal}` : `code ${exit.exitCode}`
    },
  })

  try {
    await focusExactTerminalEngine(win, terminal.id)
    for (const [index, command] of keyboardProbeDeliveryCommands().entries()) {
      const deliveryMarker = DELIVERY_MARKERS[index]
      if (!deliveryMarker) throw new Error('keyboard probe delivery marker is missing')
      supervisor.write(terminal.id, terminal.ownerId, command)
      await waitForProbeObservation(
        observation,
        () => terminalExit,
        deliveryMarker,
        `keyboard probe delivery ${index} was not acknowledged`,
      )
    }
    supervisor.write(terminal.id, terminal.ownerId, keyboardProbeLaunchCommand())

    await waitForProbeObservation(
      observation,
      () => terminalExit,
      CLIENT_STARTED_MARKER,
      'keyboard probe client did not execute',
    )
    for (const phase of KEYBOARD_PROBE_PHASES) {
      for (const input of phase.inputs) {
        const marker = keyboardProbeInputMarker(phase, input)
        await waitForProbeObservation(
          observation,
          () => terminalExit,
          marker,
          `${phase.name} ${input.name} keyboard input did not become ready`,
        )
        await requireActiveTerminalEngine(win, terminal.id)
        win.webContents.sendInputEvent({
          type: 'keyDown',
          keyCode: input.keyCode,
          modifiers: [...input.modifiers],
        })
        win.webContents.sendInputEvent({
          type: 'keyUp',
          keyCode: input.keyCode,
          modifiers: [...input.modifiers],
        })
      }
    }

    await waitForProbeObservation(
      observation,
      () => terminalExit,
      EXPECTED_SUCCESS_MARKER,
      'negotiated keyboard probe did not report its exact transcript',
    )
    await waitForProbeObservation(
      observation,
      () => terminalExit,
      CLOSED_SUCCESS_MARKER,
      'negotiated keyboard probe did not restore its terminal state',
    )
    observation.assertExactEvents()

    const retained = supervisor.get(terminal.id)
    if (
      retained?.instanceId !== terminal.instanceId ||
      retained.providerId !== terminal.providerId
    ) {
      throw new Error('keyboard negotiation replaced its Shell PTY')
    }
  } finally {
    if (!observation.closed) {
      try {
        const retained = supervisor.get(terminal.id)
        if (retained?.instanceId === terminal.instanceId) {
          supervisor.write(terminal.id, terminal.ownerId, '\x03')
          await waitForProbeClosure(observation)
        }
      } catch {
        // Preserve the original failure; scenario teardown owns an unresponsive PTY.
      }
    }
    await detach()
  }
}

function requireSolePlainShellTerminal(
  supervisor: PtySupervisor,
  ownerId: number,
): ManagedPty {
  const owned = supervisor.list().filter((terminal) => terminal.ownerId === ownerId)
  if (owned.length !== 1 || owned[0]!.providerId !== plainShellProvider.manifest.id) {
    throw new Error('explicit launch did not retain one exact Shell-provider PTY')
  }
  return owned[0]!
}

function keyboardProbeInputMarker(
  phase: KeyboardProbePhase,
  input: KeyboardProbeInput,
): string {
  return `${READY_PREFIX}${phase.name}:${input.name}`
}

function chunkProbeSource(encoded: string): readonly string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < encoded.length; offset += PROBE_SOURCE_CHUNK_LENGTH) {
    chunks.push(encoded.slice(offset, offset + PROBE_SOURCE_CHUNK_LENGTH))
  }
  return chunks
}

function keyboardProbeDeliveryCommands(): readonly string[] {
  return [
    `${PROBE_SOURCE_VARIABLE}=''`,
    ...PROBE_SOURCE_CHUNKS.map(
      (chunk) => `${PROBE_SOURCE_VARIABLE}="$${PROBE_SOURCE_VARIABLE}"'${chunk}'`,
    ),
  ].map(
    (assignment, index) =>
      `${assignment}; printf '%s\\n' '__HVIR_KEYBOARD_DELIVERY_''${index}__'\n`,
  )
}

function keyboardProbeLaunchCommand(): string {
  return `printf '%s\\n' '__HVIR_KEYBOARD_CLIENT_''STARTED__'; node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$${PROBE_SOURCE_VARIABLE}"; unset ${PROBE_SOURCE_VARIABLE}\n`
}

class KeyboardProbeObservation {
  readonly events: string[] = []
  failed = false
  closed = false
  private suffix = ''

  consume(data: string): void {
    const combined = this.suffix + data
    const newlySeen = EXPECTED_EVENTS.filter(
      (marker) => !this.events.includes(marker) && combined.includes(marker),
    ).sort((left, right) => combined.indexOf(left) - combined.indexOf(right))
    this.events.push(...newlySeen)
    this.failed ||= combined.includes(FAILURE_PREFIX)
    this.closed ||= combined.includes(CLOSED_PREFIX)
    const retainedLength = Math.max(
      FAILURE_PREFIX.length,
      CLOSED_PREFIX.length,
      ...EXPECTED_EVENTS.map((marker) => marker.length),
    )
    this.suffix = combined.slice(-(retainedLength - 1))
  }

  has(marker: string): boolean {
    return this.events.includes(marker)
  }

  assertExactEvents(): void {
    if (
      this.events.length !== EXPECTED_EVENTS.length ||
      this.events.some((event, index) => event !== EXPECTED_EVENTS[index])
    ) {
      throw new Error('keyboard negotiation markers were missing or out of order')
    }
  }
}

async function requireActiveTerminalEngine(
  win: BrowserWindow,
  sessionId: string,
): Promise<void> {
  const active = (await win.webContents.executeJavaScript(`
    (() => {
      const surface = document.querySelector(
        '.terminal-surface[data-terminal-session="' +
        CSS.escape(${JSON.stringify(sessionId)}) + '"]'
      );
      const engine = surface?.querySelector('.terminal-engine-host');
      return surface?.classList.contains('active') === true &&
        getComputedStyle(surface).visibility === 'visible' &&
        engine instanceof HTMLElement &&
        (document.activeElement === engine || engine.contains(document.activeElement));
    })()
  `)) as boolean
  if (!active)
    throw new Error('keyboard input target was not the active matching terminal pane')
}

async function focusExactTerminalEngine(
  win: BrowserWindow,
  sessionId: string,
): Promise<void> {
  await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const poll = () => {
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' +
            CSS.escape(${JSON.stringify(sessionId)}) +
            '"]'
          );
          const engine = surface?.querySelector('.terminal-engine-host');
          if (surface?.classList.contains('active') && engine instanceof HTMLElement) {
            engine.focus();
            if (document.activeElement === engine || engine.contains(document.activeElement)) {
              resolve(undefined);
              return;
            }
          } else {
            const button = document.querySelector(
              '.terminal-list-main[data-terminal-session="' +
              CSS.escape(${JSON.stringify(sessionId)}) +
              '"]'
            );
            if (button instanceof HTMLElement) button.click();
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `)
}

async function waitForProbeObservation(
  observation: KeyboardProbeObservation,
  readTerminalExit: () => string | undefined,
  marker: string,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const poll = (): void => {
      if (observation.failed) {
        reject(new Error(`${message}: probe reported failure`))
        return
      }
      const terminalExit = readTerminalExit()
      if (terminalExit) {
        reject(new Error(`${message}: Shell PTY exited with ${terminalExit}`))
        return
      }
      if (observation.has(marker)) {
        resolve()
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

async function waitForProbeClosure(observation: KeyboardProbeObservation): Promise<void> {
  await new Promise<void>((resolve) => {
    const poll = (): void => {
      if (observation.closed) {
        resolve()
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}
