/** Static IPC composition only: these witnesses carry types, never handlers or validators. */
interface InvokeDeclaration<Request, Response, Access extends 'renderer' | 'preload'> {
  /** Phantom payload types; no request or response data is allocated here. */
  readonly types: { request: Request; response: Response }
  readonly access: Access
}

interface PayloadDeclaration<Payload> {
  readonly types: Payload
}

export function invoke<Request, Response>(): InvokeDeclaration<
  Request,
  Response,
  'renderer'
> {
  return { access: 'renderer' } as InvokeDeclaration<Request, Response, 'renderer'>
}

export function preloadInvoke<Request, Response>(): InvokeDeclaration<
  Request,
  Response,
  'preload'
> {
  return { access: 'preload' } as InvokeDeclaration<Request, Response, 'preload'>
}

export function payload<Payload>(): PayloadDeclaration<Payload> {
  return {} as PayloadDeclaration<Payload>
}

export interface IpcFeatureContract {
  readonly invoke: Readonly<
    Record<string, InvokeDeclaration<unknown, unknown, 'renderer' | 'preload'>>
  >
  readonly send: Readonly<Record<string, PayloadDeclaration<unknown>>>
  readonly event: Readonly<Record<string, PayloadDeclaration<unknown>>>
}

type Channels<F extends IpcFeatureContract> =
  keyof F['invoke'] | keyof F['send'] | keyof F['event']
type InternalDuplicates<F extends IpcFeatureContract> =
  | Extract<keyof F['invoke'], keyof F['send'] | keyof F['event']>
  | Extract<keyof F['send'], keyof F['event']>
type DuplicateChannels<
  Features extends readonly IpcFeatureContract[],
  Seen = never,
> = Features extends readonly [
  infer First extends IpcFeatureContract,
  ...infer Rest extends readonly IpcFeatureContract[],
]
  ? | InternalDuplicates<First>
    | Extract<Channels<First>, Seen>
    | DuplicateChannels<Rest, Seen | Channels<First>>
  : never
type UniqueChannels<F extends readonly IpcFeatureContract[]> = [
  DuplicateChannels<F>,
] extends [never]
  ? unknown
  : { readonly duplicateIpcChannels: DuplicateChannels<F> }

type Intersect<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never
type Combined<Features extends readonly IpcFeatureContract[]> = {
  [Direction in keyof IpcFeatureContract]: Intersect<Features[number][Direction]>
}

export type InvokeMap<Contract extends IpcFeatureContract> = {
  [Channel in keyof Contract['invoke']]: Contract['invoke'][Channel]['types']
}
export type SendMap<Contract extends IpcFeatureContract> = {
  [Channel in keyof Contract['send']]: Contract['send'][Channel]['types']
}
export type EventMap<Contract extends IpcFeatureContract> = {
  [Channel in keyof Contract['event']]: Contract['event'][Channel]['types']
}
export type PreloadOnlyChannel<Contract extends IpcFeatureContract> = {
  [
    Channel in keyof Contract['invoke']
  ]: Contract['invoke'][Channel]['access'] extends 'preload' ? Channel : never
}[keyof Contract['invoke']]

/** One closed application composition. Duplicate wire names fail before bridge admission. */
export function composeIpcContracts<const Features extends readonly IpcFeatureContract[]>(
  ...features: Features & UniqueChannels<Features>
): Combined<Features> {
  const combined: { [Direction in keyof IpcFeatureContract]: Record<string, unknown> } = {
    invoke: {},
    send: {},
    event: {},
  }
  const seen = new Set<string>()
  for (const feature of features) {
    for (const direction of ['invoke', 'send', 'event'] as const) {
      for (const [channel, declaration] of Object.entries(feature[direction])) {
        if (seen.has(channel)) throw new Error(`Duplicate IPC channel '${channel}'`)
        if (direction === 'invoke') {
          const access = (declaration as IpcFeatureContract['invoke'][string]).access
          if (access !== 'renderer' && access !== 'preload') {
            throw new Error(`Invalid IPC invoke classification for '${channel}'`)
          }
        }
        seen.add(channel)
        Object.defineProperty(combined[direction], channel, {
          value: declaration,
          enumerable: true,
        })
      }
    }
  }
  return combined as Combined<Features>
}

/** Keys come from declarations, never a second handwritten allowlist. */
export function ipcChannels<Declarations extends object>(
  declarations: Declarations,
): readonly (keyof Declarations & string)[] {
  return Object.keys(declarations) as (keyof Declarations & string)[]
}
