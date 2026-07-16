import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  readonly children: ReactNode
}

interface ErrorBoundaryState {
  readonly error?: string
}

/** Last-resort containment so an unexpected React error never becomes a white window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {}

  static getDerivedStateFromError(reason: unknown): ErrorBoundaryState {
    return { error: reason instanceof Error ? reason.message : String(reason) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] contained render failure', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <h1>hvir hit a rendering problem</h1>
        <p>{this.state.error}</p>
        <button type="button" onClick={() => location.reload()}>
          Reload workbench
        </button>
      </main>
    )
  }
}
