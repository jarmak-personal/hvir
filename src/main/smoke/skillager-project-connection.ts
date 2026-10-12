import {
  dialog,
  type BrowserWindow,
  type WebContents,
  type OpenDialogOptions,
} from 'electron'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { trustedRendererControl } from './trusted-renderer-control'

/** Maintained project document, actual public bridge and trusted decision; only OS choice is substituted. */
export async function verifySkillagerProjectConnection(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  root: HostPath,
  executable: string,
  controls: {
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
    within<T>(work: Promise<T>): Promise<T>
  },
): Promise<void> {
  const skill = joinHostPath(root, '.agents', 'skills', 'project-connection-proof')
  for (const folder of [
    joinHostPath(root, '.agents'),
    joinHostPath(root, '.agents', 'skills'),
  ])
    await host
      .createDirectoryExclusive(folder, { mode: 0o755 })
      .catch((reason: unknown) => {
        if ((reason as { code?: string }).code !== 'EEXIST') throw reason
      })
  await host.createDirectoryExclusive(skill, { mode: 0o755 })
  await host.writeFile(
    joinHostPath(skill, 'SKILL.md'),
    '---\nname: project-connection-proof\ndescription: Use the recorded project examples to verify ordinary project discovery.\n---\n\n# Project connection proof\n\nRead only after an explicit current selection.\n',
  )
  const canonical = (await host.realpath(localPath(executable))).path
  const descriptor = Object.getOwnPropertyDescriptor(dialog, 'showOpenDialog')
  if (!descriptor) throw new Error('Native program chooser is unavailable')
  const original = dialog.showOpenDialog.bind(dialog)
  let programSelections = 0
  dialog.showOpenDialog = async (
    parent: BrowserWindow | OpenDialogOptions,
    options?: OpenDialogOptions,
  ) => {
    if (parent !== win)
      return options
        ? original(parent as BrowserWindow, options)
        : original(parent as Electron.OpenDialogOptions)
    if (options?.buttonLabel !== 'Use program')
      throw new Error('Project connection unexpectedly requested another native setup')
    programSelections++
    return { canceled: false, filePaths: [executable] }
  }
  const inspect = (expression: string): Promise<unknown> =>
    controls.within(guest.executeJavaScript(expression))
  try {
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='missing-program' && document.getElementById('connect-program')?.checkVisibility() && !document.getElementById('connect-program').disabled",
        )) === true,
      'maintained local project offers in-context Connect without Settings',
    )
    // Retain a genuine public search intent and its options through both decisions.
    await inspect(`(() => {
      document.getElementById('query').value='catalogneedle';
      document.getElementById('separate-copies').checked=true;
      document.getElementById('preferred-agent').selectedIndex=1;
      document.getElementById('search-form').requestSubmit();
    })()`)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='missing-program'",
        )) === true,
      'unapproved project query remains actionable',
    )
    await connect()
    await decide(false)
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='unapproved' && !document.getElementById('connect-program').disabled && document.getElementById('query').value==='catalogneedle'",
        )) === true,
      'project decline preserves query and a usable Connect action',
    )
    await connect()
    await decide(true)
    await controls.wait(
      async () =>
        (await inspect(`(() => {
          const state=document.getElementById('state'), query=document.getElementById('query');
          return state?.dataset.state==='ready' && document.querySelectorAll('#skills [role=option]').length===50 &&
            query.value==='catalogneedle' && document.getElementById('separate-copies').checked &&
            document.getElementById('preferred-agent').selectedIndex===1 && document.getElementById('connect-program').hidden;
        })()`)) === true,
      'current project connection automatically observes genuine search metadata and preserves options',
    )
    await inspect("document.getElementById('browse').click()")
    await controls.wait(
      async () =>
        (await inspect(
          "document.getElementById('state')?.dataset.state==='ready' && [...document.querySelectorAll('#skills [role=option]')].some(row=>row.dataset.id==='project/project-connection-proof')",
        )) === true,
      'public project review discovers actual owned project skill without initialization',
    )
    if (programSelections > 2)
      throw new Error('Project connection repeatedly requested native program selection')
    console.log(
      '[smoke] maintained left project Connect → trusted decline/retry/allow → automatic genuine metadata; preserved public query/options and actual owned project discovery, no Settings/path/JSON/Inspect/init OK (successful OS program choice substituted)',
    )
  } catch (error) {
    console.log(
      '[smoke] bounded maintained project connection facts',
      JSON.stringify(
        await inspect(`(() => {
        const state=document.getElementById('state'), connect=document.getElementById('connect-program');
        return {state:state?.dataset.state, connectVisible:!!connect?.checkVisibility(), connectDisabled:connect?.disabled,
          rows:document.querySelectorAll('#skills [role=option]').length, nativeFocus:document.hasFocus(),
          queryRetained:document.getElementById('query')?.value==='catalogneedle'};
      })()`),
      ),
    )
    throw error
  } finally {
    Object.defineProperty(dialog, 'showOpenDialog', descriptor)
  }
  async function connect(): Promise<void> {
    await controls.wait(
      async () =>
        (await inspect(`(() => {
          const button=document.getElementById('connect-program');
          if(!button?.checkVisibility()||button.disabled)return false;
          button.click();return true;
        })()`)) === true,
      'actual enabled maintained project Connect control',
    )
  }
  async function decide(accepted: boolean): Promise<void> {
    await controls.wait(
      () =>
        trustedRendererControl(
          win,
          `function(expected, accepted) {
            const modal=document.querySelector('[aria-labelledby="connection-confirmation-title"]');
            if(!modal?.checkVisibility()||!modal.contains(document.activeElement)||!modal.textContent.includes(expected)||
              !modal.textContent.includes('projects on this computer'))return false;
            const button=[...modal.querySelectorAll('button')].find(item=>item.textContent.trim()===(accepted?'Connect':'Not now'));
            if(!button?.checkVisibility()||button.disabled)return false;
            button.click();return true;
          }`,
          [canonical, accepted],
          (work) => controls.within(work),
        ),
      accepted ? 'trusted project native consent' : 'trusted project native decline',
    )
  }
}
