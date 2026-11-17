import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { nativeSelectionBrowser } from './native-terminal-selection-browser'

type Browser = ReturnType<typeof nativeSelectionBrowser>
type Producer = Awaited<ReturnType<NativeTerminalApplication['inspectRetained']>>
type Renderer = Awaited<ReturnType<NativeTerminalApplication['rendererInfo']>>
type Proof = Awaited<ReturnType<Browser['proof']>>

interface QueryFailurePorts {
  producer(): Promise<Producer | undefined>
  renderer(): Promise<Renderer | undefined>
  ui(): Promise<{ status: string; unavailable: boolean } | undefined>
  proof(): Promise<Proof | undefined>
  captureTiming(): ReturnType<Browser['captureTiming']> | undefined
  output(line: string): void
}

/** Failure-only observation of the existing owners, before the probe is restored.
 * Unresolved reads remain subject to the existing outer smoke process lifetime. */
export async function reportNativeQueryFailure(
  ports: QueryFailurePorts,
  context: {
    phase: string
    phaseTiming: readonly { phase: string; atEpochMs: number }[]
    phaseTimingUnavailable: boolean
  },
): Promise<void> {
  try {
    // Defer each call so synchronous adapter failures are contained independently.
    const [producer, renderer, ui, proof, captureTiming] = await Promise.all([
      Promise.resolve()
        .then(() => ports.producer())
        .catch(() => undefined),
      Promise.resolve()
        .then(() => ports.renderer())
        .catch(() => undefined),
      Promise.resolve()
        .then(() => ports.ui())
        .catch(() => undefined),
      Promise.resolve()
        .then(() => ports.proof())
        .catch(() => undefined),
      Promise.resolve()
        .then(() => ports.captureTiming())
        .catch(() => undefined),
    ])
    ports.output(
      'HVIR_NATIVE_QUERY_FAILURE_FACTS ' +
        JSON.stringify({
          phase: context.phase,
          phaseTiming: context.phaseTiming,
          phaseTimingUnavailable: context.phaseTimingUnavailable,
          unavailable: {
            producer: producer === undefined,
            renderer: renderer === undefined,
            ui: ui === undefined,
            proof: proof === undefined,
            captureTiming: captureTiming === undefined,
          },
          ui,
          geometry: producer?.geometry,
          ioAppliedSequence: producer?.ioAppliedSequence,
          ioAppliedMutation: producer?.ioAppliedMutation,
          producerFailure: producer?.failure,
          rendererHealth: producer?.rendererHealth,
          presentationFailure: producer?.presentationFailure,
          nativeLastFrame: renderer?.lastFrame && {
            screen: renderer.lastFrame.screen,
            streamSequence: renderer.lastFrame.streamSequence,
            snapshotMutation: renderer.lastFrame.snapshotMutation,
            geometrySerial: renderer.lastFrame.geometrySerial,
            kind: renderer.lastFrame.kind,
            width: renderer.lastFrame.width,
            height: renderer.lastFrame.height,
            colorSpace: renderer.lastFrame.colorSpace,
            origin: renderer.lastFrame.origin,
            premultiplied: renderer.lastFrame.premultiplied,
          },
          ...(proof && {
            frames: proof.frames,
            maxGapMs: proof.maxGapMs,
            rendererTiming: proof.rendererTiming,
          }),
          captureTiming,
        }),
    )
  } catch {
    // Projection, serialization and output must never replace the query's cause.
  }
}
