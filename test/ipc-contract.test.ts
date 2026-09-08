import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  PRELOAD_ONLY_INVOKE_CHANNELS,
  RENDERER_INVOKE_CHANNELS,
  type HvirApi,
  type IpcInvokeMap,
  type IpcSendMap,
  type IpcEventMap,
  type ProjectState,
  type PreloadOnlyIpcInvokeChannel,
  type RendererIpcInvokeChannel,
} from '../src/shared/ipc'
import {
  composeIpcContracts,
  ipcChannels,
  invoke,
  preloadInvoke,
  payload,
  type IpcFeatureContract,
  type InvokeMap,
  type SendMap,
  type EventMap,
  type PreloadOnlyChannel,
} from '../src/shared/ipc-contract'
import type { ProjectState as WorkspaceProjectState } from '../src/shared/workspace-types'

const feature = {
  invoke: { 'fixture:read': invoke<{ id: string }, { value: number }>() },
  send: { 'fixture:write': payload<{ text: string }>() },
  event: { 'fixture:changed': payload<{ revision: number }>() },
} satisfies IpcFeatureContract
const preloadFeature = {
  invoke: { 'fixture:acquire': preloadInvoke<{ paths: readonly string[] }, boolean>() },
  send: {},
  event: {},
} satisfies IpcFeatureContract

describe('feature-owned IPC composition', () => {
  it('preserves representative payloads, project-state identity, and preload-only classification', () => {
    expect(
      new Set([...RENDERER_INVOKE_CHANNELS, ...PRELOAD_ONLY_INVOKE_CHANNELS]),
    ).toEqual(new Set(INVOKE_CHANNELS))
    expectTypeOf<ProjectState>().toEqualTypeOf<WorkspaceProjectState>()
    expectTypeOf<IpcInvokeMap['project:root']>().toEqualTypeOf<{
      request: void
      response: WorkspaceProjectState
    }>()
    expectTypeOf<IpcSendMap['pty:write']>().toEqualTypeOf<{
      readonly id: string
      readonly data: string
    }>()
    expectTypeOf<IpcEventMap['project:state']>().toEqualTypeOf<WorkspaceProjectState>()
    expectTypeOf<PreloadOnlyIpcInvokeChannel>().toEqualTypeOf<'fs:acquire-dropped-files'>()
    expectTypeOf<RendererIpcInvokeChannel>().toEqualTypeOf<
      Exclude<keyof IpcInvokeMap, 'fs:acquire-dropped-files'>
    >()
  })

  it('derives exact maps and manifests from one feature declaration', () => {
    const contract = composeIpcContracts(feature, preloadFeature)
    expect(ipcChannels(contract.invoke)).toEqual(['fixture:read', 'fixture:acquire'])
    expect(ipcChannels(contract.send)).toEqual(['fixture:write'])
    expect(ipcChannels(contract.event)).toEqual(['fixture:changed'])
    expectTypeOf<InvokeMap<typeof contract>>().toEqualTypeOf<{
      'fixture:read': { request: { id: string }; response: { value: number } }
      'fixture:acquire': { request: { paths: readonly string[] }; response: boolean }
    }>()
    expectTypeOf<SendMap<typeof contract>>().toEqualTypeOf<{
      'fixture:write': { text: string }
    }>()
    expectTypeOf<EventMap<typeof contract>>().toEqualTypeOf<{
      'fixture:changed': { revision: number }
    }>()
    expectTypeOf<PreloadOnlyChannel<typeof contract>>().toEqualTypeOf<'fixture:acquire'>()
    expect(contract.invoke['fixture:read'].access).toBe('renderer')
    expect(contract.invoke['fixture:acquire'].access).toBe('preload')
  })

  it('rejects duplicate feature keys even when their payload types are identical', () => {
    // @ts-expect-error identical declarations still have duplicate wire keys
    expect(() => composeIpcContracts(feature, feature)).toThrow('Duplicate IPC channel')
    const dynamic: readonly IpcFeatureContract[] = [feature, feature]
    expect(() => composeIpcContracts(...dynamic)).toThrow('Duplicate IPC channel')
  })

  it.each(['invoke', 'send', 'event'] as const)(
    'rejects duplicate %s declarations across features at runtime',
    (direction) => {
      const repeated: IpcFeatureContract = {
        invoke: direction === 'invoke' ? feature.invoke : {},
        send: direction === 'send' ? feature.send : {},
        event: direction === 'event' ? feature.event : {},
      }
      const dynamic: readonly IpcFeatureContract[] = [feature, repeated]
      expect(() => composeIpcContracts(...dynamic)).toThrow('Duplicate IPC channel')
    },
  )

  it('rejects a wire key shared across directions within or between features', () => {
    const crossDirection = {
      invoke: {},
      send: { 'fixture:read': payload<string>() },
      event: {},
    }
    // @ts-expect-error a wire name has exactly one direction and owner
    expect(() => composeIpcContracts(feature, crossDirection)).toThrow(
      'Duplicate IPC channel',
    )
    // @ts-expect-error duplicate directions within one feature are also invalid
    expect(() => composeIpcContracts({ ...feature, send: crossDirection.send })).toThrow(
      'Duplicate IPC channel',
    )
  })

  it('fails closed on an unclassified invoke instead of admitting it to the renderer', () => {
    const invalid = {
      invoke: { 'fixture:read': { access: 'unknown' } },
      send: {},
      event: {},
    }
    // @ts-expect-error classification must be explicit and supported
    expect(() => composeIpcContracts(invalid)).toThrow(
      'Invalid IPC invoke classification',
    )
  })
})

// Deliberately never executed: tsc checks both positive and negative public API contracts.
function compileTimeRejections(api: HvirApi) {
  // @ts-expect-error generic renderer invoke must never acquire dropped-file authority
  void api.invoke('fs:acquire-dropped-files', { paths: [] })
  // @ts-expect-error undeclared channels do not acquire authority
  void api.invoke('fixture:unknown', undefined)
  // @ts-expect-error payload mismatch is rejected through the composed feature map
  api.send('pty:write', { id: 'terminal', data: 123 })
  // @ts-expect-error event callbacks receive their feature-owned payload
  api.on('pty:exit', (event: { exitCode: string }) => {
    void event
  })
  // @ts-expect-error read-only manifests do not authorize caller mutation
  INVOKE_CHANNELS[0] = 'app:info'
  // @ts-expect-error renderer admission manifests do not authorize caller mutation
  RENDERER_INVOKE_CHANNELS[0] = 'app:info'
  // @ts-expect-error read-only manifests do not authorize caller mutation
  SEND_CHANNELS[0] = 'pty:write'
  // @ts-expect-error read-only manifests do not authorize caller mutation
  EVENT_CHANNELS[0] = 'pty:exit'
  // @ts-expect-error preload-only classification remains read-only
  PRELOAD_ONLY_INVOKE_CHANNELS[0] = 'fs:acquire-dropped-files'

  const contract = composeIpcContracts(feature, preloadFeature)
  // @ts-expect-error composed invoke completeness includes the preload-only channel
  const missingInvoke: Record<keyof InvokeMap<typeof contract>, true> = {
    'fixture:read': true,
  }
  // @ts-expect-error omitted send channel cannot satisfy the derived map
  const missingSend: Record<keyof SendMap<typeof contract>, true> = {}
  // @ts-expect-error omitted event channel cannot satisfy the derived map
  const missingEvent: Record<keyof EventMap<typeof contract>, true> = {}
  const wrongResponse: InvokeMap<typeof contract>['fixture:read']['response'] = {
    // @ts-expect-error mismatched response payload cannot satisfy the derived feature map
    value: 'wrong',
  }
  void [contract, missingInvoke, missingSend, missingEvent, wrongResponse]
}
void compileTimeRejections
