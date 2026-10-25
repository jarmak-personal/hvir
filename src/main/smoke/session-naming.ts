import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'

/** Real chrome, preload, authority, durable registry, and renderer reload. */
export async function verifySessionNaming(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const before = supervisor.list().filter((pty) => pty.ownerId === win.webContents.id)
  const target = before[0]
  if (!target) throw new Error('Session naming requires a retained live terminal')
  await win.webContents.executeJavaScript(`
    window.__hvirNamingWait = async (read, stage = 'naming') => {
      const deadline = Date.now() + 15000;
      while (!read()) {
        if (Date.now() > deadline) throw new Error('Session naming readiness timed out: ' + stage);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    window.__hvirNamingButton = (label, parent = document) =>
      [...parent.querySelectorAll('button')].find((button) => button.textContent.trim() === label);
    window.__hvirNamingEdit = async (element, value, keyboard) => {
      element.dispatchEvent(keyboard
        ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
        : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      await window.__hvirNamingWait(() => window.__hvirNamingButton('Rename…'));
      window.__hvirNamingButton('Rename…').click();
      await window.__hvirNamingWait(() => document.querySelector('[role="dialog"] input'));
      const input = document.querySelector('[role="dialog"] input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      window.__hvirNamingButton('Save name').click();
      await window.__hvirNamingWait(() => !document.querySelector('[role="dialog"]'));
    };
    (async () => {
      await window.__hvirNamingWait(() => document.querySelector('.terminal-list-main[data-terminal-session="${target.id}"]') || document.querySelector('.terminal-recovery-dialog'));
      const recovery = document.querySelector('.terminal-recovery-dialog');
      if (recovery) {
        const restore = window.__hvirNamingButton('Restore selected', recovery);
        if (!restore) throw new Error('Naming fixture could not restore its retained terminal');
        restore.click();
      }
      await window.__hvirNamingWait(() => document.querySelector('.terminal-list-main[data-terminal-session="${target.id}"]') && document.querySelector('.terminal-surface.active')?.getAttribute('data-terminal-status')?.includes('pid '), 'retained-reattachment');
      const target = document.querySelector('.terminal-list-main[data-terminal-session="${target.id}"]');
      window.__hvirNamingActive = document.querySelector('.terminal-list-row.active .terminal-list-main')?.getAttribute('data-terminal-session');
      await window.__hvirNamingEdit(target, 'Named smoke session', false);
      await window.__hvirNamingWait(() => target.querySelector('.terminal-list-title')?.textContent === 'Named smoke session');
      if (document.querySelector('.terminal-list-row.active .terminal-list-main')?.getAttribute('data-terminal-session') !== window.__hvirNamingActive)
        throw new Error('Rename activated a different terminal');
    })();
  `)
  supervisor.write(
    target.id,
    target.ownerId,
    "printf '\\033]0;Latest naming automatic title\\007'\n",
    target.ownerGeneration,
  )
  await win.webContents.executeJavaScript(`(async () => {
    const target = document.querySelector('.terminal-list-main[data-terminal-session="${target.id}"]');
    await window.__hvirNamingWait(() => target.querySelector('.terminal-list-title')?.title === 'Latest naming automatic title');
    if (target.querySelector('.terminal-list-title')?.textContent !== 'Named smoke session')
      throw new Error('Automatic title replaced a custom name');
    document.querySelector('.sessions-destination').click();
    await window.__hvirNamingWait(() => [...document.querySelectorAll('.session-card')].some((card) => card.querySelector('h3')?.textContent === 'Named smoke session'));
    const card = [...document.querySelectorAll('.session-card')].find((card) => card.querySelector('h3')?.textContent === 'Named smoke session');
    if (card.querySelector('h3').title !== 'Latest naming automatic title') throw new Error('Sessions automatic-title tooltip missing');
    await window.__hvirNamingEdit(card, '   ', true);
    await window.__hvirNamingWait(() => [...document.querySelectorAll('.session-card')].some((card) => card.querySelector('h3')?.textContent === 'Latest naming automatic title'));
    const cleared = [...document.querySelectorAll('.session-card')].find((card) => card.querySelector('h3')?.textContent === 'Latest naming automatic title');
    await window.__hvirNamingEdit(cleared, 'Persistent smoke name', true);
    await window.__hvirNamingWait(() => [...document.querySelectorAll('.session-card')].some((card) => card.querySelector('h3')?.textContent === 'Persistent smoke name'));
    const named = [...document.querySelectorAll('.session-card')].find((card) => card.querySelector('h3')?.textContent === 'Persistent smoke name');
    const open = window.__hvirNamingButton('Open', named);
    if (!open) throw new Error('Named live session lost its Open action');
    open.click();
    await window.__hvirNamingWait(() => document.querySelector('.terminal-list-main[data-terminal-session="${target.id}"] .terminal-list-title')?.textContent === 'Persistent smoke name');
  })()`)
  const after = supervisor.list().filter((pty) => pty.ownerId === win.webContents.id)
  if (
    before.length !== after.length ||
    after.some((pty, i) => pty.instanceId !== before[i]?.instanceId)
  ) {
    throw new Error('Naming changed the live process set')
  }
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )
  win.webContents.reload()
  await loaded
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const ready = () => {
      const title = [...document.querySelectorAll('.terminal-list-title, .terminal-recovery-dialog strong, .session-card h3')]
        .some((node) => node.textContent === 'Persistent smoke name');
      if (title) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('Session name did not survive renderer reload'));
      setTimeout(ready, 25);
    };
    ready();
  })`)
  return 'pointer rail rename + keyboard Sessions rename/clear + automatic tooltip + unchanged PTYs + durable renderer reload'
}
