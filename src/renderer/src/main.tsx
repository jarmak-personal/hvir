import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'
import './themes.css'
import { initializeAppTheme } from './theme'
import { installScrollbarPresentation } from './scrollbars/scrollbar-presentation'

initializeAppTheme()

const container = document.getElementById('root')
if (!container) throw new Error('hvir: #root element not found')
const disposeScrollbarPresentation = installScrollbarPresentation(container)
window.addEventListener('beforeunload', disposeScrollbarPresentation, { once: true })

const root = createRoot(container)
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

if (import.meta.env.DEV) {
  void import('./development/development-renderer-instrumentation').then(
    ({ installDevelopmentRendererInstrumentation }) => {
      installDevelopmentRendererInstrumentation()
    },
    (error: unknown) =>
      console.error(
        '[development-performance] renderer instrumentation failed to load',
        error,
      ),
  )
}
