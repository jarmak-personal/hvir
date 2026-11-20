import { describe, expect, it, vi } from 'vitest'
import { reportNativeQueryFailure } from '../src/main/smoke/native-terminal-query-failure'

type Ports = Parameters<typeof reportNativeQueryFailure>[0]
const context = {
  phase: 'streaming-evidence',
  phaseTiming: [{ phase: 'streaming-evidence', atEpochMs: 1000 }],
  phaseTimingUnavailable: false,
}
const span = {
  fromMs: 1,
  toMs: 601,
  fromEpochMs: 1001,
  toEpochMs: 1601,
  durationMs: 600,
}
function fixture() {
  const proof: Awaited<ReturnType<Ports['proof']>> = {
    writes: [{ bytes: 99, sha256: 'private-clipboard-sentinel' }],
    opens: [{ target: 'private-link-sentinel', frame: 'private-frame', features: '' }],
    frames: 40,
    maxGapMs: 600,
    rendererTiming: {
      timeOriginMs: 1000,
      startedMs: 1,
      callbackProgress: {
        intervalMs: 10,
        unavailable: false,
        totalTimerCallbacks: 60,
        worst: {
          origin: 'install-to-first-advancing-raf',
          frame: span,
          callbacks: { ...span, entryMinusFrameTimestampMs: 2 },
          timer: {
            unavailable: false,
            callbacks: 59,
            firstMs: 2,
            lastMs: 600,
            maxSilenceMs: 10,
          },
        },
        records: [],
        crossingCount: 1,
        truncated: false,
      },
      firstFrameDelivery: null,
      worstGap: null,
      visibilityTransitions: [],
      visibilityTransitionCount: 0,
      visibilityTransitionsTruncated: false,
      timingReadFailed: false,
      nativeApiTiming: {
        supported: true,
        unavailable: false,
        spans: [{ name: 'capturePage', count: 2, worst: span }],
      },
      longTasks: {
        supported: true,
        unavailable: false,
        count: 1,
        records: [span],
        worst: span,
        truncated: false,
      },
    },
  }
  const output = vi.fn<(line: string) => void>()
  const ports: Ports = {
    producer: () => Promise.resolve(undefined),
    renderer: () => Promise.resolve(undefined),
    ui: () => Promise.resolve({ status: '2 of 3', unavailable: false }),
    proof: () => Promise.resolve(proof),
    captureTiming: () => ({
      count: 0,
      spans: [],
      worst: undefined,
      truncated: false,
      unavailable: false,
    }),
    output,
  }
  return { ports, proof, output }
}
function emitted(output: ReturnType<typeof fixture>['output']) {
  const line = output.mock.calls[0]?.[0]
  expect(line).toMatch(/^HVIR_NATIVE_QUERY_FAILURE_FACTS /)
  return JSON.parse(line!.slice('HVIR_NATIVE_QUERY_FAILURE_FACTS '.length)) as Record<
    string,
    unknown
  >
}

describe('native query failure proof retention', () => {
  it('retains native health and frame scalars without renderer strings or resource metadata', async () => {
    const { ports, output } = fixture()
    const geometry = {
      serial: 3,
      columns: 101,
      rows: 19,
      width: 817,
      height: 295,
      cellWidth: 8,
      cellHeight: 15,
      contentWidth: 813,
      contentHeight: 291,
      paddingLeft: 2,
      paddingTop: 2,
      backingScale: 1,
    }
    ports.producer = () =>
      Promise.resolve({
        geometry,
        ioAppliedSequence: 32,
        ioAppliedMutation: 17,
        inputFailure: 0,
        appliedSequence: 32,
        replySequence: 32,
        queuedReplyBytes: 0,
        failure: 0,
        closing: false,
        rendererHealth: 0,
        presentationFailure: 0,
        frameCopies: 0,
        geometryFailureSerial: 0,
        appliedAppearanceSerial: 1,
        appearanceFailureSerial: 0,
      })
    const frame = {
      screen: 0 as const,
      streamSequence: 29,
      snapshotMutation: 17,
      geometrySerial: 3,
      kind: 1,
      width: 817,
      height: 295,
      colorSpace: 2,
      origin: 1,
      premultiplied: true,
    }
    ports.renderer = () =>
      Promise.resolve({
        available: true,
        glVendor: 'private-vendor',
        glRenderer: 'private-renderer',
        glVersion: 'private-version',
        eglVendor: 'private-egl',
        eglVersion: 'private-egl-version',
        pixelFrames: 0,
        dmaBufFrames: 0,
        frameCopies: 0,
        lastFrame: {
          ...frame,
          resource: { fourcc: 123, modifier: 'private-modifier', planes: [] },
        },
      })
    await reportNativeQueryFailure(ports, context)
    expect(emitted(output)).toMatchObject({
      geometry,
      ioAppliedSequence: 32,
      ioAppliedMutation: 17,
      producerFailure: 0,
      rendererHealth: 0,
      presentationFailure: 0,
      nativeLastFrame: frame,
      unavailable: { producer: false, renderer: false },
    })
    expect(output.mock.calls[0]![0]).not.toContain('private-')
    expect(emitted(output).nativeLastFrame).not.toHaveProperty('resource')
  })

  it('serializes nested existing timing while excluding clipboard, links and extra proof fields', async () => {
    const { ports, proof, output } = fixture()
    ports.proof = () =>
      Promise.resolve({
        ...proof,
        rawError: 'private-error-sentinel',
        id: 'private-id-sentinel',
      })
    await reportNativeQueryFailure(ports, context)
    const record = emitted(output)
    expect(record).toMatchObject({
      ...context,
      frames: 40,
      maxGapMs: 600,
      rendererTiming: proof.rendererTiming,
      ui: { status: '2 of 3', unavailable: false },
      captureTiming: { count: 0, spans: [], truncated: false, unavailable: false },
      unavailable: {
        producer: true,
        renderer: true,
        ui: false,
        proof: false,
        captureTiming: false,
      },
    })
    expect(output.mock.calls[0]![0]).not.toContain('private-')
    expect(record).not.toHaveProperty('writes')
    expect(record).not.toHaveProperty('opens')
  })

  it.each(['missing', 'rejected'] as const)(
    'marks %s proof unavailable while retaining other observations',
    async (kind) => {
      const { ports, output } = fixture()
      ports.proof = () =>
        kind === 'rejected'
          ? Promise.reject(new Error('private-rejection'))
          : Promise.resolve(undefined)
      await expect(reportNativeQueryFailure(ports, context)).resolves.toBeUndefined()
      const record = emitted(output)
      expect(record).toMatchObject({
        unavailable: { proof: true, ui: false },
        ui: { status: '2 of 3' },
      })
      expect(record).not.toHaveProperty('frames')
      expect(record).not.toHaveProperty('maxGapMs')
      expect(output.mock.calls[0]![0]).not.toContain('private-')
    },
  )

  it('contains independent synchronous and asynchronous read failures without losing available proof', async () => {
    const { ports, output } = fixture()
    ports.producer = () => {
      throw new Error('private-producer')
    }
    ports.renderer = () => Promise.reject(new Error('private-renderer'))
    ports.ui = () => Promise.reject(new Error('private-ui'))
    ports.captureTiming = () => {
      throw new Error('private-capture')
    }
    await expect(reportNativeQueryFailure(ports, context)).resolves.toBeUndefined()
    expect(emitted(output)).toMatchObject({
      unavailable: {
        producer: true,
        renderer: true,
        ui: true,
        proof: false,
        captureTiming: true,
      },
      frames: 40,
    })
    expect(output.mock.calls[0]![0]).not.toContain('private-')
  })

  it('contains projection, serialization and output failures so the caller retains its original cause', async () => {
    const { ports, proof } = fixture()
    const original = new Error('original-query-cause')
    for (const failure of ['projection', 'serialization', 'output']) {
      const attempt: Ports = { ...ports }
      if (failure === 'projection')
        attempt.proof = () =>
          Promise.resolve({
            ...proof,
            get frames(): number {
              throw new Error('private-projection')
            },
          })
      if (failure === 'serialization')
        attempt.proof = () =>
          Promise.resolve({
            ...proof,
            rendererTiming: {
              ...proof.rendererTiming,
              toJSON() {
                throw new Error('private-serialization')
              },
            },
          })
      if (failure === 'output')
        attempt.output = () => {
          throw new Error('private-output')
        }
      const qualification = async () => {
        try {
          throw original
        } catch (cause) {
          await reportNativeQueryFailure(attempt, context)
          throw cause
        }
      }
      await expect(qualification()).rejects.toBe(original)
    }
  })
})
