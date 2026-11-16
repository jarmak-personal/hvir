const DEVTOOLS_TIMEOUT_MS = 15_000
const POLL_MS = 50

interface DevToolsTarget {
  readonly type: string
  readonly webSocketDebuggerUrl?: string
}

interface CdpResponse {
  readonly id?: number
  readonly error?: { readonly message?: string }
  readonly result?: {
    readonly data?: string
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

  async capturePixel(
    point: { x: number; y: number },
    expected: readonly number[],
  ): Promise<boolean> {
    if (
      ![point.x, point.y].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 32768,
      ) ||
      expected.length !== 3 ||
      !expected.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    )
      throw new Error('Installed renderer pixel snapshot selection invalid')
    const response = await this.#send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...point, width: 1, height: 1, scale: 1 },
      fromSurface: true,
      captureBeyondViewport: false,
    })
    const png = response.result?.data
    if (
      typeof png !== 'string' ||
      !png ||
      png.length > 16384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(png)
    )
      throw new Error('Installed renderer pixel snapshot invalid')
    // Chromium decodes its own tiny PNG. No decoder dependency, image artifact,
    // preserved WebGL drawing buffer or later default-framebuffer read is required.
    const observed = await this.evaluate(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify('data:image/png;base64,')} + ${JSON.stringify(png)};
      await image.decode();
      if (image.naturalWidth < 1 || image.naturalWidth > 8 || image.naturalHeight < 1 || image.naturalHeight > 8)
        throw new Error('Installed renderer snapshot dimensions');
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!context) throw new Error('Installed renderer snapshot decode context');
      context.drawImage(image, 0, 0);
      const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return JSON.stringify({ matched: ${JSON.stringify([...expected, 255])}.every((value, index) => Math.abs(pixel[index] - value) <= 4) });
    })()`)
    return (JSON.parse(observed) as { matched?: unknown }).matched === true
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

/** Exercise the ordinary installed renderer through its explicit local CDP lease. */
export async function evaluateInstalledRenderer(
  readActivePort: () => Promise<string>,
  expression: string,
  timeoutMs = 20_000,
): Promise<string> {
  const target = await waitForDevToolsTarget(readActivePort)
  const client = await CdpClient.connect(target)
  try {
    return await withTimeout(
      client.evaluate(expression),
      timeoutMs,
      'Installed renderer exercise timed out',
    )
  } finally {
    client.close()
  }
}

/** One explicit installed CDP lifetime proves a tiny compositor sample, then closes UI. */
export async function evaluateInstalledRendererWithPixelSnapshot(
  readActivePort: () => Promise<string>,
  prepareExpression: string,
  closeExpression: string,
  expected: readonly number[],
  visibleExpression: string,
): Promise<{ evidence: string }> {
  const target = await waitForDevToolsTarget(readActivePort)
  const client = await CdpClient.connect(target)
  let result: { evidence: string } | undefined
  let failure: unknown
  try {
    result = await withTimeout(
      (async () => {
        const prepared = JSON.parse(await client.evaluate(prepareExpression)) as {
          evidence?: unknown
          point?: { x: number; y: number }
        }
        if (
          typeof prepared.evidence !== 'string' ||
          prepared.evidence.length > 4096 ||
          !prepared.point
        )
          throw new Error('Installed renderer snapshot exercise invalid')
        const deadline = performance.now() + 12_000
        let matched: boolean
        do {
          if ((await client.evaluate(visibleExpression)) !== 'visible')
            throw new Error('Installed renderer snapshot visibility invalid')
          matched = await client.capturePixel(prepared.point, expected)
          if (matched) break
          await new Promise<void>((done) => setTimeout(done, 25))
        } while (performance.now() < deadline)
        if (!matched)
          throw new Error('Installed native terminal: compositor frame pixels')
        if ((await client.evaluate(visibleExpression)) !== 'visible')
          throw new Error('Installed renderer snapshot visibility lost')
        return { evidence: prepared.evidence }
      })(),
      45_000,
      'Installed renderer pixel exercise timed out',
    )
  } catch (error) {
    failure = error
  } finally {
    try {
      await withTimeout(
        client.evaluate(closeExpression),
        15_000,
        'Installed renderer close timed out',
      )
    } catch (error) {
      failure ??= error
    } finally {
      client.close()
    }
  }
  if (failure)
    throw failure instanceof Error
      ? failure
      : new Error('Installed renderer pixel exercise failed', { cause: failure })
  if (!result) throw new Error('Installed renderer snapshot evidence missing')
  return result
}
