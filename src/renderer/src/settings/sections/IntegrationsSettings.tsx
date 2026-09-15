import type { ReactElement, ReactNode } from 'react'

import { SettingsSection } from '../SettingsSection'

export function IntegrationsSettings({
  children,
}: {
  readonly children: ReactNode
}): ReactElement {
  return (
    <SettingsSection
      section="integrations"
      title="Integrations"
      description="Choose which optional tools to use with hvir."
    >
      <div className="settings-section-scroll">{children}</div>
    </SettingsSection>
  )
}
