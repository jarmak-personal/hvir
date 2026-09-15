import type { BrowserWindow } from 'electron'
import type { skillagerObservationFixture } from './skillager-observation-fixture'
import {
  inspectSkillagerControls as inspect,
  clickSkillagerControl as click,
} from './skillager-settings'

/** Real Chromium geometry across the production renderer/IPC metadata lifetime. */
export async function verifySkillagerQuietRefresh(
  win: BrowserWindow,
  holdNext: ReturnType<typeof skillagerObservationFixture>['holdNext'],
): Promise<void> {
  const visibleRow = `
    const visibleRow = (tree) => {
      const bounds = tree.getBoundingClientRect();
      return [...tree.querySelectorAll('[role=treeitem]')].find((row) => {
        const at = row.getBoundingClientRect();
        return at.height > 0 && at.top >= bounds.top && at.bottom <= bounds.bottom;
      });
    };
  `
  for (const [kind, title] of [
    ['library', 'Your library'],
    ['project', 'In this project'],
  ] as const) {
    const selector = `section[aria-label="${title}"]`
    const held = holdNext(kind)
    try {
      await inspect(
        win,
        `
        const section = document.querySelector('${selector}');
        await wait(() => section.querySelector('[role=tree]') && !section.querySelector('.skillager-section-refresh').disabled);
        const tree = section.querySelector('[role=tree]');
        const selected = document.querySelector('.skillager-tab.active');
        if (!selected || selected.getAttribute('aria-selected') !== 'true' || !selected.querySelector('.tab-main')?.title)
          throw Error('Quiet refresh requires an actual selected detail tab');
        if (tree.clientHeight <= 0 || tree.scrollHeight <= tree.clientHeight) throw Error('Quiet refresh requires an overflowing visible tree');
        tree.scrollTop = Math.min(400, tree.scrollHeight - tree.clientHeight);
        if (tree.scrollTop <= 0) throw Error('Quiet refresh requires a nonzero scroll position');
        ${visibleRow}
        await wait(() => visibleRow(tree));
        window.__skillagerQuiet = {
          tree, top: tree.scrollTop, height: tree.clientHeight, range: tree.scrollHeight,
          y: tree.getBoundingClientRect().top,
          count: section.querySelector('header small').textContent,
          setup: document.querySelector('.skillager-project-setup')?.open,
          selected, title: selected.querySelector('.tab-main').title,
        };
      `,
      )
      await click(win, `${selector} .skillager-section-refresh`)
      if (!(await held.entered))
        throw Error('Quiet refresh did not enter its bounded CLI hold')
      const unchanged = (phase: string): string => `{
        const previous = window.__skillagerQuiet;
        const section = document.querySelector('${selector}'), tree = section.querySelector('[role=tree]');
        const expected = { sameTree: true, top: previous.top, height: previous.height, range: previous.range, y: previous.y, count: Number(previous.count) };
        const observed = { sameTree: tree === previous.tree, top: tree?.scrollTop, height: tree?.clientHeight, range: tree?.scrollHeight, y: tree?.getBoundingClientRect().top, count: Number(section.querySelector('header small').textContent) };
        if (Object.keys(expected).some((field) => expected[field] !== observed[field]))
          throw Error('Quiet refresh ${kind}/${phase} geometry mismatch: ' + JSON.stringify({ expected, observed }));
        if (document.querySelector('.skillager-project-setup')?.open !== previous.setup || document.querySelector('.skillager-tab.active') !== previous.selected || previous.selected.getAttribute('aria-selected') !== 'true' || previous.selected.querySelector('.tab-main').title !== previous.title)
          throw Error('Quiet refresh ${kind}/${phase} changed setup disclosure or selection');
      }`
      await inspect(
        win,
        `
        await wait(() => document.querySelector('${selector} header [aria-busy=true]'));
        ${unchanged('pending')}
        const tree = document.querySelector('${selector} [role=tree]');
        ${visibleRow}
        const row = visibleRow(tree);
        if (!row) throw Error('Quiet refresh requires a fully visible row for focus');
        row.focus({ preventScroll: true });
        if (document.activeElement !== row) throw Error('Quiet refresh row did not receive focus');
        window.__skillagerQuiet.focused = row;
        ${unchanged('focus')}
        if (tree.textContent.includes('Checking workspace copy')) throw Error('Checking replaced an observed row label');
      `,
      )
      held.release(true)
      await inspect(
        win,
        `
        await wait(() => document.querySelector('${selector} header [role=alert]'));
        ${unchanged('failed')}
        if (document.activeElement !== window.__skillagerQuiet.focused) throw Error('Failed refresh displaced row focus');
      `,
      )
      await click(win, `${selector} .skillager-section-refresh`)
      await inspect(
        win,
        `
        await wait(() => !document.querySelector('${selector} header [role=alert]') && !document.querySelector('${selector} .skillager-section-refresh').disabled);
        ${unchanged('retry')}
      `,
      )
    } finally {
      held.release()
      if (!win.isDestroyed()) await inspect(win, 'delete window.__skillagerQuiet;')
    }
  }
  console.log(
    '[smoke] Skills quiet refresh OK (held library/project reads; fixed tree geometry/count/scroll/selection; retained failure and focus; explicit retry; unchanged setup disclosure)',
  )
}
