import type { BrowserWindow } from 'electron'
import type { LocalAgentAccessOwner } from '../agent/access-owner'

/** Shipped Reference action examples through the real CLI, trusted controls and guest. */
export async function verifyAuthoringActionExamples(
  win: BrowserWindow,
  access: Pick<LocalAgentAccessOwner, 'snapshot'>,
  target: { readonly workspace: string; readonly session: string },
  controls: {
    run(
      action: string,
      expected?: number,
    ): Promise<{ readonly ok: boolean; readonly value?: unknown }>
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  },
): Promise<void> {
  const preview = (value: unknown): void => {
    const result = value as {
      previewOnly?: boolean
      changedFiles?: number
      caller?: string
      session?: string
    }
    if (
      result.previewOnly !== true ||
      result.changedFiles !== 0 ||
      result.caller !== 'agent' ||
      result.session !== target.session
    )
      throw new Error(
        'Shipped replacement preview did not return its exact inert agent result',
      )
  }
  if (access.snapshot().confirmDestructive)
    throw new Error('Authoring action fixture did not start with standing access')
  preview((await controls.run('preview-replacement')).value)
  if (access.snapshot().confirmations.length)
    throw new Error('Standing preview left a confirmation')
  await authorization(true)
  if (
    !(await controls.run('describe-session')).ok ||
    access.snapshot().confirmations.length
  )
    throw new Error('Non-destructive standing action required confirmation')
  const approved = controls.run('preview-replacement').then(
    (value) => ({ value }),
    (reason: unknown) => ({ reason }),
  )
  await controls.wait(
    () => access.snapshot().confirmations.length === 1,
    'shipped preview trusted confirmation',
  )
  const decision = access.snapshot().confirmations[0]!
  if (
    decision.effects.join(',') !== 'replace' ||
    decision.input !== 'null' ||
    decision.workspace !== target.workspace ||
    decision.session !== target.session
  )
    throw new Error('Preview confirmation lost exact effects/input/target')
  await controls.click('Allow this action')
  const accepted = await approved
  if ('reason' in accepted) throw accepted.reason
  preview(accepted.value.value)
  const cancelled = controls.run('preview-replacement', 69).then(
    (value) => ({ value }),
    (reason: unknown) => ({ reason }),
  )
  await controls.wait(
    () => access.snapshot().confirmations.length === 1,
    'second preview trusted confirmation',
  )
  await controls.click('Cancel')
  const refused = await cancelled
  if ('reason' in refused) throw refused.reason
  if (refused.value.ok || access.snapshot().confirmations.length)
    throw new Error('Cancelled preview ran or retained confirmation')
  await authorization(false)
  console.log(
    '[smoke] shipped Reference preview actual guest result, standing/no-confirm, exact destructive approval and cancellation OK',
  )

  async function authorization(confirm: boolean): Promise<void> {
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.wait(
      async () =>
        Boolean(
          await win.webContents.executeJavaScript(`(() => {
      const summary = [...document.querySelectorAll('.agent-access-settings summary')].find(e=>e.textContent.trim().startsWith('Agent permissions'));
      if(!summary?.checkVisibility())return false;if(!summary.parentElement.open)summary.click();return summary.parentElement.open;
    })()`),
        ),
      'ordinary visible agent permissions disclosure',
    )
    await controls.wait(
      async () =>
        Boolean(
          await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('select[aria-label="Agent authorization"]');
      if (!select || select.disabled || !select.checkVisibility()) return false;
      select.value = ${JSON.stringify(confirm ? 'confirm' : 'standing')};
      select.dispatchEvent(new Event('change', {bubbles:true})); return true;
    })()`),
        ),
      'ordinary authoring example authorization control',
    )
    await controls.wait(
      () => access.snapshot().confirmDestructive === confirm,
      'ordinary authoring example authorization state',
    )
    await controls.click('Close settings')
  }
}
