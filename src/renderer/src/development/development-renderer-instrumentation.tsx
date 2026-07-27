import {
  DevelopmentPerformanceFixture,
  DEVELOPMENT_PERFORMANCE_FIXTURE_EVENT,
} from './development-performance-fixture'
import {
  DevelopmentPerformanceMeasureBudget,
  DEVELOPMENT_MEASURE_ENTRY_BUDGET,
  DEVELOPMENT_MEASURE_INSPECTION_INTERVAL_MS,
  DEVELOPMENT_PERFORMANCE_MEASURE_POLICY_ID,
} from './performance-measure-budget'

export interface DevelopmentRendererInstrumentation {
  readonly dispose: () => void
}

const ACTIVE_INSTRUMENTATION_KEY = '__hvirDevelopmentRendererInstrumentation'

/** Installs renderer-local development containment and its disposable Electron fixture. */
export function installDevelopmentRendererInstrumentation(): DevelopmentRendererInstrumentation {
  const registry = window as typeof window & {
    [ACTIVE_INSTRUMENTATION_KEY]?: DevelopmentRendererInstrumentation
  }
  registry[ACTIVE_INSTRUMENTATION_KEY]?.dispose()
  const budget = new DevelopmentPerformanceMeasureBudget(performance, window)
  let fixture: DevelopmentPerformanceFixture | undefined
  let disposed = false
  const startFixture = (): void => {
    if (disposed) return
    fixture?.dispose()
    fixture = new DevelopmentPerformanceFixture()
    fixture.start()
  }

  document.documentElement.dataset.hvirDevelopmentPerformanceMeasureBudget = String(
    DEVELOPMENT_MEASURE_ENTRY_BUDGET,
  )
  document.documentElement.dataset.hvirDevelopmentPerformanceMeasureInterval = String(
    DEVELOPMENT_MEASURE_INSPECTION_INTERVAL_MS,
  )
  document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy =
    DEVELOPMENT_PERFORMANCE_MEASURE_POLICY_ID
  window.addEventListener(DEVELOPMENT_PERFORMANCE_FIXTURE_EVENT, startFixture)
  budget.start()

  const instrumentation: DevelopmentRendererInstrumentation = {
    dispose: (): void => {
      if (disposed) return
      disposed = true
      budget.dispose()
      fixture?.dispose()
      fixture = undefined
      window.removeEventListener('pagehide', instrumentation.dispose)
      window.removeEventListener(DEVELOPMENT_PERFORMANCE_FIXTURE_EVENT, startFixture)
      delete document.documentElement.dataset.hvirDevelopmentPerformanceMeasureBudget
      delete document.documentElement.dataset.hvirDevelopmentPerformanceMeasureInterval
      delete document.documentElement.dataset.hvirDevelopmentPerformanceMeasurePolicy
      if (registry[ACTIVE_INSTRUMENTATION_KEY] === instrumentation) {
        delete registry[ACTIVE_INSTRUMENTATION_KEY]
      }
    },
  }
  registry[ACTIVE_INSTRUMENTATION_KEY] = instrumentation
  window.addEventListener('pagehide', instrumentation.dispose, { once: true })
  return instrumentation
}
