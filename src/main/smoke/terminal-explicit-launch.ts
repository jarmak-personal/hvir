import type { BrowserWindow } from 'electron'

import type { PtySupervisor } from '../pty/pty-supervisor'

/** Prove the empty workspace boundary before admitting one explicit Bare Shell. */
export async function ensureExplicitBareShellLaunch(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const existing = supervisor.list()
  if (existing.length > 0) return `retained explicit terminal pid ${existing[0]!.pid}`

  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 15000;
        const waitFor = (read, message) => new Promise((resolve, reject) => {
          const poll = () => {
            const value = read();
            if (value) return resolve(value);
            if (Date.now() > deadline) return reject(new Error(message));
            setTimeout(poll, 25);
          };
          poll();
        });
        const emptyAction = await waitFor(() => {
          const button = [...document.querySelectorAll('.terminal-empty button')]
            .find((candidate) => candidate.textContent?.trim() === 'New terminal');
          const railAction = document.querySelector(
            'button[aria-label="New terminal"]:not(:disabled)'
          );
          return button instanceof HTMLButtonElement &&
            railAction instanceof HTMLButtonElement
            ? { button, railAction }
            : undefined;
        }, 'empty terminal actions did not become ready');
        if (
          document.querySelectorAll('.terminal-list-row').length !== 0 ||
          document.querySelectorAll('.terminal-surface').length !== 0
        ) {
          throw new Error('empty workspace materialized a terminal session before user action');
        }
        emptyAction.railAction.click();
        await waitFor(
          () => [...document.querySelectorAll('.terminal-new-menu strong')]
            .some((node) => node.textContent?.trim() === 'Shell'),
          'Bare Shell launch choice missing from empty workspace'
        );
        emptyAction.railAction.click();
        await waitFor(
          () => !document.querySelector('.terminal-new-menu'),
          'empty-workspace launch menu did not close'
        );
        emptyAction.button.click();
        const status = await waitFor(() => {
          const surfaces = document.querySelectorAll('.terminal-surface');
          const rows = document.querySelectorAll('.terminal-list-row');
          const active = document.querySelector('.terminal-surface.active');
          const value = active?.getAttribute('data-terminal-status') || '';
          return rows.length === 1 && surfaces.length === 1 && value.startsWith('pid ')
            ? value
            : undefined;
        }, 'explicit Bare Shell did not become live');
        return status;
      })()
    `),
    'explicit empty-workspace launch timed out',
    20_000,
  )) as string

  const terminals = supervisor.list()
  if (terminals.length !== 1 || !result.includes(String(terminals[0]!.pid))) {
    throw new Error(
      `explicit launch expected one supervised PTY, found ${terminals.length} (${result})`,
    )
  }
  return `zero sessions and PTYs before action · Bare Shell choice · ${result}`
}

function withTimeout<T>(promise: Promise<T>, label: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ])
}
