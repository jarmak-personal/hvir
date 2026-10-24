import type { BrowserWindow } from 'electron'
import { dirnameHostPath, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

/** Real ProjectHost read, JSON worker, lazy expansion, page replacement and mode remount. */
export async function verifyJsonLines(
  win: BrowserWindow,
  host: ProjectHost,
  siblingPath: HostPath,
): Promise<void> {
  const path = joinHostPath(dirnameHostPath(siblingPath), '.hvir-smoke-records.jsonl')
  try {
    await host.writeFile(
      path,
      [
        '{"nested":[{"ok":true}]}',
        'invalid record',
        JSON.stringify('x'.repeat(100_000)),
        ...Array.from({ length: 49_997 }, (_, index) => String(index)),
      ].join('\n') + '\n',
    )
    await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { stopped = true; reject(new Error('JSONL smoke timed out at stage ' + stage)); }, 20000);
        let stage = 'open';
        let frameCount = 0;
        let stopped = false;
        const frame = () => { frameCount++; if (!stopped) requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        const mode = name => [...document.querySelectorAll('.mode-control button')]
          .find(node => node.textContent?.trim() === name);
        const activeMode = () => document.querySelector('.mode-control button.active')?.textContent?.trim();
        const records = () => [...document.querySelectorAll('.jsonl-record')];
        const firstLine = () => Number(records()[0]?.dataset.sourceLine);
        const next = () => {
          if (stopped) return;
          try {
            if (stage === 'open') {
              const file = [...document.querySelectorAll('.file-row')]
                .find(node => node.getAttribute('title') === ${JSON.stringify(path.path)});
              if (file) { file.click(); stage = 'records'; }
            } else if (stage === 'records' && records().length === 100) {
              if (activeMode() !== 'rendered') throw new Error('JSONL did not default to rendered');
              if (firstLine() !== 1 || records().at(-1)?.dataset.sourceLine !== '100') throw new Error('JSONL order');
              if (!records()[1].textContent.includes('Line 2: Invalid JSON record') || records()[1].querySelector('.json-null')) throw new Error('JSONL invalid record presentation');
              if (!records()[2].textContent.includes('value preview') || records()[2].textContent.length > 5000) throw new Error('JSONL scalar preview bound');
              records()[0].querySelector('summary').click();
              stage = 'object';
            } else if (stage === 'object' && records()[0]?.querySelector('.json-children summary')) {
              records()[0].querySelector('.json-children summary').click(); stage = 'array';
            } else if (stage === 'array' && records()[0]?.querySelector('.json-children .json-children summary')) {
              records()[0].querySelector('.json-children .json-children summary').click(); stage = 'nested';
            } else if (stage === 'nested' && records()[0]?.querySelector('.json-boolean')?.textContent === 'true') {
              [...document.querySelectorAll('.jsonl-pages button')].find(node => node.textContent === 'Next records').click();
              stage = 'page';
            } else if (stage === 'page' && firstLine() === 101) {
              if (records().length !== 100 || records().at(-1)?.dataset.sourceLine !== '200') throw new Error('JSONL page accumulated nodes');
              mode('source').click(); stage = 'source';
            } else if (stage === 'source' && activeMode() === 'source' && document.querySelector('.cm-editor')) {
              mode('rendered').click(); stage = 'restored';
            } else if (stage === 'restored' && firstLine() === 101) {
              mode('diff').click(); stage = 'diff';
            } else if (stage === 'diff' && activeMode() === 'diff' && !document.querySelector('.jsonl-pages')) {
              mode('rendered').click(); stage = 'done';
            } else if (stage === 'done' && records().length === 100) {
              if (frameCount < 2) throw new Error('JSONL paint did not progress');
              clearTimeout(deadline); stopped = true; resolve(true); return;
            }
            setTimeout(next, 25);
          } catch (error) { clearTimeout(deadline); stopped = true; reject(error); }
        };
        next();
      })
    `)
    console.log(
      '[smoke] JSONL: 50000 records, 100-node pages, nested expansion, line error, scalar bound, source/diff remount, paint progress OK',
    )
  } finally {
    await host.exec('rm', ['-f', '--', path.path])
  }
}
