import { arch, platform, release } from 'node:os'
import type { App } from 'electron'

const SESSION_KEYS = [
  'XDG_SESSION_TYPE',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_CURRENT_DESKTOP',
  'EGL_PLATFORM',
  'DRI_PRIME',
  'LIBGL_ALWAYS_SOFTWARE',
  'MESA_LOADER_DRIVER_OVERRIDE',
  '__NV_PRIME_RENDER_OFFLOAD',
  '__GLX_VENDOR_LIBRARY_NAME',
] as const
const GPU_FIELDS = [
  'vendorId',
  'deviceId',
  'active',
  'vendorString',
  'deviceString',
  'driverVendor',
  'driverVersion',
  'glVendor',
  'glRenderer',
  'glVersion',
] as const
function gpuFields(value: unknown): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Record<string, unknown>
  const result: Record<string, string | number | boolean> = {}
  for (const key of GPU_FIELDS) {
    const value = raw[key]
    if (typeof value === 'string') result[key] = value.slice(0, 256)
    else if (
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      result[key] = value
  }
  return result
}

/** Call after a real qualification window starts. Explicit startup selection is
 * source-backed inference, separate from a direct runtime backend observation. */
export async function nativeTerminalDiagnostics(
  application: Pick<App, 'getGPUInfo' | 'getGPUFeatureStatus' | 'commandLine'>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: unknown
  let gpuInfoAvailable = false
  try {
    raw = await Promise.race([
      application.getGPUInfo('basic'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('gpu-diagnostic-timeout')), 1000)
      }),
    ])
    gpuInfoAvailable = !!raw && typeof raw === 'object'
  } catch {
    /* Unknown is honest when the GPU process cannot answer. */
  } finally {
    if (timer) clearTimeout(timer)
  }
  const info = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const devices = Array.isArray(info['gpuDevice']) ? info['gpuDevice'] : []
  const features: Record<string, string> = {}
  for (const [key, value] of Object.entries(application.getGPUFeatureStatus()).slice(
    0,
    32,
  ))
    if (typeof value === 'string') features[key.slice(0, 64)] = value.slice(0, 256)
  const requestedOzonePlatform = application.commandLine
    .getSwitchValue('ozone-platform')
    .slice(0, 64)
  const explicit = environment['HVIR_NATIVE_TERMINAL_OZONE']
  const successfulExplicitSelection =
    platform() === 'linux' &&
    (explicit === 'x11' || explicit === 'wayland') &&
    explicit === requestedOzonePlatform
      ? {
          backend: explicit,
          basis: 'explicit-switch-and-successful-window-startup' as const,
        }
      : null
  return {
    os: { platform: platform(), arch: arch(), kernel: release().slice(0, 256) },
    gpuInfoAvailable,
    electronGpu: gpuFields(info),
    devices: devices.slice(0, 16).map(gpuFields),
    gpuFeatures: features,
    requestedOzonePlatform: requestedOzonePlatform || 'unspecified',
    successfulExplicitSelection,
    actualOzoneBackend: 'unknown' as const,
    session: Object.fromEntries(
      SESSION_KEYS.map((key) => [key, environment[key]?.slice(0, 256) ?? null]),
    ),
  }
}
