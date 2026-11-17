import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import type { BrowserWindow } from 'electron'
import { readRealHostSshConfiguration } from '../../../scripts/real-host-ssh-contract.mts'
import { ProjectHostCatalog } from '../project-host/project-host-catalog'
import type { ProjectHost } from '../project-host/project-host'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import {
  hostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
  type ProjectState,
} from '../../shared'
import { plainShellProvider } from '../harness/harness-provider'
import {
  clipboardInstall,
  nativeSelectionBrowser,
  paneScript,
} from './native-terminal-selection-browser'
import { focusSmokeWindow } from './window-focus'

interface ProjectFixture {
  get(): ProjectState
  remote(): ProjectState
  publish(state: ProjectState): void
}

/** Explicit rootless loopback acceptance only; never reads user SSH configuration.
 * The parent owns sshd/keys and must retain its own process and cleanup evidence. */
export async function createNativeTerminalRealSshFixture(localHost: ProjectHost) {
  const selected = readRealHostSshConfiguration(process.env)
  if (selected.kind !== 'configured')
    throw new Error('native-real-ssh-configuration-required')
  const config = selected.value
  if (
    config.hostname !== '127.0.0.1' ||
    config.user !== userInfo().username ||
    config.credential.kind !== 'file' ||
    config.hasPassphrase
  )
    throw new Error('native-real-ssh-loopback-file-identity-required')
  const catalogHome = hostPath(
    localHost.hostId,
    config.rootParent + '/hvir-native-ssh-home-' + randomUUID(),
  )
  const catalogMarker = joinHostPath(catalogHome, '.hvir-real-ssh-catalog')
  const catalogOwner = randomUUID()
  const madeHome = await localHost.exec('mkdir', ['-m', '700', catalogHome.path])
  if (madeHome.code !== 0) throw new Error('native-real-ssh-catalog-home-create')
  const writePrivate = async (file: HostPath, text: string) => {
    await localHost.createFileExclusive(file, { mode: 0o600 })
    await localHost.writeFile(file, text)
  }
  await writePrivate(catalogMarker, catalogOwner)
  const removeCatalogHome = async () => {
    if ((await localHost.readTextFile(catalogMarker)) !== catalogOwner)
      throw new Error('native-real-ssh-catalog-marker-mismatch')
    const removed = await localHost.exec('rm', ['-rf', '--', catalogHome.path])
    if (removed.code !== 0) throw new Error('native-real-ssh-catalog-cleanup-failed')
  }
  let catalog: ProjectHostCatalog
  let host: ProjectHost
  try {
    const sshDirectory = joinHostPath(catalogHome, '.ssh')
    const madeSsh = await localHost.exec('mkdir', ['-m', '700', sshDirectory.path])
    if (madeSsh.code !== 0) throw new Error('native-real-ssh-catalog-config-directory')
    await writePrivate(
      joinHostPath(sshDirectory, 'config'),
      `Host ${config.alias}\n  HostName ${config.hostname}\n  User ${config.user}\n  Port ${config.port}\n  IdentityFile "${config.credential.path}"\n`,
    )
    const trustFile = joinHostPath(catalogHome, 'host-trust.json')
    await writePrivate(
      trustFile,
      JSON.stringify({ [config.alias]: config.trustedHostKey }),
    )
    catalog = await ProjectHostCatalog.create({
      home: catalogHome.path,
      trustFile,
      agentSocket: '',
      prompter: { prompt: () => Promise.resolve(undefined) },
    })
    try {
      host = await catalog.materializeHost(config.alias)
    } catch (error) {
      await catalog.dispose()
      throw error
    }
  } catch (error) {
    let cleanupFailure: unknown
    try {
      await removeCatalogHome()
    } catch (reason) {
      cleanupFailure = reason
    }
    if (cleanupFailure)
      throw new AggregateError(
        [error, cleanupFailure],
        'Native SSH catalog setup failed',
        {
          cause: error,
        },
      )
    throw error
  }
  let root: HostPath | undefined
  let owned = false
  const markerValue = randomUUID()
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('native-real-ssh-operation-timeout')),
            15000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (disposing ??= (async () => {
      const failures: unknown[] = []
      try {
        if (owned && root) {
          const marker = joinHostPath(root, '.hvir-real-host-owner')
          if ((await bounded(host.readTextFile(marker))) !== markerValue)
            throw new Error('native-real-ssh-cleanup-marker-mismatch')
          const removed = await bounded(
            host.exec('sh', [
              '-c',
              'expected=$1; marker=$2; root=$3; [ -f "$marker" ] && [ "$(cat -- "$marker")" = "$expected" ] && rm -rf -- "$root"',
              'hvir-native-real-ssh-cleanup',
              markerValue,
              marker.path,
              root.path,
            ]),
          )
          if (removed.code !== 0) throw new Error('native-real-ssh-cleanup-refused')
          const absent = await bounded(host.exec('test', ['!', '-e', root.path]))
          if (absent.code !== 0) throw new Error('native-real-ssh-cleanup-root-remained')
          owned = false
        }
      } catch (error) {
        failures.push(error)
      }
      try {
        await bounded(catalog.dispose())
      } catch (error) {
        failures.push(error)
      }
      try {
        await bounded(removeCatalogHome())
      } catch (error) {
        failures.push(error)
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native real SSH cleanup failed')
    })())
  try {
    await bounded(host.connect())
    const parent = await bounded(host.realpath(hostPath(host.hostId, config.rootParent)))
    if ((await bounded(host.stat(parent))).type !== 'dir')
      throw new Error('native-real-ssh-parent-not-directory')
    const remoteRoot = joinHostPath(parent, 'hvir-native-ui-' + randomUUID())
    root = remoteRoot
    const marker = joinHostPath(remoteRoot, '.hvir-real-host-owner')
    owned = true // Unknown command settlement still requires marker-checked cleanup.
    const created = await bounded(
      host.exec('sh', [
        '-c',
        'umask 077; mkdir "$1" && { printf "%s" "$2" > "$3" || { rmdir "$1"; exit 1; }; }',
        'hvir-native-real-ssh-root',
        remoteRoot.path,
        markerValue,
        marker.path,
      ]),
    )
    if (created.code !== 0) throw new Error('native-real-ssh-root-create-failed')
    owned = true
    if (!hostPathEquals(await bounded(host.realpath(remoteRoot)), remoteRoot))
      throw new Error('native-real-ssh-root-canonical-mismatch')
    const initialized = await bounded(
      host.exec('env', [
        'GIT_CONFIG_NOSYSTEM=1',
        'GIT_CONFIG_GLOBAL=/dev/null',
        'git',
        '-c',
        'init.templateDir=',
        '-c',
        'core.hooksPath=/dev/null',
        'init',
        '-q',
        remoteRoot.path,
      ]),
    )
    if (initialized.code !== 0) throw new Error('native-real-ssh-root-git-init')
    await bounded(
      host.writeFile(
        joinHostPath(remoteRoot, 'README.md'),
        '# Native real SSH fixture\n',
      ),
    )
    return {
      host,
      root: remoteRoot,
      dispose,
      async verify(
        win: BrowserWindow,
        ptys: PtySupervisor,
        native: NativeTerminalApplication,
        _localManaged: ManagedPty,
        project: ProjectFixture,
      ) {
        const initial = project.get()
        const localProject = initial.projects.find(
          (entry) => entry.id === initial.activeProjectId,
        )
        if (!localProject) throw new Error('native-real-ssh-local-project-missing')
        const baseline = ptys.list().length
        let remote: ManagedPty | undefined
        let probeInstalled = false
        let stage = 'remote-selection'
        let failed = false
        let failure: unknown
        let receipt: Record<string, boolean> | undefined
        const verifiedPtyGeometry: Array<{
          phase: string
          serial: number
          width: number
          height: number
          rows: number
          columns: number
        }> = []
        const cleanupFailures: unknown[] = []
        let initialRailLabel: string | undefined
        let restoreRail = false
        const evaluate = <T>(body: string): Promise<T> =>
          win.webContents.executeJavaScript(`(()=>{${body}})()`)
        const wait = async (
          predicate: () => boolean | Promise<boolean>,
          name: string,
        ) => {
          stage = name
          const deadline = Date.now() + 15000
          do {
            if (await predicate()) return
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          } while (Date.now() < deadline)
          throw new Error('native-real-ssh-timeout:' + name)
        }
        const railControl = (click: boolean) =>
          evaluate<string>(`
          const button=[...document.querySelectorAll('button[aria-label="Collapse terminal rail"],button[aria-label="Restore terminal rail"]')]
            .find(button=>!button.closest('[hidden]')&&button.getBoundingClientRect().width>0);
          if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-real-ssh-width-control');
          const label=button.getAttribute('aria-label');if(${JSON.stringify(click)})button.click();return label;`)
        const clickProject = (name: string) =>
          evaluate(
            `const action=[...document.querySelectorAll('.project-tab-main')].find(button=>button.querySelector('strong')?.textContent?.trim()===${JSON.stringify(name)});if(!(action instanceof HTMLButtonElement)||action.disabled)throw new Error('native-real-ssh-project-control');action.click();return true;`,
          )
        try {
          const selectedProject = project.remote()
          project.publish({
            ...selectedProject,
            projects: [...initial.projects, ...selectedProject.projects],
          })
          await focusSmokeWindow(win, 'window')
          await wait(
            () =>
              evaluate<boolean>(
                `return !!document.querySelector('.workbench:not([hidden]) .terminal-empty button');`,
              ),
            'empty-remote-workspace',
          )
          await evaluate(
            `const button=document.querySelector('.workbench:not([hidden]) .terminal-empty button');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-real-ssh-shell-control');button.click();return true;`,
          )
          await wait(() => {
            const matches = ptys.list().filter((actor) => actor.hostId === host.hostId)
            if (matches.length > 1) throw new Error('native-real-ssh-duplicate-pty')
            remote = matches[0]
            return !!remote
          }, 'remote-plain-shell')
          const managed = remote!
          const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
          const handle = native.sessions.get(managed.id)?.handle
          if (
            !handle ||
            managed.providerId !== plainShellProvider.manifest.id ||
            !hostPathEquals(managed.workspaceRoot, remoteRoot)
          )
            throw new Error('native-real-ssh-provider-root-identity')
          const sameActor = () => {
            const current = ptys.get(managed.id)
            const session = native.sessions.get(managed.id)
            return (
              current?.instanceId === managed.instanceId &&
              current.pid === managed.pid &&
              current.providerId === managed.providerId &&
              current.ownerId === owner.id &&
              current.ownerGeneration === owner.generation &&
              hostPathEquals(current.workspaceRoot, remoteRoot) &&
              current.profileId === managed.profileId &&
              session?.handle === handle &&
              session.session.instanceId === managed.instanceId &&
              session.session.ownerId === owner.id &&
              session.session.ownerGeneration === owner.generation &&
              hostPathEquals(session.session.workspaceRoot, remoteRoot)
            )
          }
          const read = async () =>
            new TextDecoder().decode(await native.readRetained(managed.id, owner))
          const browser = nativeSelectionBrowser(win, native, managed)
          await browser.ready()
          const layout = await browser.layout()
          const initialViewId = layout.bounds.viewId
          const originalDraw = native.targets.drawn(
            initialViewId,
            win.webContents.mainFrame,
          )
          if (!originalDraw) throw new Error('native-real-ssh-initial-draw-missing')
          const currentDraw = async (observed?: typeof layout) => {
            const currentLayout = observed ?? (await browser.layoutWhenReady())
            if (!currentLayout) return false
            const currentViewId = currentLayout.bounds.viewId
            if (
              currentViewId !== initialViewId &&
              native.targets.drawn(initialViewId, win.webContents.mainFrame)
            )
              throw new Error('native-real-ssh-old-view-regranted')
            const drawn = native.targets.drawn(currentViewId, win.webContents.mainFrame)
            return (
              sameActor() &&
              !!drawn &&
              drawn.geometrySerial === currentLayout.geometry.serial &&
              drawn.nativeEpoch === originalDraw.nativeEpoch
            )
          }
          let sttySequence = 0
          const verifyStty = async (observed: typeof layout, phase: string) => {
            const marker = `HVIR_OS_PTY_${++sttySequence}`
            await ptys.writeConfirmed(
              managed.id,
              owner.id,
              `test -t 0 && test -t 1 && printf '\\r\\n${marker}:%s\\r\\n' "$(stty size)"\r`,
              owner.generation,
            )
            await wait(
              async () =>
                (await read())
                  .split('\n')
                  .includes(
                    `${marker}:${observed.geometry.rows} ${observed.geometry.columns}`,
                  ),
              phase,
            )
            verifiedPtyGeometry.push({
              phase,
              serial: observed.geometry.serial,
              width: observed.geometry.width,
              height: observed.geometry.height,
              rows: observed.geometry.rows,
              columns: observed.geometry.columns,
            })
          }
          await verifyStty(layout, 'actual-os-pty-applied-geometry')
          initialRailLabel = await railControl(false)
          restoreRail = true
          await railControl(true)
          let changedLayout: typeof layout | undefined
          await wait(async () => {
            const next = await browser.layoutWhenReady()
            if (
              !next ||
              next.geometry.serial <= layout.geometry.serial ||
              next.geometry.width === layout.geometry.width ||
              next.geometry.columns === layout.geometry.columns ||
              !(await currentDraw(next))
            )
              return false
            changedLayout = next
            return true
          }, 'remote-width-changed-current-draw')
          if (!changedLayout) throw new Error('native-real-ssh-width-change-unobserved')
          await verifyStty(changedLayout, 'remote-os-pty-width-changed')
          const changedSerial = changedLayout.geometry.serial
          await railControl(true)
          let restoredLayout: typeof layout | undefined
          await wait(async () => {
            const next = await browser.layoutWhenReady()
            if (
              !next ||
              next.geometry.serial <= changedSerial ||
              next.geometry.width !== layout.geometry.width ||
              next.geometry.height !== layout.geometry.height ||
              next.geometry.columns !== layout.geometry.columns ||
              next.geometry.rows !== layout.geometry.rows ||
              !(await currentDraw(next))
            )
              return false
            restoredLayout = next
            return true
          }, 'remote-width-restored-current-draw')
          if (!restoredLayout) throw new Error('native-real-ssh-width-restore-unobserved')
          await verifyStty(restoredLayout, 'remote-os-pty-width-restored')
          if ((await railControl(false)) !== initialRailLabel)
            throw new Error('native-real-ssh-width-control-not-restored')
          restoreRail = false
          await focusSmokeWindow(win, 'window')
          if ((await browser.focus()) !== true)
            throw new Error('native-real-ssh-input-focus')
          for (const keyCode of ['E', 'C', 'H', 'O', 'Space', 'Q', 'Enter'])
            browser.key(keyCode)
          await wait(
            async () => (await read()).split('\n').includes('q'),
            'actual-keyboard-shell-echo',
          )
          await win.webContents.executeJavaScript(clipboardInstall(false))
          probeInstalled = true
          const scope = paneScript(managed.id)
          await evaluate(
            `${scope}input.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',shiftKey:true,...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true}),bubbles:true,cancelable:true}));return true;`,
          )
          await wait(
            () =>
              evaluate<boolean>(
                `${scope}return !!panel.querySelector('.terminal-search');`,
              ),
            'remote-find-open',
          )
          await evaluate(
            `${scope}const query=panel.querySelector('[aria-label="Find in terminal"]');if(!(query instanceof HTMLInputElement))throw new Error('native-real-ssh-query-control');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(query,'q');query.dispatchEvent(new Event('input',{bubbles:true}));return true;`,
          )
          await wait(
            () =>
              evaluate<boolean>(
                `${scope}return /^1 of [1-9][0-9]*$/.test(panel.querySelector('.terminal-search-status')?.textContent?.trim()??'');`,
              ),
            'remote-find-selection',
          )
          await browser.copied(
            'q',
            () =>
              evaluate(
                `${scope}const button=[...panel.querySelectorAll('.terminal-search button')].find(node=>node.textContent?.trim()==='Copy Match');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-real-ssh-copy-control');button.click();return true;`,
              ),
            false,
          )
          await evaluate(
            `${scope}const button=panel.querySelector('[aria-label="Close terminal search"]');if(!(button instanceof HTMLButtonElement))throw new Error('native-real-ssh-find-close');button.click();return true;`,
          )
          await clickProject(localProject.displayName)
          await wait(
            () => !native.targets.drawn(initialViewId, win.webContents.mainFrame),
            'remote-hidden-grant-withdrawn',
          )
          await ptys.writeConfirmed(
            managed.id,
            owner.id,
            `printf '\\r\\nHVIR_REAL_SSH_HIDDEN\\r\\n'\r`,
            owner.generation,
          )
          await wait(
            async () => (await read()).split('\n').includes('HVIR_REAL_SSH_HIDDEN'),
            'remote-hidden-native-output',
          )
          await focusSmokeWindow(win, 'window')
          await clickProject(
            selectedProject.projects.find(
              (entry) => entry.id === selectedProject.activeProjectId,
            )!.displayName,
          )
          await browser.ready()
          await wait(currentDraw, 'remote-reveal-same-actor-current-draw')
          stage = 'remote-explicit-disconnect'
          await bounded(catalog.disconnectHost(config.alias))
          await wait(async () => {
            const retained = native.sessions.get(managed.id)
            return (
              host.connectionState === 'disconnected' &&
              !ptys.get(managed.id) &&
              retained?.readonly === true &&
              retained.handle === handle &&
              retained.session.instanceId === managed.instanceId &&
              (await evaluate<boolean>(
                `${paneScript(managed.id)}return pane.getAttribute('aria-readonly')==='true';`,
              ))
            )
          }, 'remote-disconnected-retained-readonly')
          const disconnectedText = await read()
          if (!disconnectedText.split('\n').includes('HVIR_REAL_SSH_HIDDEN'))
            throw new Error('native-real-ssh-disconnect-lost-retained-state')
          let deadInputRejected = false
          try {
            await ptys.writeConfirmed(managed.id, owner.id, 'x', owner.generation)
          } catch {
            deadInputRejected = true
          }
          if (!deadInputRejected) throw new Error('native-real-ssh-dead-input-admitted')
          stage = 'remote-explicit-reconnect'
          await bounded(host.connect())
          const retainedAfterReconnect = native.sessions.get(managed.id)
          const retainedDraw = await browser.layoutWhenReady()
          const retainedGrant = retainedDraw
            ? native.targets.drawn(retainedDraw.bounds.viewId, win.webContents.mainFrame)
            : undefined
          if (
            host.connectionState !== 'connected' ||
            ptys.list().some((actor) => actor.hostId === host.hostId) ||
            retainedAfterReconnect?.readonly !== true ||
            retainedAfterReconnect.handle !== handle ||
            retainedAfterReconnect.session.instanceId !== managed.instanceId ||
            !retainedGrant ||
            retainedGrant.nativeEpoch !== originalDraw.nativeEpoch ||
            retainedGrant.geometrySerial !== retainedDraw?.geometry.serial ||
            (await read()) !== disconnectedText
          )
            throw new Error('native-real-ssh-reconnect-resumed-or-replaced-terminal')
          const closeSession = async (sessionId: string) => {
            stage = 'remote-explicit-close-control'
            await evaluate(
              `const session=[...document.querySelectorAll('.terminal-list-main')].find(button=>button.getAttribute('data-terminal-session')===${JSON.stringify(sessionId)});const button=session?.closest('.terminal-list-row')?.querySelector('.terminal-close-button');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-real-ssh-close-control');button.click();return true;`,
            )
            await wait(
              () => !ptys.get(sessionId) && !native.sessions.get(sessionId),
              'remote-explicit-close',
            )
          }
          await closeSession(managed.id)
          remote = undefined
          await wait(
            () =>
              evaluate<boolean>(
                `return !!document.querySelector('.workbench:not([hidden]) .terminal-empty button');`,
              ),
            'remote-fresh-shell-action',
          )
          await evaluate(
            `const button=document.querySelector('.workbench:not([hidden]) .terminal-empty button');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-real-ssh-shell-control');button.click();return true;`,
          )
          await wait(() => {
            const actors = ptys.list().filter((actor) => actor.hostId === host.hostId)
            if (actors.length > 1) throw new Error('native-real-ssh-duplicate-fresh-pty')
            remote = actors[0]
            return !!remote
          }, 'remote-explicit-fresh-actor')
          const fresh = remote!
          const freshSession = native.sessions.get(fresh.id)
          if (
            fresh.id === managed.id ||
            fresh.instanceId === managed.instanceId ||
            !freshSession ||
            freshSession.handle === handle ||
            freshSession.readonly ||
            fresh.providerId !== plainShellProvider.manifest.id ||
            !hostPathEquals(fresh.workspaceRoot, remoteRoot)
          )
            throw new Error('native-real-ssh-explicit-new-not-fresh')
          const freshBrowser = nativeSelectionBrowser(win, native, fresh)
          await freshBrowser.ready()
          if (
            new TextDecoder()
              .decode(await native.readRetained(fresh.id, freshBrowser.owner))
              .split('\n')
              .includes('HVIR_REAL_SSH_HIDDEN')
          )
            throw new Error('native-real-ssh-explicit-new-replayed-old-output')
          await focusSmokeWindow(win, 'window')
          if ((await freshBrowser.focus()) !== true)
            throw new Error('native-real-ssh-fresh-input-focus')
          for (const keyCode of ['E', 'C', 'H', 'O', 'Space', 'Q', 'Enter'])
            freshBrowser.key(keyCode)
          await wait(
            async () =>
              new TextDecoder()
                .decode(await native.readRetained(fresh.id, freshBrowser.owner))
                .split('\n')
                .includes('q'),
            'remote-explicit-fresh-keyboard-echo',
          )
          await freshBrowser.ready()
          await closeSession(fresh.id)
          if (ptys.list().length !== baseline)
            throw new Error('native-real-ssh-close-pty-count')
          remote = undefined
          receipt = {
            actualOpenSsh: true,
            loopbackOnly: true,
            remoteOsPty: true,
            appliedGeometry: true,
            uiWidthRoundtrip: true,
            realPtySizeChangedAndRestored: true,
            nativeUI: true,
            plainShellProvider: true,
            keyboardEcho: true,
            queryCopy: true,
            hiddenOutput: true,
            revealSameActor: true,
            nativeEpochPreserved: true,
            currentDraw: true,
            explicitClose: true,
            externalPhysicalHostQualified: false,
            modelHarnessQualified: false,
            explicitDisconnectRetainedReadonly: true,
            reconnectWithoutSilentRespawnOrReplay: true,
            explicitNewFreshActorAndKeyboardEcho: true,
            physicalNetworkOutageQualified: false,
            performanceQualified: false,
          }
        } catch (cause) {
          failed = true
          failure = new Error('native-real-ssh-phase:' + stage, { cause })
        } finally {
          if (restoreRail && initialRailLabel)
            try {
              if ((await railControl(false)) !== initialRailLabel) await railControl(true)
              await wait(
                async () => (await railControl(false)) === initialRailLabel,
                'remote-width-cleanup-restored',
              )
            } catch (error) {
              cleanupFailures.push(error)
            }
          if (probeInstalled)
            try {
              await win.webContents.executeJavaScript(
                'window.nativeSelectionProbe?.restore()',
              )
            } catch (error) {
              cleanupFailures.push(error)
            }
          if (remote)
            try {
              ptys.disposeSession(remote.id, remote.ownerId, remote.ownerGeneration)
            } catch (error) {
              cleanupFailures.push(error)
            }
          try {
            project.publish(initial)
          } catch (error) {
            cleanupFailures.push(error)
          }
        }
        if (cleanupFailures.length)
          throw new AggregateError(
            [...(failed ? [failure] : []), ...cleanupFailures],
            'Native real SSH verify cleanup failed',
            failed ? { cause: failure } : undefined,
          )
        if (failed) throw failure
        if (!receipt) throw new Error('native-real-ssh-incomplete')
        return { ...receipt, verifiedPtyGeometry }
      },
    }
  } catch (error) {
    let cleanupFailure: unknown
    let cleanupFailed = false
    try {
      await dispose()
    } catch (cleanup) {
      cleanupFailure = cleanup
      cleanupFailed = true
    }
    if (cleanupFailed)
      throw new AggregateError([error, cleanupFailure], 'Native real SSH setup failed', {
        cause: error,
      })
    throw error
  }
}
