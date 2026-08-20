import type { BrowserWindow } from 'electron'

import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

/**
 * Exercises the complete hidden-pane presentation boundary: background parsing
 * without rendering, an immediate retained frame, and one settled current repaint.
 */
export async function verifyHiddenTerminalReveal(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminal: ManagedPty,
  quiescentTerminal: ManagedPty,
): Promise<string> {
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    "printf '\\033[41m\\033[2J\\033[Hhidden-buffer\\033[0m\\033]0;Hidden buffered\\007\\007'; IFS= read -r hvir_input; printf 'input:%s\\n' \"$hvir_input\"; sleep 10\n",
  )

  return (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const sessionId = ${JSON.stringify(terminal.id)};
        const quiescentSessionId = ${JSON.stringify(quiescentTerminal.id)};
        const fail = (message) => reject(new Error(message));
        const statsRemainHidden = (current, snapshot) =>
          current && current.paused && !current.pendingFrame &&
          current.renderFrames === snapshot.renderFrames &&
          current.cols === snapshot.cols && current.rows === snapshot.rows;
        const waitForHiddenOutput = () => {
          const button = document.querySelector(
            '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const row = button?.closest('.terminal-list-row');
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const title = row?.querySelector('.terminal-list-title')?.textContent || '';
          const bell = row?.querySelector('.terminal-attention-badge.bell');
          const engine = surface?.querySelector('.terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          const quiescentSurface = document.querySelector(
            '.terminal-surface[data-terminal-session="' +
            CSS.escape(quiescentSessionId) + '"]'
          );
          const quiescentEngine = quiescentSurface?.querySelector('.terminal-engine-host');
          const quiescentStats = quiescentEngine?.__hvirTerminalPerformance;
          if (
            button && row && surface && title === 'Hidden buffered' && bell &&
            getComputedStyle(surface).visibility === 'hidden' && stats &&
            stats.paused && !stats.pendingFrame && stats.parsedWrites > 0 &&
            quiescentSurface && quiescentEngine && quiescentStats &&
            getComputedStyle(quiescentSurface).visibility === 'hidden' &&
            quiescentStats.paused && !quiescentStats.pendingFrame
          ) {
            const hiddenStats = stats;
            const quiescentHiddenStats = quiescentStats;
            return setTimeout(() => {
              const settled = engine.__hvirTerminalPerformance;
              const quiescentSettled = quiescentEngine.__hvirTerminalPerformance;
              if (
                !statsRemainHidden(settled, hiddenStats) ||
                !statsRemainHidden(quiescentSettled, quiescentHiddenStats)
              ) {
                return fail('one or more hidden terminals continued presentation work');
              }
              selectFromCompactRail(
                surface,
                row,
                hiddenStats,
                quiescentSurface,
                quiescentHiddenStats
              );
            }, 650);
          }

          setTimeout(waitForHiddenOutput, 25);
        };
        const selectFromCompactRail = (
          surface,
          row,
          hiddenStats,
          quiescentSurface,
          quiescentHiddenStats
        ) => {
          const workbench = document.querySelector('.workbench');
          const rail = document.querySelector('.terminal-rail:not([hidden])');
          const collapse = document.querySelector(
            'button[aria-label="Collapse terminal rail"]'
          );
          const expandedOrder = [...document.querySelectorAll('.terminal-list-main')]
            .map((entry) => entry.getAttribute('data-terminal-session'))
            .join('|');
          if (
            !(workbench instanceof HTMLElement) ||
            !(rail instanceof HTMLElement) ||
            !(collapse instanceof HTMLButtonElement)
          ) {
            return fail('compact marker switch fixtures missing');
          }
          collapse.click();
          const waitForMarkers = () => {
            const markerList = document.querySelector('.terminal-rail-compact-markers');
            const restore = document.querySelector(
              'button[aria-label="Restore terminal rail"]'
            );
            const markers = markerList
              ? [...markerList.querySelectorAll('.terminal-rail-compact-marker')]
              : [];
            if (
              workbench.classList.contains('terminal-rail-compact') &&
              markerList instanceof HTMLElement &&
              restore instanceof HTMLButtonElement &&
              markers.length === 3
            ) {
              const markerOrder = markers
                .map((entry) => entry.getAttribute('data-terminal-session'))
                .join('|');
              const firstMarker = markers[0];
              const marker = markers.find(
                (entry) => entry.getAttribute('data-terminal-session') === sessionId
              );
              const currentStats = surface.querySelector('.terminal-engine-host')
                ?.__hvirTerminalPerformance;
              const quiescentCurrentStats = quiescentSurface
                .querySelector('.terminal-engine-host')?.__hvirTerminalPerformance;
              if (
                markerOrder !== expandedOrder ||
                !(firstMarker instanceof HTMLButtonElement) ||
                !(marker instanceof HTMLButtonElement) ||
                firstMarker.textContent !== '' ||
                marker.dataset.terminalState !== 'bell' ||
                marker.getAttribute('aria-label') !== 'Hidden buffered, Bell' ||
                marker.title !== 'Hidden buffered, Bell' ||
                marker.tabIndex !== 0 ||
                !statsRemainHidden(currentStats, hiddenStats) ||
                !statsRemainHidden(quiescentCurrentStats, quiescentHiddenStats)
              ) {
                return fail(
                  'compact markers lost row order, state, or accessible naming: order=' +
                  markerOrder + ' expected=' + expandedOrder +
                  ' state=' + marker?.getAttribute('data-terminal-state') +
                  ' label=' + marker?.getAttribute('aria-label')
                );
              }
              const firstRectangle = getComputedStyle(firstMarker, '::before');
              const secondRectangle = getComputedStyle(marker, '::before');
              const firstItem = firstMarker.closest(
                '.terminal-rail-compact-marker-item'
              );
              const lastItem = marker.closest(
                '.terminal-rail-compact-marker-item'
              );
              const firstItemDecoration = firstItem
                ? getComputedStyle(firstItem, '::before')
                : undefined;
              const lastItemDecoration = lastItem
                ? getComputedStyle(lastItem, '::before')
                : undefined;
              const firstBounds = firstMarker.getBoundingClientRect();
              const secondBounds = marker.getBoundingClientRect();
              if (
                firstRectangle.transform !== 'none' ||
                secondRectangle.transform !== 'none' ||
                firstRectangle.borderRadius !== '0px' ||
                secondRectangle.borderRadius !== '0px' ||
                firstRectangle.borderLeftWidth !== '2px' ||
                firstRectangle.borderTopWidth !== '2px' ||
                secondRectangle.borderBottomWidth !== '3px' ||
                getComputedStyle(markerList).rowGap !== '0px' ||
                Math.abs(firstBounds.width - markerList.clientWidth) > 1 ||
                Math.abs(secondBounds.width - markerList.clientWidth) > 1 ||
                Math.abs(secondBounds.top - firstBounds.bottom) > 1 ||
                firstItemDecoration?.content !== 'none' ||
                lastItemDecoration?.content !== 'none'
              ) {
                return fail(
                  'compact markers lost zero-gap full-width rectangle geometry: ' +
                  'transforms=' + firstRectangle.transform + '/' +
                    secondRectangle.transform +
                  ' radii=' + firstRectangle.borderRadius + '/' +
                    secondRectangle.borderRadius +
                  ' active=' + firstRectangle.borderLeftWidth + '/' +
                    firstRectangle.borderTopWidth +
                  ' bell=' + secondRectangle.borderBottomWidth +
                  ' gap=' + getComputedStyle(markerList).rowGap +
                  ' widths=' + [
                    firstBounds.width,
                    secondBounds.width,
                    markerList.clientWidth
                  ].join('/') +
                  ' adjacency=' + (secondBounds.top - firstBounds.bottom) +
                  ' decorations=' + [
                    firstItemDecoration?.content,
                    lastItemDecoration?.content
                  ].join('/')
                );
              }
              markerList.style.flex = '0 0 20px';
              markerList.style.maxHeight = '20px';
              return requestAnimationFrame(() => {
                const railBounds = rail.getBoundingClientRect();
                const listBounds = markerList.getBoundingClientRect();
                const restoreBounds = restore.getBoundingClientRect();
                const restoreTop = restoreBounds.top;
                const listStyle = getComputedStyle(markerList);
                if (
                  listStyle.overflowY !== 'auto' ||
                  markerList.scrollHeight <= markerList.clientHeight ||
                  listStyle.scrollbarWidth !== 'none' ||
                  markerList.offsetWidth !== markerList.clientWidth ||
                  listBounds.left < railBounds.left - 1 ||
                  listBounds.right > railBounds.right + 1 ||
                  restoreBounds.left < railBounds.left - 1 ||
                  restoreBounds.right > railBounds.right + 1 ||
                  restoreBounds.top < railBounds.top - 1 ||
                  restoreBounds.bottom > listBounds.top + 1
                ) {
                  return fail(
                    'compact marker overflow escaped the rail or moved above restore: ' +
                    'overflow=' + listStyle.overflowY +
                    ' heights=' + markerList.clientHeight + '/' + markerList.scrollHeight +
                    ' scrollbar=' + listStyle.scrollbarWidth +
                    ' widths=' + markerList.clientWidth + '/' + markerList.offsetWidth +
                    ' rail=' + [railBounds.left, railBounds.right].join(',') +
                    ' list=' + [listBounds.left, listBounds.right].join(',') +
                    ' restore=' + [
                      restoreBounds.left,
                      restoreBounds.right,
                      restoreBounds.top,
                      restoreBounds.bottom
                    ].join(',')
                  );
                }
                marker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                requestAnimationFrame(() => {
                  const markerBounds = marker.getBoundingClientRect();
                  const restoreAfterScroll = restore.getBoundingClientRect();
                  if (
                    markerList.scrollTop <= 0 ||
                    markerBounds.top < listBounds.top - 1 ||
                    markerBounds.bottom > listBounds.bottom + 1 ||
                    Math.abs(restoreAfterScroll.top - restoreTop) > 1
                  ) {
                    return fail(
                      'compact marker scroll moved restore or hid the final marker: ' +
                      'scrollTop=' + markerList.scrollTop +
                      ' restoreTop=' + restoreTop + '/' + restoreAfterScroll.top
                    );
                  }
                  marker.focus();
                  marker.click();
                  requestAnimationFrame(() => {
                    const retainedCanvas = surface.querySelector('canvas');
                    const retainedContext = retainedCanvas?.getContext('2d');
                    const retainedPixel = retainedCanvas && retainedContext
                      ? retainedContext.getImageData(
                          Math.floor(retainedCanvas.width / 2),
                          Math.floor(retainedCanvas.height / 2),
                          1,
                          1
                        ).data
                      : undefined;
                    const retainedStats = surface.querySelector('.terminal-engine-host')
                      ?.__hvirTerminalPerformance;
                    if (
                      !(retainedCanvas instanceof HTMLCanvasElement) ||
                      getComputedStyle(retainedCanvas).visibility !== 'visible' ||
                      !retainedPixel || retainedPixel[3] !== 255 ||
                      !retainedStats?.paused
                    ) {
                      return fail(
                        'terminal did not reveal its retained frame immediately: ' +
                        JSON.stringify({
                          active: row.classList.contains('active'),
                          surfaceVisibility: getComputedStyle(surface).visibility,
                          canvas: retainedCanvas instanceof HTMLCanvasElement,
                          canvasVisibility: retainedCanvas
                            ? getComputedStyle(retainedCanvas).visibility
                            : 'missing',
                          pixel: retainedPixel ? [...retainedPixel] : undefined,
                          paused: retainedStats?.paused,
                          pendingFrame: retainedStats?.pendingFrame
                        })
                      );
                    }
                    waitForReveal(
                      surface,
                      row,
                      hiddenStats,
                      quiescentSurface,
                      quiescentHiddenStats,
                      workbench,
                      markerList,
                      restore
                    );
                  });
                });
              });
            }

            setTimeout(waitForMarkers, 25);
          };
          waitForMarkers();
        };
        const waitForReveal = (
          surface,
          row,
          hiddenStats,
          quiescentSurface,
          quiescentHiddenStats,
          workbench,
          markerList,
          restore
        ) => {
          const canvas = surface.querySelector('canvas');
          const context = canvas?.getContext('2d');
          const stats = surface.querySelector('.terminal-engine-host')
            ?.__hvirTerminalPerformance;
          const quiescentStats = quiescentSurface.querySelector('.terminal-engine-host')
            ?.__hvirTerminalPerformance;
          const marker = markerList.querySelector(
            '.terminal-rail-compact-marker[data-terminal-session="' +
            CSS.escape(sessionId) + '"]'
          );
          const pixel = canvas && context
            ? context.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1
              ).data
            : undefined;
          if (
            row.classList.contains('active') &&
            getComputedStyle(surface).visibility === 'visible' &&
            pixel && pixel[0] > 120 && pixel[1] < 160 && stats &&
            !stats.paused && !stats.pendingFrame &&
            stats.cols > hiddenStats.cols &&
            statsRemainHidden(quiescentStats, quiescentHiddenStats) &&
            workbench.classList.contains('terminal-rail-compact') &&
            marker instanceof HTMLButtonElement &&
            marker.getAttribute('aria-current') === 'true' &&
            marker.dataset.terminalState === 'neutral' &&
            marker.getAttribute('aria-label') ===
              'Hidden buffered, Neutral, active terminal' &&
            !row.querySelector('.terminal-attention-badge')
          ) {
            if (stats.fullRenderFrames - hiddenStats.fullRenderFrames !== 1) {
              return fail(
                'terminal reveal full repaint count was ' +
                (stats.fullRenderFrames - hiddenStats.fullRenderFrames)
              );
            }
            markerList.style.removeProperty('flex');
            markerList.style.removeProperty('max-height');
            restore.click();
            const waitForRestore = () => {
              if (!workbench.classList.contains('terminal-rail-compact')) {
                return resolve(
                  'hidden output + compact marker switch + attention clear + ' +
                  'bounded overflow + immediate retained frame + ' +
                  'multiple hidden surfaces stable + current repaint'
                );
              }

              setTimeout(waitForRestore, 25);
            };
            return waitForRestore();
          }

          setTimeout(
            () =>
              waitForReveal(
                surface,
                row,
                hiddenStats,
                quiescentSurface,
                quiescentHiddenStats,
                workbench,
                markerList,
                restore
              ),
            25
          );
        };
        waitForHiddenOutput();
      })
    `)) as string
}
