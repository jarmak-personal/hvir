import type { BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { verifyGitDiffBases } from './git-diff'
import { verifyDirtyBranchSwitch } from './git-dirty-navigation'

/** Exercise renderer and system-Git contracts without unrelated feature workflows. */
export async function verifyGitWorkflow(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly root: HostPath
  readonly untrackedPath: HostPath
}): Promise<string> {
  const { win, host, root, untrackedPath } = options
  try {
    const diffBases = await verifyGitDiffBases(win)
    console.log(`[smoke] CodeMirror git diff bases OK (${diffBases})`)

    const gitPanelStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const button = (text) => [...document.querySelectorAll('button')]
            .find((node) => node.textContent?.trim().startsWith(text));
          button('Git')?.click();
          const waitForChanges = () => {
            const changed = [...document.querySelectorAll(
              '[aria-label="Git"] button[title]'
            )].find((candidate) => candidate.querySelector('small'));
            if (!changed) {

              return setTimeout(waitForChanges, 50);
            }
            const branchPoint = button('Branch point');
            if (branchPoint && branchPoint.getAttribute('aria-expanded') !== 'false') {
              return reject(new Error('Branch point is not collapsed by default'));
            }
            const branchSelect = document.querySelector('#git-branch-select');
            if (!branchSelect || branchSelect.value !== 'smoke/workflow') {
              return reject(new Error('Hermetic smoke branch is not active'));
            }
            if (branchSelect && branchSelect.options.length > 1 && branchSelect.disabled) {
              return reject(new Error('Branch menu cannot be inspected while switching is blocked'));
            }
            const syncSummary = document.querySelector(
              '[aria-label="Git"] [aria-live="polite"]'
            );
            if (!button('Fetch') || !button('Pull') || !syncSummary?.textContent?.trim()) {
              return reject(new Error('Git sync status/actions missing'));
            }
            const changedPath = changed.getAttribute('title') || '';
            const untracked = changed.querySelector('small')?.textContent?.trim().startsWith('?');
            changed.click();
            const waitForView = () => {
              const activePath = document.querySelector('.viewer-tab.active .tab-main')
                ?.getAttribute('title') || '';
              const activeMode = [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.getAttribute('aria-pressed') === 'true')
                ?.textContent?.trim();
              const expectedMode = untracked ? activeMode !== 'diff' : activeMode === 'diff';
              if (activePath !== changedPath || !activeMode || !expectedMode) {
                return setTimeout(waitForView, 50)
              }
              button('History')?.click();
              const waitForHistory = () => {
                const commit = document.querySelector(
                  '[aria-label="Commit history"] [role="listitem"] button[aria-expanded]'
                );
                if (!commit) {

                  return setTimeout(waitForHistory, 50);
                }
                commit.click();
                const waitForRailDetail = () => {
                  const historyRow = commit.closest('[role="listitem"]');
                  const history = document.querySelector('[aria-label="Commit history"]');
                  const openFull = historyRow?.querySelector(
                    'button[aria-label^="Open "][aria-label$=" in full history"]'
                  );
                  if (
                    commit.getAttribute('aria-expanded') === 'true' &&
                    history?.querySelector('button[title^="/"]') &&
                    openFull
                  ) {
                    openFull.click();
                    return waitForDetail();
                  }

                  setTimeout(waitForRailDetail, 50);
                };
                const waitForDetail = () => {
                  if (
                    document.querySelector(
                      '[aria-label="Repository commits"] [role="option"][aria-selected="true"]'
                    ) &&
                    document.querySelector('[aria-label="Commit details"]') &&
                    document.querySelector(
                      '[aria-label="Files changed in commit"] [role="treeitem"]'
                    )
                  ) {
                    if (document.querySelectorAll('.viewer-tab.active').length !== 1) {
                      return reject(new Error('Graph activation left two active tabs'));
                    }
                    return resolve(
                      'changes→' + activeMode +
                        ' · paged history→rail tree→graph detail'
                    );
                  }

                  setTimeout(waitForDetail, 50);
                };
                waitForRailDetail();
              };
              waitForHistory();
            };
            waitForView();
          };
          waitForChanges();
        })
      `)) as string
    console.log(`[smoke] mounted Git panel OK (${gitPanelStatus})`)
    const dirtyBranch = await verifyDirtyBranchSwitch(win)
    const [activeBranch, dirtyStatus] = await Promise.all([
      host.exec('git', ['-C', root.path, 'branch', '--show-current']),
      host.exec('git', ['-C', root.path, 'status', '--porcelain']),
    ])
    if (activeBranch.stdout.trim() !== dirtyBranch || !dirtyStatus.stdout.trim()) {
      throw new Error('Dirty branch switch did not preserve the working tree')
    }
    console.log(`[smoke] dirty branch switch + refresh OK (${dirtyBranch})`)

    const blameStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const button = (text) => [...document.querySelectorAll('button')]
            .find((node) => node.textContent?.trim() === text);
          button('Files')?.click();
          const waitForSource = () => {
            const blameButton = button('Blame');
            if (!blameButton || !document.querySelector('.source-shell .cm-editor')) {

              return setTimeout(waitForSource, 50);
            }
            blameButton.click();
            const waitForBlame = () => {
              const marker = document.querySelector('.cm-blame-marker');
              if (marker && blameButton.getAttribute('aria-pressed') === 'true') {
                const label = marker.textContent || 'blame marker';
                blameButton.click();
                const waitForHidden = () => {
                  if (
                    blameButton.getAttribute('aria-pressed') === 'false' &&
                    !document.querySelector('.cm-blame-marker')
                  ) {
                    return resolve(label + ' · compact when off');
                  }

                  setTimeout(waitForHidden, 25);
                };
                return waitForHidden();
              }
              const status = document.querySelector('.source-meta')?.textContent || '';
              if (status.includes('blame unavailable')) return reject(new Error(status));

              setTimeout(waitForBlame, 50);
            };
            waitForBlame();
          };
          const openTracked = () => {
            const tracked = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title')?.endsWith('/package-lock.json'));
            if (!tracked) {

              return setTimeout(openTracked, 50);
            }
            tracked.click();
            const activateTracked = () => {
              const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent || '';
              if (!title.includes('package-lock.json')) {

                return setTimeout(activateTracked, 50);
              }
              button('source')?.click();
              waitForSource();
            };
            activateTracked();
          };
          openTracked();
        })
      `)) as string
    console.log(`[smoke] lazy blame gutter OK (${blameStatus})`)

    const decorationsStatus = (await win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          [...document.querySelectorAll('button')]
            .find((candidate) => candidate.textContent?.trim().startsWith('Files'))
            ?.click();
          const inspect = () => {
            const rows = [...document.querySelectorAll('[aria-label="Files"] button[title]')];
            const file = rows.find((candidate) =>
              candidate.getAttribute('title') === ${JSON.stringify(untrackedPath.path)}
            );
            const root = rows.find((candidate) =>
              candidate.getAttribute('title') === ${JSON.stringify(root.path)}
            );
            const fileStatus = file?.querySelector('[aria-label="Git untracked"]');
            const rootStatus = root?.querySelector('[aria-label*="changed file"]');
            if (fileStatus && rootStatus) {
              return resolve(
                fileStatus.getAttribute('aria-label') + ' · ' +
                  rootStatus.getAttribute('aria-label')
              );
            }

            setTimeout(inspect, 25);
          };
          inspect();
        })
      `)) as string
    console.log(`[smoke] Files Git decorations OK (${decorationsStatus})`)

    return [
      diffBases,
      gitPanelStatus,
      `branch ${dirtyBranch}`,
      blameStatus,
      decorationsStatus,
    ].join(' · ')
  } catch (error) {
    let state: unknown = { unavailable: true }
    try {
      state = await readGitWorkflowState(win)
    } catch {
      // Preserve the original failure when the renderer is no longer inspectable.
    }
    throw new Error(
      `Git workflow failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  }
}

function readGitWorkflowState(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    (() => {
      const text = (selector) =>
        document.querySelector(selector)?.textContent?.trim().slice(0, 240);
      return {
        activeRail: document.querySelector('.rail-nav button.active')?.textContent?.trim(),
        activePath: document.querySelector('.viewer-tab.active .tab-main')
          ?.getAttribute('title'),
        activeMode: document.querySelector('.mode-control button.active')
          ?.textContent?.trim(),
        branch: document.querySelector('#git-branch-select')?.value,
        changes: document.querySelectorAll('.git-file').length,
        historyRows: document.querySelectorAll('.git-rail-commit').length,
        graphActive: Boolean(document.querySelector('.git-graph-row.active')),
        inspector: Boolean(document.querySelector('.git-commit-inspector')),
        blameMarkers: document.querySelectorAll('.cm-blame-marker').length,
        sourceStatus: text('.source-meta'),
        branchError: text('.git-branch-control small.error')
      };
    })()
  `) as Promise<unknown>
}
