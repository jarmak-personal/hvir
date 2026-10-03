import type { ComponentProps, ReactElement } from 'react'
import { SettingsDialog } from '../settings/SettingsDialog'
import { AgentConfirmationDialog } from './AgentConfirmationDialog'

/** Access decisions remain mounted when the Settings surface is closed. */
export function WorkbenchAccessDialogs({
  open,
  ...settings
}: ComponentProps<typeof SettingsDialog> & { readonly open: boolean }): ReactElement {
  return (
    <>
      <AgentConfirmationDialog nested={open} />
      {open ? <SettingsDialog {...settings} /> : null}
    </>
  )
}
