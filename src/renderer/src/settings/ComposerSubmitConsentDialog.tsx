import type { ReactElement } from 'react'

import { ConfirmationDialog } from '../workbench/ConfirmationDialog'

export function ComposerSubmitConsentDialog({
  onCancel,
  onConfirm,
}: {
  readonly onCancel: () => void
  readonly onConfirm: () => void
}): ReactElement {
  return (
    <ConfirmationDialog
      labelledBy="composer-submit-consent-title"
      actions={[
        { label: 'Cancel', kind: 'cancel', onSelect: onCancel },
        { label: 'Allow this change', kind: 'primary', onSelect: onConfirm },
      ]}
      nested
      className="composer-submit-consent-dialog"
    >
      <h3 id="composer-submit-consent-title">Allow a Claude configuration change?</h3>
      <p>
        To keep this behavior consistent, hvir needs to update the Enter, Ctrl+Enter, and
        Shift+Enter Chat bindings in Claude&apos;s <code>keybindings.json</code> on every
        machine you connect to hvir, now and later while this setting is enabled.
      </p>
      <p>
        Other Claude bindings are preserved. hvir stores the three previous values and
        whether the keybindings file already existed in{' '}
        <code>.hvir-keybindings-state.json</code> in Claude&apos;s config directory so
        disabling this setting can restore them exactly. Nothing changes until you save
        app settings.
      </p>
      <p>
        Claude detects the keybinding update live. Shift+Enter submits in supported
        terminals outside hvir. Open Codex sessions keep their launch-time behavior until
        you restart them.
      </p>
    </ConfirmationDialog>
  )
}
