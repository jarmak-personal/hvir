import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'
import './themes.css'
import { initializeAppTheme } from './theme'

initializeAppTheme()

const container = document.getElementById('root')
if (!container) throw new Error('hvir: #root element not found')

const root = createRoot(container)
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

if (import.meta.env.DEV) {
  let instrumentation: { dispose(): void } | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    instrumentation?.dispose()
    instrumentation = undefined
    window.removeEventListener('pagehide', dispose)
  }
  window.addEventListener('pagehide', dispose, { once: true })
  import.meta.hot?.dispose(dispose)
  void import('./development/development-renderer-instrumentation').then(
    ({ installDevelopmentRendererInstrumentation }) => {
      if (disposed) return
      instrumentation = installDevelopmentRendererInstrumentation()
    },
  )
}
