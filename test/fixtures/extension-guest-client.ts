import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'

export interface PackageClient {
  request(capability: string, input?: unknown, signal?: AbortSignal): Promise<unknown>
  dispose(): void
  readonly signal: AbortSignal
  readonly alive: boolean
}
interface ActionClient extends PackageClient {
  reply(value?: unknown, error?: string): Promise<boolean>
}
export interface GuestClient extends PackageClient {
  forAction(invocation: { readonly id: string }): ActionClient
  hello(): void
  readonly visible: boolean
}
export function guestClientFixture(
  clamped = false,
  send?: (message: Record<string, unknown>) => void,
) {
  const sent: Array<Record<string, unknown>> = []
  const times: number[] = []
  let receive!: (message: unknown) => void
  const bundled = buildSync({
    entryPoints: ['src/shared/extensions/guest-client.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Bridge',
    write: false,
  })
  const context = { Date, AbortController, Bridge: undefined as unknown }
  runInNewContext(bundled.outputFiles[0]!.text, context)
  const module = context.Bridge as {
    guestClient(bridge: unknown, clock: unknown): GuestClient
  }
  const client = module.guestClient(
    {
      onMessage(callback: typeof receive) {
        receive = callback
        return () => undefined
      },
      send(message: Record<string, unknown>) {
        sent.push(message)
        times.push(performance.now())
        send?.(message)
      },
    },
    {
      setTimeout: (callback: () => void, delay: number) =>
        setTimeout(callback, clamped ? Math.max(delay, 1000) : delay),
      clearTimeout,
      performance,
    },
  )
  return { client, receive: (message: unknown) => receive(message), sent, times }
}
