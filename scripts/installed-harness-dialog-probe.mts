const DEVTOOLS_TIMEOUT_MS = 15_000
const EXERCISE_TIMEOUT_MS = 20_000
const POLL_MS = 50

interface DevToolsTarget {
  readonly type: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpResponse {
  readonly id?: number
  readonly error?: { readonly message?: string }
  readonly result?: {
    readonly result?: { readonly value?: unknown }
    readonly exceptionDetails?: { readonly text?: string }
  }
}

export function parseDevToolsActivePort(value: string): number {
  const [portLine] = value.split(/\r?\n/)
  const port = Number(portLine)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Installed harness probe received an invalid DevTools port')
  }
  return port
}

export async function exerciseInstalledHarnessDialogs(
  readActivePort: () => Promise<string>,
): Promise<string> {
  const target = await waitForDevToolsTarget(readActivePort)
  const client = await CdpClient.connect(target)
  try {
    return await withTimeout(
      client.evaluate(INSTALLED_HARNESS_DIALOG_EXERCISE),
      EXERCISE_TIMEOUT_MS,
      'Installed harness dialog exercise timed out',
    )
  } finally {
    client.close()
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForDevToolsTarget(
  readActivePort: () => Promise<string>,
): Promise<string> {
  const deadline = performance.now() + DEVTOOLS_TIMEOUT_MS
  let lastFailure: unknown
  do {
    try {
      const activePort = await readActivePort()
      const port = parseDevToolsActivePort(activePort)
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (!response.ok)
        throw new Error(`DevTools target list returned ${response.status}`)
      const targets = (await response.json()) as readonly DevToolsTarget[]
      const target = targets.find(
        ({ type, webSocketDebuggerUrl }) =>
          type === 'page' && typeof webSocketDebuggerUrl === 'string',
      )?.webSocketDebuggerUrl
      if (target) return target
    } catch (reason) {
      lastFailure = reason
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, POLL_MS))
  } while (performance.now() < deadline)
  throw new Error('Installed hvir did not expose a renderer debugging target', {
    cause: lastFailure,
  })
}

class CdpClient {
  readonly #socket: WebSocket
  readonly #pending = new Map<
    number,
    { resolve: (response: CdpResponse) => void; reject: (reason: Error) => void }
  >()
  #nextId = 1

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data)) as CdpResponse
      if (response.id === undefined) return
      const pending = this.#pending.get(response.id)
      if (!pending) return
      this.#pending.delete(response.id)
      if (response.error) {
        pending.reject(new Error(response.error.message ?? 'DevTools command failed'))
      } else {
        pending.resolve(response)
      }
    })
    socket.addEventListener('close', () => {
      const error = new Error('Installed hvir renderer debugging target closed')
      for (const pending of this.#pending.values()) pending.reject(error)
      this.#pending.clear()
    })
  }

  static connect(url: string): Promise<CdpClient> {
    return new Promise((resolveClient, rejectClient) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolveClient(new CdpClient(socket)), {
        once: true,
      })
      socket.addEventListener(
        'error',
        () => rejectClient(new Error('Could not connect to installed hvir renderer')),
        { once: true },
      )
    })
  }

  async evaluate(expression: string): Promise<string> {
    const response = await this.#send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    const exception = response.result?.exceptionDetails
    if (exception) {
      throw new Error(exception.text ?? 'Installed harness dialog exercise failed')
    }
    const value = response.result?.result?.value
    if (typeof value !== 'string') {
      throw new Error('Installed harness dialog exercise returned invalid evidence')
    }
    return value
  }

  close(): void {
    this.#socket.close()
  }

  #send(method: string, params: Record<string, unknown>): Promise<CdpResponse> {
    const id = this.#nextId++
    return new Promise((resolveResponse, rejectResponse) => {
      this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

const INSTALLED_HARNESS_DIALOG_EXERCISE = String.raw`
  (async () => {
    const deadline = () => Date.now() + 8000;
    const waitFor = (read, message) => new Promise((resolve, reject) => {
      const expires = deadline();
      const poll = () => {
        const value = read();
        if (value) return resolve(value);
        if (Date.now() >= expires) return reject(new Error(message));
        setTimeout(poll, 25);
      };
      poll();
    });
    const pendingDialog = () => {
      const dialog = document.querySelector('.add-harness-dialog');
      const claude = [...document.querySelectorAll('.add-harness-candidates label')]
        .find((label) => label.querySelector('strong')?.textContent?.trim() === 'Claude Code');
      const detail = claude?.querySelector('small')?.textContent?.trim();
      return dialog instanceof HTMLElement && detail === 'Checking…' ? dialog : undefined;
    };
    const closeAddDialog = async (dialog) => {
      const cancel = [...dialog.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Cancel');
      if (!(cancel instanceof HTMLButtonElement)) throw new Error('Add-harness cancel missing');
      cancel.click();
      await waitFor(
        () => !document.querySelector('.add-harness-dialog'),
        'Add-harness dialog did not close while probes were pending'
      );
    };

    const addTerminal = await waitFor(
      () => document.querySelector('button[aria-label="New terminal"]'),
      'New-terminal action missing'
    );
    addTerminal.click();
    const directAdd = await waitFor(
      () => [...document.querySelectorAll('.terminal-new-menu button')]
        .find((button) => button.textContent?.trim() === 'Add a harness…'),
      'Direct add-harness action missing'
    );
    directAdd.click();
    const directDialog = await waitFor(
      pendingDialog,
      'Direct add-harness entry did not paint while the real provider probe was pending'
    );
    await closeAddDialog(directDialog);

    const openSettings = await waitFor(
      () => document.querySelector('button[aria-label="Open settings"]'),
      'Settings action missing'
    );
    openSettings.click();
    const harnesses = await waitFor(
      () => [...document.querySelectorAll('.settings-section-index button')]
        .find((button) => button.textContent?.trim() === 'Harnesses'),
      'Harnesses settings section missing'
    );
    harnesses.click();
    const settingsAdd = await waitFor(
      () => [...document.querySelectorAll('.settings-harness-actions button')]
        .find((button) => button.textContent?.trim() === 'Add a harness…'),
      'Settings add-harness action missing'
    );
    settingsAdd.click();
    const settingsDialog = await waitFor(
      pendingDialog,
      'Settings add-harness entry did not paint while the real provider probe was pending'
    );
    await closeAddDialog(settingsDialog);

    const closeSettings = [...document.querySelectorAll('.settings-dialog button')]
      .find((button) => button.textContent?.trim() === 'Close settings');
    if (!(closeSettings instanceof HTMLButtonElement)) {
      throw new Error('Close-settings action missing after harness probe');
    }
    closeSettings.click();
    await waitFor(
      () => !document.querySelector('.settings-dialog'),
      'Workbench did not remain interactive after harness probes'
    );
    return 'both add-harness entries painted and closed while Claude probe was pending';
  })()
`
