import type { BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import { terminalProbeSourceDelivery } from './terminal-probe-source'

/** Qualify engine-owned canvas routes through the production adapter and a real PTY. */
export async function verifyTerminalEngineGestures(
  win: BrowserWindow,
  supervisor: PtySupervisor,
): Promise<string> {
  const terminal = supervisor.list().find((pty) => pty.ownerId === win.webContents.id)
  if (!terminal) throw new Error('mouse probe needs a live terminal')
  await win.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const engine = document.querySelector('.terminal-surface.active .terminal-engine-host');
      if (engine?.__hvirTerminalPerformance?.paused === false) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('terminal canvas did not become presented');
  })()`)
  for (const mode of [1000, 1002, 1003]) {
    await verifyMouseMode(win, supervisor, terminal, mode)
  }
  return 'canvas wheel modes 1000/1002/1003 + Shift + context-menu ownership'
}

/** Exercise content-box sizing and Chromium DPR changes with the retained live canvas. */
export async function verifyTerminalEngineFit(win: BrowserWindow): Promise<void> {
  const bounds = win.getBounds()
  const zoom = win.webContents.getZoomFactor()
  const padding: unknown = await win.webContents.executeJavaScript(`(() => {
    const engine = document.querySelector('.terminal-surface.active .terminal-engine-host');
    if (!engine) throw new Error('fit probe needs a live canvas');
    const retained = engine.style.padding;
    engine.style.padding = '0.25px 0.75px';
    return retained;
  })()`)
  try {
    for (const factor of [1.25, 0.9]) {
      win.webContents.setZoomFactor(factor)
      win.setBounds({ ...bounds, width: bounds.width - 37, height: bounds.height - 29 })
      await win.webContents.executeJavaScript(`(async () => {
        const deadline = performance.now() + 5000;
        let settled = 0;
        while (performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          const engine = document.querySelector('.terminal-surface.active .terminal-engine-host');
          const stats = engine?.__hvirTerminalPerformance;
          if (!engine || !stats || stats.paused || !stats.cellWidth || !stats.cellHeight) continue;
          const style = getComputedStyle(engine);
          const width = engine.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
          const height = engine.clientHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
          const matches = stats.cols === Math.max(2, Math.floor(width / stats.cellWidth)) &&
            stats.rows === Math.max(1, Math.floor(height / stats.cellHeight));
          settled = matches ? settled + 1 : 0;
          if (settled === 3) return;
        }
        throw new Error('terminal grid did not settle to its complete content box');
      })()`)
    }
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      const engine = document.querySelector('.terminal-surface.active .terminal-engine-host');
      if (engine) engine.style.padding = ${JSON.stringify(padding)};
    })()`)
    win.webContents.setZoomFactor(zoom)
    win.setBounds(bounds)
  }
}

async function verifyMouseMode(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  terminal: ManagedPty,
  mode: number,
): Promise<void> {
  let output = ''
  let exited = false
  const detach = supervisor.attach(terminal.id, terminal.ownerId, {
    onData: (data) => {
      output = (output + data).slice(-4096)
    },
    onExit: () => {
      exited = true
    },
  })
  const prefix = `__HVIR_MOUSE_${mode}__`
  // The status query round-trip proves that the renderer parsed the modes before gestures.
  const source = `
    process.stdin.setRawMode(true); process.stdin.resume();
    let queried = false, input = Buffer.alloc(0);
    const abort = () => { process.stdin.setRawMode(false); process.stdout.write('\\x1b[?${mode}l\\x1b[?1006l'); process.exit(2); };
    const timeout = setTimeout(abort, 10000);
    process.stdout.write('\\x1b[2J\\x1b[Hhello local selection\\r\\n\\x1b[?${mode}h\\x1b[?1006h\\x1b[5n');
    process.stdin.on('data', data => {
      if (data.includes(3)) return abort();
      input = Buffer.concat([input, data]);
      if (!queried) {
        const query = Buffer.from('\\x1b[0n'); const index = input.indexOf(query);
        if (index < 0) return;
        input = input.subarray(index + query.length); queried = true;
        process.stdout.write('${prefix}READY\\r\\n');
      }
      if (input.at(-1) !== 122) return;
      const hex = input.subarray(0, -1).toString('hex');
      clearTimeout(timeout); process.stdin.setRawMode(false);
      process.stdout.write('\\x1b[?${mode}l\\x1b[?1006l${prefix}INPUT:' + hex + '\\r\\n', () => process.exit(0));
    });
  `
  try {
    for (const { command, marker } of terminalProbeSourceDelivery(
      source,
      'HVIR_MOUSE_PROBE_B64',
      `${prefix}DELIVERY_`,
    )) {
      supervisor.write(terminal.id, terminal.ownerId, command)
      await waitFor(
        () => output.includes(marker),
        () => exited,
        `mouse ${mode} source delivery`,
      )
    }
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" "$HVIR_MOUSE_PROBE_B64"; unset HVIR_MOUSE_PROBE_B64; printf '\\137\\137HVIR_MOUSE_${mode}__CLOSED\\n'\n`,
    )
    await waitFor(
      () => output.includes(`${prefix}READY`),
      () => exited,
      `mouse ${mode} mode acknowledgement`,
    )
    const expected = (await win.webContents.executeJavaScript(`(() => {
      const engine = document.querySelector('.terminal-surface.active .terminal-engine-host');
      const canvas = engine?.querySelector('canvas');
      const textarea = engine?.querySelector('textarea');
      const stats = engine?.__hvirTerminalPerformance;
      if (!canvas || !textarea || !stats || stats.paused) throw new Error('mouse canvas is not presented');
      const rect = canvas.getBoundingClientRect();
      const wheel = (deltaY, extra = {}) => canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: 1, deltaY,
        clientX: rect.left + 1, clientY: rect.top + 1, ...extra,
      }));
      const mouse = (type, extra = {}) => canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0,
        clientX: rect.left + 1, clientY: rect.top + 1, ...extra,
      }));
      mouse('mousedown', { buttons: 1, shiftKey: true });
      mouse('mousemove', { buttons: 1, shiftKey: true, clientX: rect.left + 8 * stats.cellWidth });
      mouse('mouseup', { shiftKey: true, clientX: rect.left + 8 * stats.cellWidth });
      if (!engine.__hvirTerminalPerformance.hasSelection) throw new Error('Shift drag did not select locally');
      mouse('mousedown', { buttons: 1 }); mouse('mouseup');
      wheel(1); wheel(1); wheel(1);
      wheel(18, { altKey: true, ctrlKey: true, clientX: rect.right + 10000, clientY: rect.top - 10000 });
      wheel(-3, { shiftKey: true });
      wheel(10000, { shiftKey: true }); // Restore the viewport after the local-scroll proof.
      canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 2 }));
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'KeyZ', key: 'z' }));
      return '\\x1b[<0;1;1M\\x1b[<0;1;1m\\x1b[<65;1;1M' + ('\\x1b[<89;' + stats.cols + ';1M').repeat(5);
    })()`)) as string
    await waitFor(
      () => output.includes(`${prefix}CLOSED`),
      () => exited,
      `mouse ${mode} input and closure`,
    )
    const match = new RegExp(`${prefix}INPUT:([0-9a-f]*)`).exec(output)
    if (match?.[1] !== Buffer.from(expected).toString('hex')) {
      throw new Error(`terminal mouse mode ${mode} produced an unexpected route`)
    }
  } finally {
    await detach()
    if (!output.includes(`${prefix}CLOSED`) && !exited) {
      supervisor.write(terminal.id, terminal.ownerId, '\u0003')
    }
  }
}

async function waitFor(
  ready: () => boolean,
  exited: () => boolean,
  phase: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  await new Promise<void>((resolve, reject) => {
    const poll = (): void => {
      if (ready()) return resolve()
      if (exited() || Date.now() >= deadline)
        return reject(new Error(`${phase} did not complete`))
      setTimeout(poll, 20)
    }
    poll()
  })
}
