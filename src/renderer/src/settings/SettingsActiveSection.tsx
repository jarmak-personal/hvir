import type { ReactElement, RefObject } from 'react'

import type { HostPath } from '../../../shared'
import {
  HarnessProfilesSettings,
  type HarnessProfilesSettingsHandle,
} from './HarnessProfilesSettings'
import type { SettingsDraft, SettingsDraftValidation } from './settings-draft'
import type { SettingsSection } from './settings-navigation'
import { AppearanceSettings } from './sections/AppearanceSettings'
import { GitSettings } from './sections/GitSettings'
import { KeybindingsSettings } from './sections/KeybindingsSettings'
import { TerminalSettings } from './sections/TerminalSettings'

interface SettingsActiveSectionProps {
  readonly activeSection: SettingsSection
  readonly draft: SettingsDraft
  readonly validation?: Exclude<SettingsDraftValidation, { readonly valid: true }>
  readonly harnessProfiles: RefObject<HarnessProfilesSettingsHandle | null>
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialAddOpen: boolean
  readonly onChange: <K extends keyof SettingsDraft>(
    field: K,
    value: SettingsDraft[K],
  ) => void
  readonly onComposerSubmitMode: (enabled: boolean) => void
}

export function SettingsActiveSection({
  activeSection,
  draft,
  validation,
  harnessProfiles,
  workspaceRoot,
  projectRoot,
  initialAddOpen,
  onChange,
  onComposerSubmitMode,
}: SettingsActiveSectionProps): ReactElement {
  switch (activeSection) {
    case 'appearance':
      return <AppearanceSettings draft={draft} onChange={onChange} />
    case 'terminal':
      return (
        <TerminalSettings
          draft={draft}
          validation={validation}
          onChange={onChange}
          onComposerSubmitMode={onComposerSubmitMode}
        />
      )
    case 'git':
      return <GitSettings draft={draft} onChange={onChange} />
    case 'keybindings':
      return (
        <KeybindingsSettings draft={draft} validation={validation} onChange={onChange} />
      )
    case 'harnesses':
      return (
        <HarnessProfilesSettings
          ref={harnessProfiles}
          workspaceRoot={workspaceRoot}
          projectRoot={projectRoot}
          initialAddOpen={initialAddOpen}
        />
      )
  }
}
