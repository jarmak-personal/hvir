import type { ReactElement } from 'react'

export function TerminalBellIcon(): ReactElement {
  return (
    <svg className="terminal-bell-icon" viewBox="0 0 16 16" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2v1M3.5 11.5l1-1.5V6.5a3.5 3.5 0 0 1 7 0V10l1 1.5z" />
        <path d="M6.5 13a1.6 1.6 0 0 0 3 0" />
      </g>
    </svg>
  )
}
