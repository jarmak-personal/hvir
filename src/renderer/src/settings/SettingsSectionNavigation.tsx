import type { ReactElement } from 'react'

import { SETTINGS_SECTIONS, type SettingsSection } from './settings-navigation'

export function SettingsSectionNavigation({
  activeSection,
  onSelect,
}: {
  readonly activeSection: SettingsSection
  readonly onSelect: (section: SettingsSection) => void
}): ReactElement {
  return (
    <>
      <nav className="settings-section-index" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={activeSection === section.id ? 'active' : undefined}
            aria-current={activeSection === section.id ? 'page' : undefined}
            aria-controls={`settings-${section.id}-title`}
            onClick={() => onSelect(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <label className="settings-section-selector">
        <span>Settings section</span>
        <select
          value={activeSection}
          onChange={(event) => onSelect(event.currentTarget.value as SettingsSection)}
        >
          {SETTINGS_SECTIONS.map((section) => (
            <option key={section.id} value={section.id}>
              {section.label}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
