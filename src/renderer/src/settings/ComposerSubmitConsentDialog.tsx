import { useEffect, useRef, type ReactElement } from 'react'

export function ComposerSubmitConsentDialog({
  onCancel,
  onConfirm,
}: {
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancel.current?.focus())
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button')
      const first = buttons?.[0]
      const last = buttons?.[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown)
    }
  }, [onCancel])

  return (
    <div className="modal-backdrop nested">
      <section
        className="project-dialog composer-submit-consent-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-submit-consent-title"
        tabIndex={-1}
      >
        <h3 id="composer-submit-consent-title">Allow a Claude configuration change?</h3>
        <p>
          To keep this behavior consistent, hvir needs to update the Enter and Ctrl+Enter
          Chat bindings in Claude&apos;s <code>keybindings.json</code> on every machine
          you connect to hvir, now and later while this setting is enabled.
        </p>
        <p>
          Other Claude bindings are preserved. hvir stores the two previous values in{' '}
          <code>.hvir-keybindings-state.json</code> in Claude&apos;s config directory so
          disabling this setting can restore them. Nothing changes until you save app
          settings.
        </p>
        <p>
          Claude detects the keybinding update live. Open Codex sessions keep their
          launch-time behavior until you restart them.
        </p>
        <div className="dialog-actions">
          <button ref={cancel} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            Allow this change
          </button>
        </div>
      </section>
    </div>
  )
}
