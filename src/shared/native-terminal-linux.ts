import { LOCAL_HOST_ID, localPath, type HostPath } from './host-path'

export type NativeTerminalExportMode = 'auto' | 'pixels'
/** Trusted startup selection; a device cannot change within a native epoch. */
export interface NativeTerminalLinuxOptions {
  readonly device:
    | { readonly kind: 'default' }
    | { readonly kind: 'drm-render-node'; readonly node: HostPath }
  readonly presentationMode: NativeTerminalExportMode
}

export function validNativeTerminalExportMode(
  value: unknown,
): value is NativeTerminalExportMode {
  return value === 'auto' || value === 'pixels'
}

export function validNativeTerminalLinuxOptions(
  value: unknown,
): value is NativeTerminalLinuxOptions {
  if (!value || typeof value !== 'object') return false
  const config = value as NativeTerminalLinuxOptions
  if (
    Object.keys(config).some((key) => !['device', 'presentationMode'].includes(key)) ||
    !validNativeTerminalExportMode(config.presentationMode) ||
    !config.device ||
    typeof config.device !== 'object'
  )
    return false
  if (config.device.kind === 'default')
    return Object.keys(config.device).every((key) => key === 'kind')
  return (
    config.device.kind === 'drm-render-node' &&
    Object.keys(config.device).every((key) => ['kind', 'node'].includes(key)) &&
    !!config.device.node &&
    typeof config.device.node === 'object' &&
    Object.keys(config.device.node).every((key) => ['hostId', 'path'].includes(key)) &&
    config.device.node.hostId === LOCAL_HOST_ID &&
    typeof config.device.node.path === 'string' &&
    config.device.node.path.length <= 64 &&
    /^\/dev\/dri\/renderD[0-9]+$/.test(config.device.node.path)
  )
}

/** Pure selection policy shared by trusted main startup and qualification tools.
 * This does not read ambient environment or grant renderer configuration authority. */
export function nativeTerminalLinuxOptionsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): NativeTerminalLinuxOptions {
  const device = environment['HVIR_NATIVE_TERMINAL_DEVICE'] ?? 'default'
  const mode = environment['HVIR_NATIVE_TERMINAL_PRESENTATION'] ?? 'auto'
  if (!validNativeTerminalExportMode(mode))
    throw new Error('native-linux-presentation-invalid')
  if (device !== 'default' && !/^\/dev\/dri\/renderD[0-9]+$/.test(device))
    throw new Error('native-linux-device-invalid')
  const options: NativeTerminalLinuxOptions = {
    device:
      device === 'default'
        ? { kind: 'default' }
        : { kind: 'drm-render-node', node: localPath(device) },
    presentationMode: mode,
  }
  if (!validNativeTerminalLinuxOptions(options))
    throw new Error('native-linux-device-invalid')
  return options
}
