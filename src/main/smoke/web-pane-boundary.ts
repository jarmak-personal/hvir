import type { Server } from 'node:http'

const WEB_PANE_DIAGNOSIS_TIMEOUT_MS = 1_000
const WEB_PANE_SERVER_CLOSE_TIMEOUT_MS = 1_000

async function withWebPaneLifecycleTimeout<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Keep failure-state collection from replacing the original failure with a hang. */
export function withWebPaneDiagnosisTimeout<T>(operation: Promise<T>): Promise<T> {
  return withWebPaneLifecycleTimeout(
    operation,
    'web pane failure diagnosis timed out',
    WEB_PANE_DIAGNOSIS_TIMEOUT_MS,
  )
}

/** Refuse to let a lingering Chromium/service-worker socket stall fixture teardown. */
export async function closeWebPaneSmokeServer(server: Server): Promise<void> {
  if (!server.listening) return
  const closing = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  server.closeAllConnections()
  await withWebPaneLifecycleTimeout(
    closing,
    'web pane dashboard server close timed out',
    WEB_PANE_SERVER_CLOSE_TIMEOUT_MS,
  )
}
