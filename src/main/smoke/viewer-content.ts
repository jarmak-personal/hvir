import type { BrowserWindow } from 'electron'

import { HTML_PREVIEW_SCHEME, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import { verifyFilenameSearch } from './filename-search'

/** Exercise real renderer, worker, CodeMirror, and Chromium viewer contracts in isolation. */
export async function verifyViewerContent(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly liveReloadPath: HostPath
  readonly largeJsonPath: HostPath
  readonly largeTextPath: HostPath
  readonly liveReloadBefore: string
}): Promise<string> {
  const { win, host, liveReloadPath, largeJsonPath, largeTextPath, liveReloadBefore } =
    options
  try {
    const viewerStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const poll = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) =>
                node.querySelector('.tree-file-name')?.textContent?.trim() === 'AGENTS.md'
              );
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('AGENTS.md missing from tree'));
              return setTimeout(poll, 50);
            }
            file.click();
            const waitForRender = () => {
              const rendered = document.querySelector('.markdown-body');
              const activeMode = document.querySelector('.mode-control button.active')?.textContent || '';
              if (activeMode.trim() !== 'rendered') {
                const renderedMode = [...document.querySelectorAll('.mode-control button')]
                  .find((node) => node.textContent?.trim() === 'rendered');
                renderedMode?.click();
              }
              if (rendered && activeMode.trim() === 'rendered') {
                const source = [...document.querySelectorAll('.mode-control button')]
                  .find((node) => node.textContent?.trim() === 'source');
                if (!source) return reject(new Error('source mode control missing'));
                source.click();
                const sourceDeadline = Date.now() + 20000;
                const waitForSource = () => {
                  const status = document.querySelector('.source-meta')?.textContent || '';
                  if (document.querySelector('.cm-editor') && status.includes('markdown')) {
                    const tab = document.querySelector('.viewer-tab.active .tab-main');
                    tab?.focus({ focusVisible: true });
                    if (!tab || getComputedStyle(tab).boxShadow === 'none') {
                      return reject(new Error('viewer tab focus ring is missing'));
                    }
                    return resolve('rendered→source · ' + status + ' · tab focus ring');
                  }
                  if (Date.now() > sourceDeadline) return reject(new Error('source highlight timed out: ' + status));
                  setTimeout(waitForSource, 50);
                };
                waitForSource();
                return;
              }
              if (Date.now() > deadline) return reject(new Error('markdown render timed out'));
              setTimeout(waitForRender, 50);
            };
            waitForRender();
          };
          poll();
        })
      `),
      'tree/viewer/worker did not become ready',
      40_000,
    )) as string
    console.log(`[smoke] ProjectHost tree + CodeMirror/Shiki worker OK (${viewerStatus})`)
    const filenameSearchStatus = await verifyFilenameSearch(win)
    console.log(`[smoke] filename search OK (${filenameSearchStatus})`)

    const renderedFixture = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 30000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              const closedDirectory = node.classList.contains('directory-row') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '›';
              if (!node.classList.contains('directory-row') || closedDirectory) node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('tree path missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test', () =>
            openWhenReady('/test/fixtures', () =>
              openWhenReady('/test/fixtures/rendered.md', () => {
                const waitForRendered = () => {
                  const tasks = document.querySelectorAll('.task-list-item-checkbox');
                  const image = document.querySelector('img[alt="Repository image fixture"]');
                  if (document.querySelector('.mermaid-diagram svg') &&
                      document.querySelector('.markdown-body .shiki') &&
                      image?.getAttribute('src')?.startsWith('blob:') &&
                      image.complete && image.naturalWidth > 0 &&
                      tasks.length === 4 &&
                      document.querySelectorAll('.task-list-item-checkbox:checked').length === 1) {
                    if (document.querySelectorAll('.task-list-item-checkbox.inapplicable').length !== 1) {
                      return reject(new Error('GitLab inapplicable task did not render'));
                    }
                    const renderedTab = [...document.querySelectorAll('.viewer-tab')]
                      .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
                    renderedTab?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
                    const body = document.querySelector('.markdown-body');
                    body?.dispatchEvent(new Event('scroll', { bubbles: true }));
                    return document.querySelector('.mermaid-diagram svg')
                      ? resolve('Shiki + Mermaid + ProjectHost image + task lists + stable scroll')
                      : reject(new Error('scroll destroyed Mermaid diagram'));
                  }
                  if (Date.now() > deadline) return reject(new Error(
                    'rendered fixture timed out: mermaid=' + Boolean(document.querySelector('.mermaid-diagram svg')) +
                    ' shiki=' + Boolean(document.querySelector('.markdown-body .shiki')) +
                    ' image=' + Boolean(image) + '/' + (image?.complete ? image.naturalWidth : 'pending') +
                    ' tasks=' + tasks.length
                  ));
                  setTimeout(waitForRendered, 50);
                };
                waitForRendered();
              })
            )
          );
        })
      `),
      'Markdown Mermaid fixture did not render',
      35000,
    )) as string
    console.log(`[smoke] rendered Markdown fixture OK (${renderedFixture})`)

    const richerViewerStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('richer viewer fixture missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test/fixtures/rendered.csv', () => {
            const waitForCsv = () => {
              const cells = [...document.querySelectorAll('.csv-view td')]
                .map((node) => node.textContent || '');
              if (cells.includes('Ada Lovelace') && cells.includes('compiler pioneer')) {
                openWhenReady('/test/fixtures/rendered-image.svg', () => {
                  const waitForImage = () => {
                    const image = document.querySelector('.image-view img');
                    if (image?.getAttribute('src')?.startsWith('blob:') && image.complete) {
                      return resolve('worker CSV table + repository image view');
                    }
                    if (Date.now() > deadline) return reject(new Error('image view timed out'));
                    setTimeout(waitForImage, 50);
                  };
                  waitForImage();
                });
                return;
              }
              if (Date.now() > deadline) return reject(new Error('CSV table timed out'));
              setTimeout(waitForCsv, 50);
            };
            waitForCsv();
          });
        })
      `),
      'CSV/image viewer smoke timed out',
    )) as string
    console.log(`[smoke] richer rendered views OK (${richerViewerStatus})`)

    const renderedLinkStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const link = (text) => [...document.querySelectorAll('.markdown-body a')]
            .find((node) => node.textContent?.trim() === text);
          let missingActivated = false;
          const renderedTab = [...document.querySelectorAll('.viewer-tab')]
            .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
          renderedTab?.querySelector('.tab-main')?.click();
          const waitForYaml = () => {
            const title = document.querySelector('.viewer-tab.active .tab-name')?.textContent || '';
            const keys = [...document.querySelectorAll('.json-key')]
              .map((node) => node.textContent || '');
            const fixturesOpen = [...document.querySelectorAll('.directory-row')]
              .some((node) => node.getAttribute('title')?.endsWith('/test/fixtures') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '⌄');
            if (title.includes('rendered.yml') && keys.some((key) => key.includes('name')) && fixturesOpen) {
              return resolve('internal tab · YAML tree · tree preserved · ' + location.protocol);
            }
            if (Date.now() > deadline) return reject(new Error(
              'internal YAML link timed out: ' + title + ' ' + keys.join(',')
            ));
            setTimeout(waitForYaml, 50);
          };
          const waitForContainedError = () => {
            if (document.querySelector('.viewer-empty.error')) {
              const renderedTab = [...document.querySelectorAll('.viewer-tab')]
                .find((node) => node.querySelector('.tab-name')?.textContent?.trim() === 'rendered.md');
              renderedTab?.querySelector('.tab-main')?.click();
              const waitForOriginal = () => {
                const yaml = link('Open the YAML fixture');
                if (yaml) {
                  yaml.click();
                  return waitForYaml();
                }
                if (Date.now() > deadline) return reject(new Error('original rendered tab did not recover'));
                setTimeout(waitForOriginal, 50);
              };
              return waitForOriginal();
            }
            const missing = missingActivated ? undefined : link('Missing target');
            if (missing && !missingActivated) {
              missingActivated = true;
              missing.click();
              return setTimeout(waitForContainedError, 50);
            }
            if (Date.now() > deadline) return reject(new Error(
              'missing internal link escaped the viewer: ' +
              (document.querySelector('.viewer-tab.active .tab-name')?.textContent || 'no title')
            ));
            setTimeout(waitForContainedError, 50);
          };
          waitForContainedError();
        })
      `),
      'rendered internal link did not stay in hvir',
      20_000,
    )) as string
    console.log(`[smoke] rendered link routing + YAML OK (${renderedLinkStatus})`)

    const sandboxPolicy = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const findBySuffix = (suffix) => [...document.querySelectorAll('.tree-row')]
            .find((node) => node.getAttribute('title')?.endsWith(suffix));
          const openWhenReady = (suffix, next) => {
            const node = findBySuffix(suffix);
            if (node) {
              const closedDirectory = node.classList.contains('directory-row') &&
                node.querySelector('.tree-chevron')?.textContent?.trim() === '›';
              if (!node.classList.contains('directory-row') || closedDirectory) node.click();
              next();
            } else if (Date.now() > deadline) {
              reject(new Error('tree path missing: ' + suffix));
            } else {
              setTimeout(() => openWhenReady(suffix, next), 50);
            }
          };
          openWhenReady('/test', () =>
            openWhenReady('/test/fixtures', () =>
              openWhenReady('/test/fixtures/html-sandbox-attack.html', () => {
                const waitForFrame = () => {
                  const frame = document.querySelector('.html-preview');
                  if (frame) return resolve(frame.getAttribute('sandbox') || '');
                  if (Date.now() > deadline) return reject(new Error('HTML iframe missing'));
                  setTimeout(waitForFrame, 50);
                };
                waitForFrame();
              })
            )
          );
        })
      `),
      'HTML sandbox preview did not open',
    )) as string
    if (sandboxPolicy !== 'allow-scripts') {
      throw new Error(`unsafe HTML sandbox policy: ${sandboxPolicy}`)
    }
    const iframe = await withTimeout(
      (async () => {
        for (;;) {
          const frame = win.webContents.mainFrame.frames.find((candidate) =>
            candidate.url.startsWith(`${HTML_PREVIEW_SCHEME}://document/`),
          )
          if (frame) return frame
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      })(),
      'sandboxed HTML frame was not created',
    )
    const sandboxProbe = await withTimeout(
      (async (): Promise<{
        ran?: string
        node?: string
        navigation?: string
        popup?: string
        preHead?: string
      }> => {
        for (;;) {
          const probe = (await iframe.executeJavaScript(`({
            ran: document.body?.dataset.ran,
            node: document.body?.dataset.node,
            navigation: document.body?.dataset.navigation,
            popup: document.body?.dataset.popup,
            preHead: globalThis.preHeadRan
          })`)) as {
            ran?: string
            node?: string
            navigation?: string
            popup?: string
            preHead?: string
          }
          if (probe.ran) return probe
          await new Promise<void>((resolve) => setTimeout(resolve, 50))
        }
      })(),
      'HTML sandbox probe script did not run',
    )
    if (
      iframe.origin !== 'null' ||
      sandboxProbe.ran !== 'yes' ||
      sandboxProbe.node !== 'blocked' ||
      sandboxProbe.navigation !== 'blocked' ||
      sandboxProbe.popup !== 'blocked' ||
      sandboxProbe.preHead !== 'yes'
    ) {
      throw new Error(
        `HTML sandbox escape probe failed (${iframe.origin} ${JSON.stringify(sandboxProbe)})`,
      )
    }
    console.log('[smoke] sandboxed HTML blocked node, navigation, and popups')

    const jsonStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const open = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(largeJsonPath.path)});
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('large JSON fixture missing'));
              return setTimeout(open, 50);
            }
            file.click();
            const waitForTree = () => {
              const summary = document.querySelector('.json-tree summary')?.textContent || '';
              const renderedNodes = document.querySelectorAll('.json-tree details').length;
              if (summary.includes('[50000]') && renderedNodes > 1) {
                if (renderedNodes > 205) return reject(new Error('JSON tree rendered eagerly: ' + renderedNodes));
                return resolve(renderedNodes + ' nodes for 50000 entries');
              }
              if (Date.now() > deadline) return reject(new Error('worker JSON tree timed out: ' + summary));
              setTimeout(waitForTree, 50);
            };
            waitForTree();
          };
          open();
        })
      `),
      'large JSON did not render lazily',
      20000,
    )) as string
    console.log(`[smoke] worker-backed lazy JSON OK (${jsonStatus})`)

    const largeFileStatus = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 15000;
          const open = () => {
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(largeTextPath.path)});
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('large text fixture missing'));
              return setTimeout(open, 50);
            }
            const started = performance.now();
            file.click();
            requestAnimationFrame(() => {
              const firstFrameMs = Math.round(performance.now() - started);
              const waitForPreview = () => {
                const preview = document.querySelector('.large-file-preview');
                const meta = document.querySelector('.source-meta')?.textContent || '';
                if (preview && meta.includes('preview')) {
                  return resolve(meta + ' · first-frame evidence ' + firstFrameMs + 'ms');
                }
                if (Date.now() > deadline) return reject(new Error('bounded large-file preview timed out'));
                setTimeout(waitForPreview, 50);
              };
              waitForPreview();
            });
          };
          open();
        })
      `),
      'large text preview smoke timed out',
      20_000,
    )) as string
    console.log(`[smoke] bounded large-file view OK (${largeFileStatus})`)

    const scrollBefore = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const open = () => {
            const discard = [...document.querySelectorAll('.dirty-tab-close-dialog button')]
              .find((node) => node.textContent?.trim() === 'Close without saving');
            if (discard) {
              discard.click();
              return setTimeout(open, 50);
            }
            const staleTab = [...document.querySelectorAll('.viewer-tab')].find((node) =>
              node.querySelector('.tab-main')?.getAttribute('title') === ${JSON.stringify(liveReloadPath.path)} && node.querySelector('.tab-status')?.textContent?.includes('●')
            );
            if (staleTab) {
              staleTab.querySelector('.tab-close')?.click();
              return setTimeout(open, 50);
            }
            const file = [...document.querySelectorAll('.file-row')]
              .find((node) => node.getAttribute('title') === ${JSON.stringify(liveReloadPath.path)});
            if (!file) {
              if (Date.now() > deadline) return reject(new Error('live-reload fixture missing'));
              return setTimeout(open, 50);
            }
            file.click();
            const waitForSource = () => {
              const scroller = document.querySelector('.cm-scroller');
              if (scroller) {
                scroller.scrollTop = 220;
                return resolve(scroller.scrollTop);
              }
              const source = [...document.querySelectorAll('.mode-control button')]
                .find((node) => node.textContent?.trim() === 'source');
              source?.click();
              if (Date.now() > deadline) return reject(new Error('live-reload source missing'));
              setTimeout(waitForSource, 50);
            };
            waitForSource();
          };
          open();
        })
      `),
      'live-reload fixture did not open',
    )) as number
    await host.writeFile(
      liveReloadPath,
      liveReloadBefore.replace('line 20\n', 'line 20 external marker\n'),
    )
    const scrollAfter = (await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 10000;
          const poll = () => {
            const content = document.querySelector('.cm-content')?.textContent || '';
            const scroller = document.querySelector('.cm-scroller');
            if (content.includes('external marker') && scroller) return resolve(scroller.scrollTop);
            if (Date.now() > deadline) return reject(new Error('external update did not reload'));
            setTimeout(poll, 50);
          };
          poll();
        })
      `),
      'open file did not live-reload',
    )) as number
    if (Math.abs(scrollAfter - scrollBefore) > 2) {
      throw new Error(`live reload jumped scroll (${scrollBefore}→${scrollAfter})`)
    }
    console.log(`[smoke] clean tab live-reload preserved scroll (${scrollAfter}px)`)

    await win.webContents.executeJavaScript(`
      document.querySelector('.cm-content')?.focus();
    `)
    await win.webContents.insertText('saved marker\n')
    await withTimeout(
      win.webContents.executeJavaScript(`
        new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const poll = () => {
            if (document.querySelector('.viewer-tab.active .tab-status')?.textContent?.includes('●')) {
              return resolve(true);
            }
            if (Date.now() > deadline) return reject(new Error('source edit did not mark tab dirty'));
            setTimeout(poll, 25);
          };
          poll();
        })
      `),
      'source edit did not reach tab state',
    )
    const saveModifier = process.platform === 'darwin' ? 'meta' : 'control'
    win.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'S',
      modifiers: [saveModifier],
    })
    win.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: 'S',
      modifiers: [saveModifier],
    })
    await withTimeout(
      (async (): Promise<void> => {
        for (;;) {
          if ((await host.readTextFile(liveReloadPath)).includes('saved marker')) return
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      })(),
      'Ctrl+S did not write the edited source through ProjectHost',
    )
    console.log('[smoke] source edit + Ctrl+S save OK')

    return [
      viewerStatus,
      filenameSearchStatus,
      renderedFixture,
      richerViewerStatus,
      renderedLinkStatus,
      'HTML sandboxed',
      jsonStatus,
      largeFileStatus,
      `reload ${scrollBefore}→${scrollAfter}px`,
      'minor save',
    ].join(' · ')
  } catch (error) {
    let state: unknown = { unavailable: true }
    try {
      state = await readViewerContentState(win)
    } catch {
      // Preserve the original failure when the renderer is no longer inspectable.
    }
    throw new Error(
      `Viewer content failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  }
}

function readViewerContentState(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    (() => {
      const text = (selector) =>
        document.querySelector(selector)?.textContent?.trim().slice(0, 240);
      return {
        activePath: document.querySelector('.viewer-tab.active .tab-main')
          ?.getAttribute('title'),
        activeMode: document.querySelector('.mode-control button.active')
          ?.textContent?.trim(),
        sourceStatus: text('.source-meta'),
        rendered: Boolean(document.querySelector('.markdown-body')),
        codeMirror: Boolean(document.querySelector('.cm-editor')),
        mergeView: Boolean(document.querySelector('.cm-mergeView')),
        htmlPreview: Boolean(document.querySelector('.html-preview')),
        jsonNodes: document.querySelectorAll('.json-tree details').length,
        largePreview: Boolean(document.querySelector('.large-file-preview')),
        dirty: text('.viewer-tab.active .tab-status'),
        treeRows: document.querySelectorAll('.file-row').length
      };
    })()
  `) as Promise<unknown>
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 15_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
