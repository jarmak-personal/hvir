import { createRoot, type Root } from 'react-dom/client'

import { PerformanceMeasurePump } from './development-performance-pump'

export const DEVELOPMENT_PERFORMANCE_FIXTURE_EVENT =
  'hvir:development-performance-measure-fixture'

export class DevelopmentPerformanceFixture {
  private container?: HTMLDivElement
  private root?: Root
  private timer?: number
  private disposed = false

  start(): void {
    if (this.disposed || this.root) return
    const container = document.createElement('div')
    container.hidden = true
    container.dataset.hvirDevelopmentPerformanceFixture = 'running'
    document.body.append(container)
    const root = createRoot(container)
    this.container = container
    this.root = root
    root.render(
      <PerformanceMeasurePump
        schedule={(callback) => {
          this.timer = window.setTimeout(callback)
        }}
        onComplete={() => {
          container.dataset.hvirDevelopmentPerformanceFixture = 'complete'
        }}
      />,
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) window.clearTimeout(this.timer)
    this.timer = undefined
    this.root?.unmount()
    this.root = undefined
    this.container?.remove()
    this.container = undefined
  }
}
