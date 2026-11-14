import type { Frame } from './engine'
export interface Endpoint {
  readonly nativeTerminalEndpoint: unique symbol
}
export interface Receipt extends Omit<
  Frame,
  'lease' | 'streamSequence' | 'geometrySerial' | 'snapshotMutation' | 'pixels'
> {
  ticket: string
}
declare const resource: {
  createEndpoint(address: string): Promise<Endpoint>
  receive(
    endpoint: Endpoint,
    expectedSenderPid: number,
    ticket: string,
    timeoutMs: number,
  ): Promise<Receipt>
  sendFrame(
    address: string,
    expectedReceiverPid: number,
    ticket: string,
    frame: Omit<
      Frame,
      'lease' | 'streamSequence' | 'geometrySerial' | 'snapshotMutation'
    >,
  ): Promise<void>
  release(receipt: Receipt): void
  closeEndpoint(endpoint: Endpoint): Promise<void>
}
export default resource
