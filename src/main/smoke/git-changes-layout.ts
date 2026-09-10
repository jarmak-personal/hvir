import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

/** Real sidebar geometry, virtual scrolling, and activation over disposable Git files. */
export async function verifyGitChangesLayout(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<string> {
  const directory = joinHostPath(root, 'zz-changes-layout')
  const bounds = win.getBounds()
  try {
    await host.exec('mkdir', ['-p', directory.path])
    for (let index = 0; index < 400; index++) {
      await host.writeFile(
        joinHostPath(directory, `file-${String(index).padStart(3, '0')}.txt`),
        'Git Changes layout fixture\n',
      )
    }
    await win.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')]
        .find(node => node.textContent?.trim().startsWith('Git'))?.click();
      [...document.querySelectorAll('.git-tabs button')]
        .find(node => node.textContent?.trim().startsWith('Changes'))?.click();
    `)
    const inspect = async (
      expanded: boolean,
      previous?: { viewport: number; content: number },
    ): Promise<{ viewport: number; content: number }> => {
      const expectedHeight = win.getContentBounds().height
      const expectedViewport = previous
        ? previous.viewport + expectedHeight - previous.content
        : undefined
      return win.webContents.executeJavaScript(`
        (async () => {
          const waitFor = async (test, message) => {
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              const value = test();
              if (value) return value;
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            throw new Error(message);
          };
          await waitFor(() => window.innerHeight === ${expectedHeight},
            'Renderer did not receive the native window resize');
          const group = await waitFor(() => [...document.querySelectorAll('.git-group')]
            .find(node => !node.classList.contains('branch-point') &&
              Number(node.querySelector('h3 span:last-child')?.textContent) >= 400),
            'Large working-tree group did not arrive');
          const toggle = document.querySelector('.git-group-toggle');
          if (!toggle) throw new Error('Branch-point group missing');
          if (toggle.getAttribute('aria-expanded') !== '${expanded}') toggle.click();
          await waitFor(() => toggle.getAttribute('aria-expanded') === '${expanded}',
            'Branch-point toggle did not settle');
          const list = group.querySelector('.git-change-files');
          await waitFor(() => list.clientHeight > 280, 'Changes list still capped');
          if (${expectedViewport !== undefined}) {
            await waitFor(() => Math.abs(list.clientHeight - ${expectedViewport ?? 0}) <= 2,
              'Changes viewport did not follow observed content-height delta');
          }
          const checkCoverage = async (viewport) => {
            await waitFor(() => {
              const rows = [...viewport.querySelectorAll('.git-file')];
              const rect = viewport.getBoundingClientRect();
              return rows.some(row => row.getBoundingClientRect().top <= rect.top + 1 &&
                row.getBoundingClientRect().bottom > rect.top) &&
                rows.some(row => row.getBoundingClientRect().top < rect.bottom &&
                  row.getBoundingClientRect().bottom >= rect.bottom - 1);
            }, 'Virtual rows left a blank or clipped viewport');
          };
          list.scrollTop = 0;
          await checkCoverage(list);
          const rail = document.querySelector('.git-scroll').getBoundingClientRect();
          const lastGroup = document.querySelector('.git-group.branch-point');
          const bottom = lastGroup.getBoundingClientRect().bottom;
          if (bottom > rail.bottom + 1 || bottom < rail.bottom - 30) {
            throw new Error('Change groups do not use the available sidebar height: ' +
              JSON.stringify({ bottom, railBottom: rail.bottom, height: list.clientHeight }));
          }
          if (list.querySelectorAll('.git-file').length > list.clientHeight / 28 + 12) {
            throw new Error('Large Changes list is not windowed');
          }
          list.scrollTop = list.scrollHeight;
          await checkCoverage(list);
          const finalFile = await waitFor(() => [...list.querySelectorAll('.git-file')]
            .find(node => node.title.endsWith('/zz-changes-layout/file-399.txt')),
            'Final change file unreachable');
          finalFile.click();
          await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')
            ?.getAttribute('title') === finalFile.title, 'Wrong change file activated');
          if (${expanded}) {
            const branchList = lastGroup.querySelector('.git-change-files');
            if (!branchList || branchList.clientHeight < 28) {
              throw new Error('Expanded branch-point files unreachable');
            }
            branchList.scrollTop = branchList.scrollHeight;
            const branchFile = await waitFor(() => branchList.querySelector('.git-file'),
              'Branch-point file missing');
            branchFile.click();
            await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')
              ?.getAttribute('title') === branchFile.title &&
              document.querySelector('.diff-base-select')?.value === 'branch-point',
              'Branch-point file activation lost its diff base');
          }
          return { viewport: list.clientHeight, content: window.innerHeight };
        })()
      `) as Promise<{ viewport: number; content: number }>
    }
    win.setSize(bounds.width, 640)
    const shorter = await inspect(false)
    win.setSize(bounds.width, 1040)
    const taller = await inspect(false, shorter)
    if (taller.content <= shorter.content) {
      throw new Error(
        `Display supplied no content-height growth (${shorter.content} → ${taller.content})`,
      )
    }
    if (
      Math.abs(taller.viewport - shorter.viewport - (taller.content - shorter.content)) >
      2
    ) {
      throw new Error('Changes viewport growth disagreed with observed content geometry')
    }
    await inspect(true)
    win.setSize(bounds.width, 640)
    await inspect(true)
    return '400 files · resize · final row activation · expanded branch point'
  } finally {
    win.setBounds(bounds)
    await host.exec('rm', ['-rf', directory.path])
  }
}
