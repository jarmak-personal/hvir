import type { BrowserWindow } from 'electron'

interface SettingsControlPorts {
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  within<T>(work: Promise<T>): Promise<T>
}

/** Ordinary trusted Settings controls, with structured CDP values and caller-owned finite waits. */
export function extensionSettingsControls(
  win: BrowserWindow,
  extensionName: string,
  ports: SettingsControlPorts,
): {
  click(name: string, legend?: string): Promise<void>
  set(label: string, value: string): Promise<void>
} {
  async function control(
    declaration: string,
    values: readonly string[],
  ): Promise<boolean> {
    const debuggerPort = win.webContents.debugger,
      owned = !debuggerPort.isAttached()
    let objectId: string | undefined
    try {
      if (owned) debuggerPort.attach('1.3')
      const global = (await ports.within(
        debuggerPort.sendCommand('Runtime.evaluate', { expression: 'globalThis' }),
      )) as { result?: { objectId?: string } }
      objectId = global.result?.objectId
      if (!objectId) throw new Error('Trusted control document is unavailable')
      const response = (await ports.within(
        debuggerPort.sendCommand('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: declaration,
          arguments: values.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        }),
      )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (response.exceptionDetails) throw new Error('Trusted control operation failed')
      return response.result?.value === true
    } finally {
      if (objectId && debuggerPort.isAttached())
        await ports
          .within(debuggerPort.sendCommand('Runtime.releaseObject', { objectId }))
          .catch(() => {})
      if (owned && debuggerPort.isAttached()) debuggerPort.detach()
    }
  }
  return {
    async click(name, legend = '') {
      await ports.wait(
        () =>
          control(
            `function(extension, name, legend) {
        const article = [...document.querySelectorAll('.extension-installation')].find(e => e.querySelector('h4')?.textContent === extension);
        const scope = legend ? [...(article?.querySelectorAll('fieldset') ?? [])].find(e => e.querySelector('legend')?.textContent.trim() === legend) : article;
        const button = [...(scope?.querySelectorAll('button') ?? [])].find(e => e.textContent.trim() === name);
        if (!button || button.disabled) return false;
        button.click(); return true;
      }`,
            [extensionName, name, legend],
          ),
        `${extensionName} ${name}`,
      )
    },
    async set(label, value) {
      await ports.wait(
        () =>
          control(
            `function(label) {
        return [...document.querySelectorAll('input, textarea, select')].some(e => e.getAttribute('aria-label') === label);
      }`,
            [label],
          ),
        label,
      )
      if (
        !(await control(
          `function(label, value) {
        const input = [...document.querySelectorAll('input, textarea, select')].find(e => e.getAttribute('aria-label') === label);
        if (!input) return false;
        const closed = [];
        for (let parent = input.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) closed.unshift(parent);
        for (const parent of closed) { const summary = parent.querySelector(':scope > summary'); if (!summary?.checkVisibility()) return false; summary.click(); }
        if (!input.checkVisibility() || input.disabled) return false;
        const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true})); return true;
      }`,
          [label, value],
        ))
      )
        throw new Error('Trusted input changed before setting its value')
    },
  }
}
