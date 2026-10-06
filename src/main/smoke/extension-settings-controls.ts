import type { BrowserWindow } from 'electron'
import { trustedRendererControl } from './trusted-renderer-control'

interface SettingsControlPorts {
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  within<T>(work: Promise<T>): Promise<T>
}

/** Ordinary trusted Settings controls, with structured CDP values and caller-owned finite waits. */
export function extensionSettingsControls(
  win: BrowserWindow,
  extensionName: string,
  ports: SettingsControlPorts,
  source = '',
): {
  select(section?: string): Promise<void>
  selected(focused?: boolean): Promise<boolean>
  settled(): Promise<boolean>
  click(name: string, legend?: string): Promise<void>
  set(label: string, value: string): Promise<void>
} {
  const control = (
    declaration: string,
    values: readonly (string | boolean)[],
  ): Promise<boolean> =>
    trustedRendererControl(win, declaration, values, (work) => ports.within(work))
  async function select(section = ''): Promise<void> {
    await ports.wait(
      () =>
        control(
          `function(extension, section, source) {
      const item=[...document.querySelectorAll('.extension-installation-list button')].find(e=>(!source||e.dataset.source===source)&&e.querySelector('strong')?.textContent===extension);
      if(!item?.checkVisibility()||item.disabled)return false;
      if(item.getAttribute('aria-current')!=='true'){item.click();return false}
      const article=document.querySelector('.extension-installation');
      if(article?.querySelector('h4')?.textContent!==extension)return false;
      if(!section)return true;
      const button=[...article.querySelectorAll('.extension-configuration-tabs button')].find(e=>e.textContent===section);
      if(!button?.checkVisibility()||button.disabled)return false;
      if(button.getAttribute('aria-current')!=='true'){button.click();return false}
      return true;
    }`,
          [extensionName, section, source],
        ),
      `selected ${extensionName} ${section} configuration`,
    )
  }
  return {
    select,
    selected(focused = false) {
      return control(
        `function(extension, source, focused) {
        const item=[...document.querySelectorAll('.extension-installation-list button')].find(e=>(!source||e.dataset.source===source)&&e.querySelector('strong')?.textContent===extension);
        return !!item?.checkVisibility() && item.getAttribute('aria-current')==='true' && (!focused || document.activeElement===item) && document.querySelector('.extension-installation h4')?.textContent===extension;
      }`,
        [extensionName, source, focused],
      )
    },
    settled() {
      return control(
        `function() {
          const section=document.querySelector('.extension-settings');
          const add=[...(section?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()==='Add extension…');
          return !!add?.checkVisibility() && !add.disabled && !document.querySelector('[aria-labelledby="extension-remove-title"]');
        }`,
        [],
      )
    },
    async click(name, legend = '') {
      await select()
      await ports.wait(
        () =>
          control(
            `function(extension, name, legend) {
        const article = [...document.querySelectorAll('.extension-installation')].find(e => e.querySelector('h4')?.textContent === extension);
        const scope = legend ? [...(article?.querySelectorAll('fieldset') ?? [])].find(e => e.querySelector('legend')?.textContent.trim() === legend) : article;
        const button = [...(scope?.querySelectorAll('button') ?? [])].find(e => e.textContent.trim() === name);
        if (!button || button.disabled || !button.checkVisibility()) return false;
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
