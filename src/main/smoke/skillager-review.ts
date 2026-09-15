import { captureSkillagerBody } from './skillager-onboarding'
import { clickSkillagerControl, inspectSkillagerControls } from './skillager-settings'
import { webContents, type BrowserWindow } from 'electron'

export async function verifySkillagerReview(win: BrowserWindow): Promise<void> {
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const found = read(); if (found) return resolve(found); if (Date.now() > until) return reject(new Error('Skill review readiness timed out')); requestAnimationFrame(poll) }; poll() });
    const button = (label) => [...document.querySelectorAll('.skillager-review button')].find((element) => element.textContent.trim() === label);
    ${body}
  })()`) as Promise<T>
  await evaluate(`
    const back = [...document.querySelectorAll('.skillager-sidebar button')].find((element) => element.textContent.trim() === 'Clear search');
    if (back) back.click();
    await wait(() => document.querySelector('.skillager-pending-filter input[type=checkbox]'));
    document.querySelector('.skillager-pending-filter input[type=checkbox]').click();
    await wait(() => document.querySelector('section[aria-label="Your library"] .skillager-row'));
  `)
  await clickSkillagerDetailControl(
    win,
    'section[aria-label="Your library"] .skillager-row',
  )
  await evaluate(`
    await wait(() => document.querySelector('.skillager-body .markdown-body h1'));
    if (document.querySelector('.skillager-secondary').open || document.querySelector('.skillager-review-content')) throw Error('Ordinary body opened review or metadata controls');
  `)
  await captureSkillagerBody(win, 'body-first')
  const selectedTitle = await evaluate<string>(
    `return document.querySelector('.skillager-tab.active .tab-main').title;`,
  )
  await clickSkillagerDetailControl(win, '.viewer-tab:not(.skillager-tab) .tab-main')
  await evaluate(`await wait(() => !document.querySelector('.skillager-details'));`)
  const retained = '.skillager-tab .tab-main[title=' + JSON.stringify(selectedTitle) + ']'
  await evaluate(`
    const tab = document.querySelector(${JSON.stringify(retained)}); tab.focus();
    await wait(() => document.activeElement === tab);
    if (document.querySelector('.skillager-body')) throw Error('Tab focus opened skill content without activation');
  `)
  await clickSkillagerDetailControl(win, retained)
  await evaluate(`
    await wait(() => document.querySelector('.skillager-body .markdown-body h1'));
    if (document.querySelector('.skillager-review-content') || document.querySelector('.skillager-secondary').open) throw Error('Retained tab activation restored review authority');
  `)
  await clickSkillagerDetailControl(win, '.skillager-secondary > summary')
  await clickSkillagerDetailControl(win, '.skillager-review button', 'Version history')
  await evaluate(`
    await wait(() => document.querySelector('.skillager-review-history'));
    if (document.querySelector('.skillager-review-content')) throw new Error('History loaded content implicitly');
  `)
  await clickSkillagerDetailControl(win, '.skillager-review button', 'Review content')
  await evaluate(`
    await wait(() => document.querySelector('.skillager-review-version'));
    await wait(() => document.querySelector('.skillager-review .skillager-review-markdown h1'));
    if (document.querySelector('.skillager-review').textContent.includes('fixture-private-token')) throw new Error('Main token leaked to renderer');
    const version = document.querySelector('.skillager-review-version');
    version.scrollIntoView({ block: 'start' });
    await wait(() => {
      const viewport = document.querySelector('.skillager-details').getBoundingClientRect();
      return [version, document.querySelector('.skillager-review .skillager-review-markdown h1')].every(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= Math.max(0, viewport.top) && rect.bottom <= Math.min(innerHeight, viewport.bottom);
      });
    });
  `)
  await captureSkillagerBody(win, 'body-review')
  await clickSkillagerDetailControl(win, '.skillager-review button', 'Source')
  const htmlLabel = await evaluate<string>(`
    await wait(() => document.querySelector('.skillager-review-content .cm-editor'));
    const file = [...document.querySelectorAll('.skillager-review-files button')].find((element) => element.textContent.startsWith('demo.html'));
    if (!file) throw new Error('Review did not disclose supporting HTML');
    return file.textContent.trim();
  `)
  await clickSkillagerDetailControl(win, '.skillager-review-files button', htmlLabel)
  const htmlUrl = await evaluate<string>(`
    await wait(() => document.querySelector('.skillager-review-html'));
    const frame = document.querySelector('.skillager-review-html');
    if (frame.getAttribute('sandbox') !== 'allow-scripts' || !frame.src.startsWith('hvir-preview:')) throw new Error('Review HTML lost its opaque preview boundary');
    return frame.src;
  `)
  let htmlFrame
  let readiness: { documentReady: boolean; fixtureReady: boolean } | undefined
  const htmlDeadline = Date.now() + 5000
  for (;;) {
    htmlFrame = win.webContents.mainFrame.framesInSubtree.find(
      (frame) => !frame.detached && !frame.isDestroyed() && frame.url === htmlUrl,
    )
    if (htmlFrame) {
      readiness = (await htmlFrame.executeJavaScript(
        `({ documentReady: document.readyState !== 'loading', fixtureReady: document.body?.dataset.reviewed === 'yes' })`,
      )) as { documentReady: boolean; fixtureReady: boolean }
      if (readiness.documentReady && readiness.fixtureReady) break
    }
    if (Date.now() >= htmlDeadline)
      throw new Error(
        'Reviewed HTML document readiness failed: ' +
          JSON.stringify({ frameFound: Boolean(htmlFrame), ...readiness }),
      )
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const confinement = (await htmlFrame.executeJavaScript(
    `(async () => { let parentBlocked = false; try { void parent.document.body } catch { parentBlocked = true } let networkBlocked = false; try { await fetch('https://example.invalid/review') } catch { networkBlocked = true } return { parentBlocked, networkBlocked, expectedHeading: document.querySelector('h1')?.textContent === 'Reviewed HTML' } })()`,
  )) as { parentBlocked: boolean; networkBlocked: boolean; expectedHeading: boolean }
  const exactFrame = htmlFrame.url === htmlUrl
  if (
    !exactFrame ||
    !confinement.parentBlocked ||
    !confinement.networkBlocked ||
    !confinement.expectedHeading
  )
    throw new Error(
      'Reviewed HTML confinement failed: ' +
        JSON.stringify({ exactFrame, ...readiness, ...confinement }),
    )
  await clickSkillagerDetailControl(
    win,
    '.skillager-review button',
    'Accept library changes…',
  )
  await evaluate(`
    const dialog = await wait(() => document.querySelector('[aria-label="Accept reviewed library version"]'));
    if (!dialog.textContent.includes('Workspace copies stay unchanged')) throw new Error('Acceptance preview omitted its library-only effect');
  `)
  await clickSkillagerDetailControl(
    win,
    '.skillager-review button',
    'Accept reviewed version',
  )
  await evaluate(`
    await wait(() => document.querySelector('.skillager-review [role="status"]')?.textContent.includes('Workspace copies are unchanged'));
    if (button('Accept library changes…')) throw new Error('Consumed acceptance remained actionable');
  `)
  if (!webContents.getAllWebContents().includes(win.webContents))
    throw new Error('Review displaced the workbench renderer')
  console.log(
    '[smoke] Skill review OK (body-first ordinary read and retained-tab/focus distinction, separate physical review/history/accept gestures, supporting files, source viewer, opaque HTML/CSP, separate exact acceptance)',
  )
}

/** Focus scrolls the existing detail owner; activation remains a physical hit-tested click. */
export async function clickSkillagerDetailControl(
  win: BrowserWindow,
  selector: string,
  text?: string,
): Promise<void> {
  await inspectSkillagerControls(
    win,
    `
    const target = await wait(() => [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => ${text === undefined ? 'true' : `item.textContent.trim() === ${JSON.stringify(text)}`}));
    await wait(() => !target.disabled);
    target.focus();
    await wait(() => document.activeElement === target);
  `,
  )
  await clickSkillagerControl(win, selector, text)
}
