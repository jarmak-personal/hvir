import { webContents, type BrowserWindow } from 'electron'

export async function verifySkillagerReview(win: BrowserWindow): Promise<void> {
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(async () => {
    const wait = (read) => new Promise((resolve, reject) => { const until = Date.now() + 30000; const poll = () => { const found = read(); if (found) return resolve(found); if (Date.now() > until) return reject(new Error('Skill review readiness timed out')); requestAnimationFrame(poll) }; poll() });
    const button = (label) => [...document.querySelectorAll('.skillager-review button')].find((element) => element.textContent.trim() === label);
    ${body}
  })()`) as Promise<T>
  await evaluate(`
    const back = [...document.querySelectorAll('.skillager-sidebar button')].find((element) => element.textContent.trim() === 'Back to browsing');
    if (back) back.click();
    await wait(() => document.querySelector('.skillager-list-controls input[type=checkbox]'));
    document.querySelector('.skillager-list-controls input[type=checkbox]').click();
    await wait(() => document.querySelector('.skillager-row'));
    document.querySelector('.skillager-row').click();
    await wait(() => button('Version history'));
    button('Version history').click();
    await wait(() => document.querySelector('.skillager-review-history'));
    if (document.querySelector('.skillager-review-content')) throw new Error('History loaded content implicitly');
    button('Review content').click();
    await wait(() => document.querySelector('.skillager-review-version'));
    await wait(() => document.querySelector('.skillager-review-markdown h1'));
    if (document.querySelector('.skillager-review').textContent.includes('fixture-private-token')) throw new Error('Main token leaked to renderer');
    button('Source').click();
    await wait(() => document.querySelector('.skillager-review-content .cm-editor'));
    const file = [...document.querySelectorAll('.skillager-review-files button')].find((element) => element.textContent.startsWith('demo.html'));
    if (!file) throw new Error('Review did not disclose supporting HTML');
    file.click();
    await wait(() => document.querySelector('.skillager-review-html'));
    const frame = document.querySelector('.skillager-review-html');
    if (frame.getAttribute('sandbox') !== 'allow-scripts' || !frame.src.startsWith('hvir-preview:')) throw new Error('Review HTML lost its opaque preview boundary');
  `)
  let htmlFrame
  for (let attempt = 0; attempt < 200; attempt++) {
    htmlFrame = win.webContents.mainFrame.framesInSubtree.find((frame) =>
      frame.url.startsWith('hvir-preview:'),
    )
    if (htmlFrame) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!htmlFrame) throw new Error('Reviewed HTML frame did not load')
  const confinement = (await htmlFrame.executeJavaScript(
    `(async () => { let parentBlocked = false; try { void parent.document.body } catch { parentBlocked = true } let networkBlocked = false; try { await fetch('https://example.invalid/review') } catch { networkBlocked = true } return { parentBlocked, networkBlocked, text: document.querySelector('h1')?.textContent } })()`,
  )) as { parentBlocked: boolean; networkBlocked: boolean; text: string }
  if (
    !confinement.parentBlocked ||
    !confinement.networkBlocked ||
    confinement.text !== 'Reviewed HTML'
  )
    throw new Error('Reviewed HTML confinement failed')
  await evaluate(`
    button('Accept library changes…').click();
    const dialog = await wait(() => document.querySelector('[aria-label="Accept reviewed library version"]'));
    if (!dialog.textContent.includes('Workspace copies stay unchanged')) throw new Error('Acceptance preview omitted its library-only effect');
    button('Accept reviewed version').click();
    await wait(() => document.querySelector('.skillager-review [role="status"]')?.textContent.includes('Workspace copies are unchanged'));
    if (button('Accept library changes…')) throw new Error('Consumed acceptance remained actionable');
  `)
  if (!webContents.getAllWebContents().includes(win.webContents))
    throw new Error('Review displaced the workbench renderer')
  console.log(
    '[smoke] Skill review OK (explicit content/history, supporting files, source viewer, opaque HTML/CSP, separate exact acceptance)',
  )
}
