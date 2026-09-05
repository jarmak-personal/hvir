import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'

/** Basic app/runtime info — the trivial round-trip that proves the contract. */
export interface AppInfo {
  readonly appVersion: string
  readonly electronVersion: string
  readonly chromeVersion: string
  readonly nodeVersion: string
  readonly platform: string
}

export interface EchoRequest {
  readonly text: string
}

export interface EchoResponse {
  readonly text: string
  readonly workerPid: number
}

export const appIpc = {
  invoke: {
    'app:info': invoke<void, AppInfo>(),
    'demo:echo': invoke<EchoRequest, EchoResponse>(),
  },
  send: {
    'app:renderer-ready': payload<{ readonly ownerGeneration: number }>(),
    'app:attention': payload<{ readonly count: number }>(),
  },
  event: {},
} satisfies IpcFeatureContract
