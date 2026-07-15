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

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
