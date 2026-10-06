import { useEffect, useState, type ComponentProps, type ReactElement } from 'react'
import { SettingsDialog } from '../settings/SettingsDialog'
import { ConnectionConfirmationDialog } from './ConnectionConfirmationDialog'
import { AgentConfirmationDialog } from './AgentConfirmationDialog'

/** Access decisions remain mounted when the Settings surface is closed. */
export function WorkbenchAccessDialogs({
  open,
  ...settings
}: ComponentProps<typeof SettingsDialog> & { readonly open: boolean }): ReactElement {
  const [preserved, setPreserved] = useState(false)
  useEffect(() => {
    if (open) setPreserved(false)
  }, [open])
  return (
    <>
      {open || preserved ? (
        <SettingsDialog
          {...settings}
          open={open}
          onInstallationHandoff={() => {
            setPreserved(true)
            settings.onClose()
          }}
          onClose={() => {
            setPreserved(false)
            settings.onClose()
          }}
          onSave={(theme, preferences) => {
            setPreserved(false)
            settings.onSave(theme, preferences)
          }}
        />
      ) : null}
      <AgentConfirmationDialog nested={false} />
      <ConnectionConfirmationDialog nested={false} />
    </>
  )
}
