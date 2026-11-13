import { describe, expect, it } from 'vitest'
import { hostPath, asHostId, localPath } from '../src/shared/host-path'
import {
  nativeTerminalLinuxOptionsFromEnvironment as parse,
  validNativeTerminalLinuxOptions as valid,
} from '../src/shared/native-terminal-linux'

describe('trusted Linux native startup selection', () => {
  it('defaults explicitly and preserves a local render-node selection', () => {
    expect(parse({})).toEqual({ device: { kind: 'default' }, presentationMode: 'auto' })
    expect(
      parse({
        HVIR_NATIVE_TERMINAL_DEVICE: '/dev/dri/renderD128',
        HVIR_NATIVE_TERMINAL_PRESENTATION: 'pixels',
      }),
    ).toEqual({
      device: { kind: 'drm-render-node', node: localPath('/dev/dri/renderD128') },
      presentationMode: 'pixels',
    })
  })
  it.each([
    '',
    '../renderD128',
    '/dev/dri/../dri/renderD128',
    '/dev/dri/card0',
    '/dev/dri/renderD128\0',
    `/dev/dri/renderD${'1'.repeat(80)}`,
  ])('rejects an invalid device before normalization: %j', (device) => {
    expect(() => parse({ HVIR_NATIVE_TERMINAL_DEVICE: device })).toThrow(
      'native-linux-device-invalid',
    )
  })
  it.each(['', 'gpu', 'PIXELS', 'pixels\0'])(
    'rejects unknown presentation selection: %j',
    (mode) => {
      expect(() => parse({ HVIR_NATIVE_TERMINAL_PRESENTATION: mode })).toThrow(
        'native-linux-presentation-invalid',
      )
    },
  )
  it('keeps the worker DTO closed and requires a local host-qualified node', () => {
    const selected = parse({ HVIR_NATIVE_TERMINAL_DEVICE: '/dev/dri/renderD128' })
    expect(valid(selected)).toBe(true)
    expect(
      valid({
        ...selected,
        device: {
          kind: 'drm-render-node',
          node: hostPath(asHostId('remote'), '/dev/dri/renderD128'),
        },
      }),
    ).toBe(false)
    expect(
      valid({
        ...selected,
        device: { kind: 'drm-render-node', node: '/dev/dri/renderD128' },
      }),
    ).toBe(false)
    expect(valid({ ...selected, eglDisplay: 17 })).toBe(false)
    expect(
      valid({
        ...selected,
        device: { kind: 'default', node: localPath('/dev/dri/renderD128') },
      }),
    ).toBe(false)
  })
})
