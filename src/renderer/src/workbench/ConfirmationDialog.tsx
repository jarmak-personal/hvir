import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

import { useModalKeyboard } from './use-modal-keyboard'

export type ConfirmationActionKind = 'cancel' | 'primary' | 'destructive'

export interface ConfirmationAction {
  readonly label: string
  readonly kind: ConfirmationActionKind
  readonly onSelect: () => void
  readonly disabled?: boolean
}

export function ConfirmationDialog({
  labelledBy,
  children,
  actions,
  busy = false,
  nested = false,
  className,
}: {
  readonly labelledBy: string
  readonly children: ReactNode
  readonly actions: readonly ConfirmationAction[]
  readonly busy?: boolean
  readonly nested?: boolean
  readonly className?: string
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const activationLocked = useRef(false)
  const cancelAction = actions.find(
    (action) => action.kind === 'cancel' && !action.disabled,
  )
  const initialAction =
    cancelAction ??
    actions.find((action) => action.kind !== 'destructive' && !action.disabled) ??
    actions.find((action) => !action.disabled)

  useEffect(() => {
    if (!busy) activationLocked.current = false
  }, [busy])

  useModalKeyboard(
    dialogRef,
    () => {
      if (cancelAction) activate(cancelAction)
    },
    Boolean(cancelAction) && !busy,
  )

  function activate(action: ConfirmationAction): void {
    if (busy || action.disabled || activationLocked.current) return
    activationLocked.current = true
    action.onSelect()
  }

  return (
    <div className={`modal-backdrop${nested ? ' nested' : ''}`}>
      <section
        className={`project-dialog confirmation-dialog${className ? ` ${className}` : ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <div className="confirmation-dialog-content">{children}</div>
        <div className="dialog-actions confirmation-dialog-actions">
          {actions.map((action) => (
            <button
              className={`confirmation-action confirmation-action-${action.kind}`}
              type="button"
              autoFocus={action === initialAction}
              disabled={busy || action.disabled}
              key={`${action.kind}:${action.label}`}
              onClick={() => activate(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
