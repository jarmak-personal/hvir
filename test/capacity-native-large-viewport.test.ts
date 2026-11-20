import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
vi.mock('electron', () => ({ app: {}, screen: {}, clipboard: {}, utilityProcess: {} }))
import {
  capacityLargeViewportSelected,
  capacityLargeViewportWindowSize,
} from '../src/main/smoke/capacity-native-large-viewport'
import { capacityCompatibilityCanonicalSelected } from '../src/main/smoke/capacity-scenario'

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

describe('real smoke shell compatibility launch selection', () => {
  const script = readFileSync(new URL('../scripts/run-smoke.sh', import.meta.url), 'utf8')
  const block = script.slice(
    script.indexOf('smoke_compatibility_args=()'),
    script.indexOf('# Diagnostic only:'),
  )
  const invoke = (extra: Record<string, string | undefined>) =>
    spawnSync(
      '/bin/bash',
      [
        '-c',
        'set -euo pipefail\nuname(){ printf "%s\\n" "$MOCK_PLATFORM"; }\n' +
          block +
          '\nprintf "%s\\n" "${smoke_compatibility_args[*]}"',
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env['PATH'],
          MOCK_PLATFORM: 'Darwin',
          HVIR_SMOKE_SCENARIO: 'capacity',
          ...extra,
        },
      },
    )
  it.each([undefined, 'controlled'])(
    'launches the canonical workload software compositor with gate %s',
    (gate) => {
      const result = invoke({
        HVIR_CAPACITY_OBSERVATION: 'compatibility-canonical',
        ...(gate === undefined ? {} : { HVIR_CAPACITY_PERFORMANCE_GATE: gate }),
      })
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('--disable-gpu')
    },
  )
  it.each([
    { MOCK_PLATFORM: 'Linux' },
    { HVIR_SMOKE_SCENARIO: 'native-terminal-workbench' },
    { HVIR_CAPACITY_COMPARISON_RUN_ID: '' },
    { HVIR_NATIVE_IMPORT_DIAGNOSTICS: '' },
    { HVIR_NATIVE_TERMINAL_TRACE_CONFIG: '' },
    { HVIR_NATIVE_TERMINAL_PRESENTATION: 'pixels' },
    { HVIR_CAPACITY_DIAGNOSTIC_OUTPUT: '/tmp/diagnostic.json' },
    { HVIR_CAPACITY_PERFORMANCE_GATE: 'custom' },
    { HVIR_CAPACITY_PERFORMANCE_GATE: '' },
  ])('rejects conflicting invocation %j before launching Electron', (extra) => {
    expect(
      invoke({ HVIR_CAPACITY_OBSERVATION: 'compatibility-canonical', ...extra }).status,
    ).toBe(1)
  })
  it('retains ordinary launch and the distinct large-viewport output contract', () => {
    expect(invoke({}).stdout.trim()).toBe('')
    expect(
      invoke({
        HVIR_CAPACITY_OBSERVATION: 'compatibility-large-viewport',
        HVIR_CAPACITY_DIAGNOSTIC_OUTPUT: '/tmp/large.json',
      }).stdout.trim(),
    ).toBe('--disable-gpu')
    expect(
      invoke({
        HVIR_CAPACITY_OBSERVATION: 'compatibility-large-viewport',
        HVIR_CAPACITY_PERFORMANCE_GATE: 'controlled',
      }).status,
    ).toBe(1)
  })
})

describe('canonical compatibility application admission', () => {
  const environment = {
    HVIR_CAPACITY_OBSERVATION: 'compatibility-canonical',
    HVIR_SMOKE_SCENARIO: 'capacity',
  }
  it.each([undefined, 'controlled'])(
    'admits only the unchanged canonical gate %s',
    (gate) => {
      expect(
        capacityCompatibilityCanonicalSelected(
          {
            ...environment,
            ...(gate === undefined ? {} : { HVIR_CAPACITY_PERFORMANCE_GATE: gate }),
          },
          'darwin',
          ['--disable-gpu'],
        ),
      ).toBe(true)
    },
  )
  it.each(['', 'custom', 'evidence'])(
    'rejects an explicitly invalid gate %j even outside the shell owner',
    (gate) => {
      expect(() =>
        capacityCompatibilityCanonicalSelected(
          { ...environment, HVIR_CAPACITY_PERFORMANCE_GATE: gate },
          'darwin',
          ['--disable-gpu'],
        ),
      ).toThrow('invocation')
    },
  )
  it('leaves ordinary routes untouched and requires the actual software launch', () => {
    expect(capacityCompatibilityCanonicalSelected({}, 'darwin', [])).toBe(false)
    expect(() =>
      capacityCompatibilityCanonicalSelected(environment, 'darwin', []),
    ).toThrow('invocation')
    expect(() =>
      capacityCompatibilityCanonicalSelected(environment, 'linux', ['--disable-gpu']),
    ).toThrow('invocation')
  })
})
