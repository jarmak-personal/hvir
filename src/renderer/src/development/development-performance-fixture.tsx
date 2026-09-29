import { createRoot, type Root } from 'react-dom/client'

import { PerformanceMeasurePump } from './development-performance-pump'
import { DEVELOPMENT_PERFORMANCE_FIXTURE_COMPLETE_EVENT } from './development-performance-events'

export class DevelopmentPerformanceFixture {
  private container?: HTMLDivElement
  private root?: Root
  private timer?: number
  private disposed = false

  start(): void {
    if (this.disposed || this.root) return
    const container = document.createElement('div')
    container.hidden = true
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
          window.dispatchEvent(new Event(DEVELOPMENT_PERFORMANCE_FIXTURE_COMPLETE_EVENT))
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
