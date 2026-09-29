import { DevelopmentPerformanceFixture } from './development-performance-fixture'
import { DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT } from './development-performance-events'

export interface DevelopmentRendererInstrumentation {
  readonly dispose: () => void
}

const ACTIVE_INSTRUMENTATION_KEY = '__hvirDevelopmentRendererInstrumentation'

/** Installs the disposable renderer fixture used by development Electron acceptance. */
export function installDevelopmentRendererInstrumentation(): DevelopmentRendererInstrumentation {
  const registry = window as typeof window & {
    [ACTIVE_INSTRUMENTATION_KEY]?: DevelopmentRendererInstrumentation
  }
  registry[ACTIVE_INSTRUMENTATION_KEY]?.dispose()
  let fixture: DevelopmentPerformanceFixture | undefined
  let disposed = false
  const startFixture = (): void => {
    if (disposed || fixture) return
    fixture = new DevelopmentPerformanceFixture()
    fixture.start()
  }

  window.addEventListener(DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT, startFixture)

  const instrumentation: DevelopmentRendererInstrumentation = {
    dispose: (): void => {
      if (disposed) return
      disposed = true
      fixture?.dispose()
      fixture = undefined
      window.removeEventListener('pagehide', instrumentation.dispose)
      window.removeEventListener(
        DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT,
        startFixture,
      )
      if (registry[ACTIVE_INSTRUMENTATION_KEY] === instrumentation) {
        delete registry[ACTIVE_INSTRUMENTATION_KEY]
      }
    },
  }
  registry[ACTIVE_INSTRUMENTATION_KEY] = instrumentation
  window.addEventListener('pagehide', instrumentation.dispose, { once: true })
  return instrumentation
}
