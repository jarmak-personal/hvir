import type { BrowserWindow, WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  skillagerManagementControls,
  withinExtensionInspection,
  type SkillagerManagementControls,
} from './skillager-management-controls'

/** Real emitted Files selection and separate deletion availability, with original bytes preserved. */
export async function verifyOwnedOriginalReveal(
  win: BrowserWindow,
  projectGuest: WebContents,
  detail: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  controls: SkillagerManagementControls,
): Promise<Record<string, unknown>> {
  const skills = joinHostPath(joinHostPath(workspace, '.agents'), 'skills'),
    original = joinHostPath(skills, 'owned-original'),
    path = joinHostPath(original, 'SKILL.md'),
    body =
      '---\nname: owned-original\ndescription: Use only for an owned unapproved original.\n---\n\nOwned unapproved original remains preserved.\n'
  await host.createDirectoryExclusive(original, { mode: 0o755 })
  await host.writeFile(path, body)
  await controls.click('Skills in this project')
  const project = skillagerManagementControls(projectGuest, controls)
  await project.click('refresh')
  await project.ready(
    `!![...document.querySelectorAll('#skills [role=option]')].find(e=>e.dataset.sourcePath===${JSON.stringify(path.path)})`,
    'public unapproved project original',
  )
  await project.inspect(
    `[...document.querySelectorAll('#skills [role=option]')].find(e=>e.dataset.sourcePath===${JSON.stringify(path.path)}).click()`,
  )
  const reader = skillagerManagementControls(await detail(), controls)
  await reader.ready(
    "!document.getElementById('reveal-original').hidden",
    'ordinary human original reveal control',
  )
  await reader.click('reveal-original')
  const inspect = (expression: string) =>
      withinExtensionInspection(win.webContents.executeJavaScript(expression)),
    selector = `.files-panel:not([hidden]) [data-file-path=${JSON.stringify(original.path)}][aria-selected="true"][aria-expanded="true"]`
  await controls.wait(
    async () =>
      Boolean(await inspect(`document.querySelector(${JSON.stringify(selector)})`)),
    'emitted Files original folder selected and expanded',
  )
  await inspect(
    `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:180}))`,
  )
  await controls.wait(
    async () =>
      Boolean(
        await inspect(
          "[...document.querySelectorAll('[role=menuitem]')].some(e=>!e.disabled && ['Move to Trash…','Delete Permanently…'].includes(e.textContent.trim()))",
        ),
      ),
    'Files separate deletion action available',
  )
  await inspect(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  )
  if (
    (await host.readFile(path)).toString('utf8') !== body ||
    (await host.readdir(original)).map((entry) => entry.name).join(',') !== 'SKILL.md'
  )
    throw new Error('Original reveal or deletion availability changed preserved bytes')
  return {
    original,
    path,
    selected: true,
    expanded: true,
    separateDeletionAvailable: true,
    bytesPreserved: true,
  }
}
