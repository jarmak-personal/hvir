import type { BrowserWindow } from 'electron'
import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

const waitFor = `async (test, name) => {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(name);
}`

/** Real input delivery and frame cadence across application, external updates and scrolling.
 * Timing values are local evidence, not a controlled-machine performance verdict.
 */
export async function verifyRenderedResponsiveness(
  win: BrowserWindow,
  host: ProjectHost,
  root: HostPath,
): Promise<void> {
  const fixtures = [
    {
      name: 'markdown',
      extension: 'md',
      source: '- alpha **bravo** charlie\n'.repeat(100000),
      updated: '# Updated Markdown\n\n' + 'Bounded paragraph.\n\n'.repeat(100),
    },
    {
      name: 'csv',
      extension: 'csv',
      source: Array.from({ length: 500 }, () =>
        Array.from({ length: 100 }, () => 'cell').join(','),
      ).join('\n'),
      updated: '',
    },
    {
      name: 'mermaid',
      extension: 'mmd',
      source:
        'flowchart TD\n' +
        Array.from({ length: 250 }, (_, index) => `N${index}-->N${index + 1}`).join('\n'),
      updated:
        '%%{init: {"themeCSS": "body { display:none }", "securityLevel": "loose"}}%%\nflowchart TD\nUpdated["<span data-source-line=\'999999\' style=\'position:fixed\'>Updated</span>"]-->Diagram',
    },
  ]
  for (const fixture of fixtures) {
    const path = joinHostPath(root, `.hvir-smoke-responsive.${fixture.extension}`)
    let timer: ReturnType<typeof setInterval> | undefined
    const sent: number[] = []
    try {
      await host.writeFile(path, fixture.source)
      await win.webContents.executeJavaScript(`(() => {
        const state = { gaps: [], inputs: [], last: performance.now(), frame: 0 };
        const frame = now => { state.gaps.push(now - state.last); state.last = now; state.frame = requestAnimationFrame(frame); };
        state.frame = requestAnimationFrame(frame);
        state.key = event => { if (event.key === 'F6') { event.preventDefault(); state.inputs.push(Date.now()); } };
        document.addEventListener('keydown', state.key, true);
        window.__renderedEvidence = state;
      })()`)
      timer = setInterval(() => {
        sent.push(Date.now())
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F6' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F6' })
      }, 50)
      await win.webContents.executeJavaScript(`(async () => {
        const waitFor = ${waitFor};
        const file = () => [...document.querySelectorAll('.file-row')].find(node => node.title === ${JSON.stringify(path.path)});
        await waitFor(file, 'responsiveness fixture missing');
        file().click();
        await waitFor(() => document.querySelector('.viewer-tab.active .tab-main')?.title === ${JSON.stringify(path.path)}, 'responsiveness tab did not activate');
        [...document.querySelectorAll('.mode-control button')].find(node => node.textContent.trim() === 'rendered')?.click();
        await waitFor(() => ${
          fixture.name === 'markdown'
            ? "[...document.querySelectorAll('.viewer-empty')].some(node => node.textContent.includes('Use Source'))"
            : fixture.name === 'csv'
              ? "document.querySelectorAll('.csv-view tbody tr').length > 0"
              : "document.querySelector('.mermaid-standalone svg') || document.querySelector('.mermaid-standalone')?.textContent.includes('Use Source')"
        }, 'rendered result did not apply');
        if (${JSON.stringify(fixture.name)} === 'markdown' && document.querySelector('.markdown-body li')) throw new Error('oversized Markdown mounted');
        if (${JSON.stringify(fixture.name)} === 'csv' && (document.querySelectorAll('.csv-view th,.csv-view td').length > 2000 || !document.querySelector('.csv-note')?.textContent.includes('Source'))) throw new Error('CSV application bound or disclosure missing');
      })()`)
      await scrollRendered(win)
      await host.writeFile(
        path,
        fixture.updated || fixture.source.replace('cell', 'updated'),
      )
      await win.webContents.executeJavaScript(`(async () => {
        const waitFor = ${waitFor};
        await waitFor(() => ${
          fixture.name === 'markdown'
            ? "document.querySelector('.markdown-body')?.textContent.includes('Updated Markdown')"
            : fixture.name === 'csv'
              ? "document.querySelector('.csv-view th')?.textContent === 'updated'"
              : "document.querySelector('.mermaid-standalone svg')?.textContent.includes('Updated')"
        }, 'rendered external update did not apply');
        if (document.querySelector('.mode-control button.active')?.textContent.trim() !== 'rendered') throw new Error('rendered mode changed during fallback/update');
        if (${JSON.stringify(fixture.name)} === 'mermaid') {
          const svg = document.querySelector('.mermaid-standalone svg');
          if (getComputedStyle(document.body).display === 'none' || svg.querySelector('style, script, a, image, img, use, animate, animateMotion, [data-source-line], [class]')) throw new Error('diagram output escaped passive presentation');
          for (const element of [svg, ...svg.querySelectorAll('*')]) {
            if (element.style.position || element.hasAttribute('href') || element.hasAttribute('src')) throw new Error('diagram output retained interaction or layout escape');
          }
        }

      })()`)
      await scrollRendered(win)
      clearInterval(timer)
      timer = undefined
      // Drain already delivered keyboard events before reading the sample.
      const evidence = (await win.webContents
        .executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => {
        const state = window.__renderedEvidence;
        resolve({ gaps: state.gaps, inputs: state.inputs });
      }))`)) as { gaps: number[]; inputs: number[] }
      if (
        evidence.inputs.length < 3 ||
        evidence.gaps.length < 5 ||
        evidence.inputs.length !== sent.length
      )
        throw new Error('Rendered responsiveness input/frame evidence incomplete')
      const latency = evidence.inputs.map((received, index) =>
        Math.max(0, received - sent[index]!),
      )
      console.log(
        `[smoke] rendered ${fixture.name}: apply/update/scroll frame-gap-max=${Math.round(Math.max(...evidence.gaps))}ms input-latency-max=${Math.round(Math.max(...latency))}ms samples=${latency.length}`,
      )
    } finally {
      if (timer) clearInterval(timer)
      await win.webContents.executeJavaScript(`(() => {
        const state = window.__renderedEvidence;
        if (state) { cancelAnimationFrame(state.frame); document.removeEventListener('keydown', state.key, true); delete window.__renderedEvidence; }
        const tab = [...document.querySelectorAll('.viewer-tab')].find(node => node.querySelector('.tab-main')?.title === ${JSON.stringify(path.path)});
        tab?.querySelector('.tab-close')?.click();
      })()`)
      await host.exec('rm', ['-f', '--', path.path])
    }
  }
}

async function scrollRendered(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`(async () => {
    for (let index = 0; index < 12; index++) {
      const root = document.querySelector('.rendered-scroll');
      if (root) {
        root.scrollLeft = (root.scrollWidth - root.clientWidth) * (index % 4) / 3;
        root.scrollTop = (root.scrollHeight - root.clientHeight) * (index % 4) / 3;
        root.dispatchEvent(new Event('scroll'));
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  })()`)
}
