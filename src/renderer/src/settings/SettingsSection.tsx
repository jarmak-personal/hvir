import type { ReactElement, ReactNode } from 'react'

import {
  settingsSectionHeadingId,
  type SettingsSection as SettingsSectionId,
} from './settings-navigation'

export function SettingsSection({
  section,
  title,
  description,
  actions,
  className,
  children,
}: {
  readonly section: SettingsSectionId
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
  readonly className?: string
  readonly children: ReactNode
}): ReactElement {
  const headingId = settingsSectionHeadingId(section)
  return (
    <section
      className={`settings-section${className ? ` ${className}` : ''}`}
      aria-labelledby={headingId}
    >
      <header className="settings-section-heading">
        <div>
          <h3 id={headingId} tabIndex={-1}>
            {title}
          </h3>
          <p>{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}
