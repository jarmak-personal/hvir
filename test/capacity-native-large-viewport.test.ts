import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {}, screen: {}, clipboard: {}, utilityProcess: {} }))
import {
  capacityLargeViewportSelected,
  capacityLargeViewportWindowSize,
} from '../src/main/smoke/capacity-native-large-viewport'

const selected = {
  HVIR_CAPACITY_OBSERVATION: 'compatibility-large-viewport',
  HVIR_SMOKE_SCENARIO: 'capacity',
  HVIR_CAPACITY_DIAGNOSTIC_OUTPUT: '/tmp/large-viewport.json',
}
describe('closed large compatibility profile', () => {
  it('selects only its explicit Darwin diagnostic without changing other profiles', () => {
    expect(capacityLargeViewportSelected({}, 'darwin')).toBe(false)
    expect(
      capacityLargeViewportSelected({ HVIR_CAPACITY_OBSERVATION: 'diagnostic' }, 'linux'),
    ).toBe(false)
    expect(capacityLargeViewportSelected(selected, 'darwin')).toBe(true)
    expect(() => capacityLargeViewportSelected(selected, 'linux')).toThrow('invocation')
    expect(() =>
      capacityLargeViewportSelected(
        { ...selected, HVIR_SMOKE_SCENARIO: 'native-terminal-workbench' },
        'darwin',
      ),
    ).toThrow('invocation')
  })
  it.each([
    'HVIR_CAPACITY_COMPARISON_INDEX',
    'HVIR_CAPACITY_COMPARISON_RUN_ID',
    'HVIR_CAPACITY_PERFORMANCE_GATE',
    'HVIR_NATIVE_IMPORT_DIAGNOSTICS',
    'HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW',
    'HVIR_NATIVE_TERMINAL_PRESENTATION',
    'HVIR_NATIVE_TERMINAL_TRACE_CONFIG',
  ])('rejects a conflicting %s even when its value is empty', (name) => {
    expect(() =>
      capacityLargeViewportSelected({ ...selected, [name]: '' }, 'darwin'),
    ).toThrow('invocation')
  })
  it.each([undefined, '', 'relative.json'])(
    'requires an absolute owned receipt destination instead of %s',
    (destination) => {
      expect(() =>
        capacityLargeViewportSelected(
          { ...selected, HVIR_CAPACITY_DIAGNOSTIC_OUTPUT: destination },
          'darwin',
        ),
      ).toThrow('invocation')
    },
  )
  it.each([
    [
      { width: 3840, height: 2160 },
      { width: 2220, height: 1300 },
    ],
    [
      { width: 5120, height: 2880 },
      { width: 2860, height: 1660 },
    ],
  ])(
    'corrects to genuine backing target %j using current DPR and measured chrome',
    (target, expected) => {
      expect(
        capacityLargeViewportWindowSize(
          { width: 1300, height: 900 },
          { width: 1000, height: 680 },
          target,
          2,
        ),
      ).toEqual(expected)
    },
  )
  it('does not manufacture a scale factor or treat content bounds as pane bounds', () => {
    expect(
      capacityLargeViewportWindowSize(
        { width: 1300, height: 900 },
        { width: 1000, height: 680 },
        { width: 3840, height: 2160 },
        1,
      ),
    ).toEqual({ width: 4140, height: 2380 })
  })
  it.each([0, -1, Infinity, NaN])('refuses invalid measured DPR %s', (dpr) => {
    expect(() =>
      capacityLargeViewportWindowSize(
        { width: 1300, height: 900 },
        { width: 1000, height: 680 },
        { width: 3840, height: 2160 },
        dpr,
      ),
    ).toThrow('geometry')
  })
})
