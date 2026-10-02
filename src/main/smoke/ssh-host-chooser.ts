import type { BrowserWindow } from 'electron'

import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHostOption } from '../../shared/ipc/project'
import { ProjectHostCatalog } from '../project-host/project-host-catalog'
import type { LocalHost } from '../project-host/local-host'
import { createElectronSshConfiguration } from '../project-host/electron-ssh-configuration'
import type { SshConfigurationPort } from '../project-host/ssh-configuration-port'
import type { SmokeCleanup } from './cleanup'

/** Real config/catalog owner in a disposable home; no ambient SSH or server credentials. */
export async function createSshHostChooserSmoke(
  host: LocalHost,
  root: HostPath,
  hosts: () => readonly ProjectHostOption[],
  cleanup: SmokeCleanup,
) {
  const home = joinHostPath(root, '.hvir-smoke-ssh-home')
  await host.createDirectoryExclusive(home, { mode: 0o700 })
  cleanup.defer('SSH config fixture', () =>
    host.exec('rm', ['-rf', '--', home.path]).then(() => undefined),
  )
  const catalog = await ProjectHostCatalog.create({
    home: home.path,
    trustFile: joinHostPath(home, 'trust.json'),
    agentSocket: '',
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  cleanup.defer('SSH config catalog', () => catalog.dispose())
  const application = createElectronSshConfiguration(catalog)
  const options = (): readonly ProjectHostOption[] => [
    ...hosts(),
    ...catalog.listHosts().filter(({ kind }) => kind === 'ssh'),
  ]
  const port: SshConfigurationPort = {
    ...application,
    refreshHosts: async () => {
      await catalog.refreshHosts()
      return options()
    },
    addSshHost: async (request, assertActive) => {
      await catalog.addSshHost(request, assertActive)
      return options()
    },
  }
  let connectionAttempts = 0
  return {
    port,
    home,
    get connectionAttempts() {
      return connectionAttempts
    },
    connect(hostId: string): void {
      if (
        catalog
          .listHosts()
          .some((option) => option.kind === 'ssh' && option.hostId === hostId)
      ) {
        connectionAttempts++
        throw new Error('Saved SSH host is offline. Retry Connect when it is available')
      }
    },
  }
}

/** Chromium form → production preload/authority IPC → LocalHost save → explicit Connect. */
export async function verifySshHostChooserSmoke(
  win: BrowserWindow,
  host: LocalHost,
  fixture: Awaited<ReturnType<typeof createSshHostChooserSmoke>>,
): Promise<string> {
  const wait = (expression: string, condition: string): Promise<unknown> =>
    win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        if (${expression}) return resolve(true);
        if (Date.now() > deadline) return reject(new Error(${JSON.stringify('SSH chooser timed out: ' + condition)}));
        setTimeout(poll, 25);
      }; poll();
    })
  `)
  await wait(
    `!!document.querySelector('.project-add:not(:disabled)')`,
    'project registration ready',
  )
  await win.webContents.executeJavaScript(
    `document.querySelector('.project-add').click()`,
  )
  await wait(
    `!![...document.querySelectorAll('.session-dialog button')].find((button) => button.textContent.trim() === 'Add SSH host')`,
    'host-list action',
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.session-dialog button')].find((button) => button.textContent.trim() === 'Add SSH host').click()
  `)
  await wait(
    `!!document.querySelector('[aria-label="Username"]')?.value`,
    'local username default',
  )
  for (const [label, value] of [
    ['SSH alias', 'smoke-added'],
    ['Hostname or IP address', 'example.invalid'],
  ]) {
    await win.webContents.executeJavaScript(`
      (() => {
      const input = document.querySelector('input[aria-label="' + ${JSON.stringify(label)} + '"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      })();
    `)
  }
  await win.webContents.executeJavaScript(
    `document.querySelector('.ssh-host-form').requestSubmit()`,
  )
  await wait(
    `document.querySelector('.session-host-option[aria-selected="true"]')?.textContent.includes('smoke-added') && document.querySelector('.session-dialog [role="status"]')?.textContent === 'Saved to ~/.ssh/config'`,
    'saved alias and feedback',
  )
  if (fixture.connectionAttempts !== 0) throw new Error('SSH save attempted a connection')
  const text = await host.readTextFile(joinHostPath(fixture.home, '.ssh/config'))
  if (
    !text.startsWith('Host smoke-added\n') ||
    !text.includes('HostName example.invalid')
  ) {
    throw new Error('SSH chooser did not save submitted settings through LocalHost')
  }
  await wait(
    `!document.querySelector('.session-dialog [role="status"]')`,
    'feedback expiry',
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.session-dialog button')].find((button) => button.textContent.trim() === 'Connect').click()
  `)
  await wait(
    `document.querySelector('.dialog-error')?.textContent.includes('Retry Connect')`,
    'explicit offline connection',
  )
  if (Number(fixture.connectionAttempts) !== 1)
    throw new Error('Explicit Connect did not reach the saved host')
  await wait(
    `!!document.querySelector('.session-host-option[aria-selected="true"]')?.textContent.includes('smoke-added')`,
    'retained selection',
  )
  await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.session-dialog button')].find((button) => button.textContent.trim() === 'Cancel').click()
  `)
  await wait(`!document.querySelector('.session-dialog')`, 'dialog dismissal')
  return 'SSH chooser form→fixed-config save→selected alias→feedback expires→explicit offline Connect→retry retained'
}
