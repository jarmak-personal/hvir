import type { BrowserWindow } from 'electron'
import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { prepareTerminalScenario } from './terminal-scenario-ready'
import { verifyTerminalChrome } from './terminal-chrome'
import { verifyWorkbenchChrome } from './workbench-chrome'
import { verifyWorkbenchLayout } from './workbench-layout'
import { verifyTerminalSplit } from './terminal-split'
import { verifyAppSettings } from './app-settings'
import {
  verifyStructuredProfiles,
  verifyHarnessProfileEditor,
} from './harness-profile-workflow'
import { verifyTerminalMoveSmoke } from './terminal-move'

export async function verifyTerminalThemeScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await prepareTerminalScenario(win, supervisor)
  await verifyTerminalChrome(win)
  await verifyWorkbenchChrome(win)
}
export async function verifyWorkbenchLayoutScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await prepareTerminalScenario(win, supervisor)
  await verifyWorkbenchLayout(win)
}
export async function verifyTerminalSplitScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await prepareTerminalScenario(win, supervisor)
  await verifyTerminalSplit(win)
}
export async function verifyAppSettingsScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<void> {
  await prepareTerminalScenario(win, supervisor)
  await verifyAppSettings(win)
}
export async function verifyHarnessProfilesScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  await prepareTerminalScenario(win, supervisor)
  await verifyStructuredProfiles(win, root)
  await verifyHarnessProfileEditor(win, host)
}
export async function verifyTerminalMoveScenario(
  options: Parameters<typeof verifyTerminalMoveSmoke>[0],
): Promise<string> {
  await prepareTerminalScenario(options.win, options.supervisor)
  return verifyTerminalMoveSmoke(options)
}
