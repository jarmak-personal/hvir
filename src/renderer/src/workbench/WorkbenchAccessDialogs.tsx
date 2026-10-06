import type { ComponentProps, ReactElement } from 'react'
import { SettingsDialog } from '../settings/SettingsDialog'
import { ConnectionConfirmationDialog } from './ConnectionConfirmationDialog'
import { AgentConfirmationDialog } from './AgentConfirmationDialog'

/** Access decisions remain mounted when the Settings surface is closed. */
export function WorkbenchAccessDialogs({
  open,
  ...settings
}: ComponentProps<typeof SettingsDialog> & { readonly open: boolean }): ReactElement {
  return (
    <>
      {open ? <SettingsDialog {...settings} /> : null}
      <AgentConfirmationDialog nested={false} />
      <ConnectionConfirmationDialog nested={false} />
    </>
  )
}
