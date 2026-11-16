import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { Server, type Connection, type ServerChannel } from 'ssh2'

import {
  ProjectHostCatalog,
  SshHost,
  type ProjectHost,
} from '../../src/main/project-host'
import type { ManagedPty, PtySupervisor } from '../../src/main/pty/pty-supervisor'
import type { NativeTerminalApplication } from '../../src/main/terminal/native-terminal-application'
import {
  asHostId,
  hostPath,
  joinHostPath,
  type HostPath,
  type ProjectState,
} from '../../src/shared'
import { createRemoteProjectFileSmokeHost } from '../../src/main/smoke/project-file-operations'

interface ProjectFixture {
  get(): ProjectState
  remote(): ProjectState
  publish(state: ProjectState): void
}
const INPUT = 'hvir-m13-ssh-input'
const RETURN_INPUT = 'hvir-m13-ssh-return-input'
const VISIBLE = 'HVIR_M13_SSH_VISIBLE'
const HIDDEN = 'HVIR_M13_SSH_HIDDEN'
const RECONNECTED = 'HVIR_M13_SSH_CONTROL_RECONNECTED'
const FAILURE_MARK = 'hvir.native.presentation.failure-stage'
const FAILURE_STAGES = [
  'receiver-factory-absent',
  'receiver-factory-throw',
  'receiver-canvas-loss-callback',
  'receiver-get-video-frame',
  'receiver-draw',
  'receiver-pixels',
  'receiver-refit-suspend',
  'canvas-parent-missing',
  'canvas-parent-disconnected',
  'canvas-context-unavailable',
  'canvas-program-unavailable',
  'canvas-texture-unavailable',
  'canvas-shader-unavailable',
  'canvas-shader-compile',
  'canvas-program-link',
  'canvas-uniform-unavailable',
  'canvas-texture-size-invalid',
  'canvas-initialize',
  'canvas-context-lost',
  'canvas-draw-disposed',
  'canvas-draw-disconnected',
  'canvas-draw-context-lost',
  'canvas-draw-size-bound',
  'canvas-draw-configure',
  'canvas-draw-upload',
  'canvas-pixel-disconnected',
  'canvas-pixel-buffer',
  'canvas-pixel-upload',
  'canvas-refit-disposed',
  'canvas-refit-disconnected',
] as const
const FAILURE_FLAGS = [
  'parentPresent',
  'parentConnected',
  'canvasConnected',
  'contextLost',
  'mounted',
  'bindingCurrent',
  'grantPresent',
] as const

/** Real SSH2 transport/native workbench qualification with synthetic filesystem
 * metadata and a disposable protocol endpoint, not an external OS/SSH host proof. */
export async function createNativeTerminalSshLifecycleFixture(
  localHost: ProjectHost,
  localRoot: HostPath,
) {
  const localTransfer = localHost.fileTransfer
  if (!localTransfer) throw new Error('native-ssh-local-transfer-required')
  const root = hostPath(asHostId('smoke-remote'), localRoot.path)
  const home = joinHostPath(localRoot, '.hvir-m13-ssh-' + randomUUID())
  const sshDirectory = joinHostPath(home, '.ssh')
  const configFile = joinHostPath(sshDirectory, 'config')
  const trustFile = joinHostPath(home, 'trust.json')
  let homeOwned = false
  let catalog: ProjectHostCatalog | undefined
  const connections = new Set<Connection>()
  const channels = new Set<ServerChannel>()
  const terminalConnections = new Set<Connection>()
  const terminalChannels = new Set<ServerChannel>()
  let terminalStarts = 0
  let received = Buffer.alloc(0)
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey
  const server = new Server({ hostKeys: [key] }, (client) => {
    connections.add(client)
    client.on('error', () => undefined)
    client.on('close', () => {
      connections.delete(client)
      terminalConnections.delete(client)
    })
    client.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.password === 'owned-m13-fixture-only')
        auth.accept()
      else auth.reject(['password'])
    })
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        let terminal = false
        session.on('pty', (accept) => {
          terminal = true
          accept()
        })
        session.on('env', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('exec', (accept) => {
          const stream = accept()
          channels.add(stream)
          stream.on('error', () => undefined)
          stream.on('close', () => {
            channels.delete(stream)
            terminalChannels.delete(stream)
          })
          if (!terminal) {
            stream.resume()
            // The actual SshHost default-shell query runs over its control transport.
            stream.write('/bin/sh\n')
            stream.exit(0)
            stream.end()
          } else {
            terminalStarts++
            terminalConnections.add(client)
            terminalChannels.add(stream)
            stream.on('data', (bytes: Buffer) => {
              received = Buffer.concat([received, bytes])
            })
            stream.write('\x1b[?1004l' + VISIBLE + '\r\n')
          }
        })
      }),
    )
  })
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> =>
    (disposal ??= (async () => {
      const failures: unknown[] = []
      const cleanup = async (operation: () => void | Promise<void>) => {
        try {
          await operation()
        } catch (error) {
          failures.push(error)
        }
      }
      const closedConnections = [...connections].map(
        (connection) => new Promise<void>((resolve) => connection.once('close', resolve)),
      )
      const closedChannels = [...channels].map(
        (channel) => new Promise<void>((resolve) => channel.once('close', resolve)),
      )
      await cleanup(async () => {
        await catalog?.dispose()
      })
      for (const channel of channels)
        await cleanup(() => {
          channel.resume()
          channel.destroy()
        })
      for (const connection of connections)
        await cleanup(() => {
          connection.end()
        })
      if (server.address())
        await cleanup(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        )
      await cleanup(() =>
        Promise.all([...closedConnections, ...closedChannels]).then(() => undefined),
      )
      if (homeOwned) {
        await cleanup(() => localHost.removeFile(configFile, { ignoreMissing: true }))
        await cleanup(() => localHost.removeFile(trustFile, { ignoreMissing: true }))
        await cleanup(() =>
          localTransfer.removeDirectory(sshDirectory, { ignoreMissing: true }),
        )
        await cleanup(() => localTransfer.removeDirectory(home, { ignoreMissing: true }))
      }
      if (failures.length)
        throw new AggregateError(failures, 'Native SSH fixture cleanup failed')
    })())
  try {
    await localHost.createDirectoryExclusive(home, { mode: 0o755 })
    homeOwned = true
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('native-ssh-listen')
    catalog = await ProjectHostCatalog.create({
      home: home.path,
      trustFile,
      agentSocket: '',
      prompter: {
        prompt: (request) =>
          Promise.resolve(
            request.kind === 'host-key'
              ? ['yes']
              : request.kind === 'password'
                ? ['owned-m13-fixture-only']
                : undefined,
          ),
      },
    })
    await catalog.addSshHost(
      {
        alias: root.hostId,
        hostname: '127.0.0.1',
        port: address.port,
        username: 'fixture',
      },
      () => undefined,
    )
    const ssh = await catalog.materializeHost(root.hostId)
    if (!(ssh instanceof SshHost)) throw new Error('native-ssh-catalog-host-kind')
    const filesystem = createRemoteProjectFileSmokeHost({
      localHost,
      localRoot,
      remoteRoot: root,
    })
    // Only filesystem metadata is projected onto the disposable local root. Every
    // PTY, connection, shell query and transport effect uses the actual SshHost.
    const host: ProjectHost = Object.assign(ssh, {
      fileTransfer: filesystem.fileTransfer,
      fileDeletion: filesystem.fileDeletion,
      realpath: filesystem.realpath.bind(filesystem),
      stat: filesystem.stat.bind(filesystem),
      readdir: filesystem.readdir.bind(filesystem),
      readFile: filesystem.readFile.bind(filesystem),
      createFileExclusive: filesystem.createFileExclusive.bind(filesystem),
      createDirectoryExclusive: filesystem.createDirectoryExclusive.bind(filesystem),
      removeFile: filesystem.removeFile.bind(filesystem),
    })
    return {
      root,
      host,
      dispose,
      async verify(
        win: BrowserWindow,
        ptys: PtySupervisor,
        native: NativeTerminalApplication,
        localManaged: ManagedPty,
        project: ProjectFixture,
      ) {
        const initial = project.get()
        const local = native.sessions.get(localManaged.id)
        if (
          !local ||
          local.session.workspaceRoot.hostId === root.hostId ||
          local.session.workspaceRoot.path !== root.path
        )
          throw new Error('native-ssh-local-baseline')
        const localOwner = {
          id: local.session.ownerId,
          generation: local.session.ownerGeneration,
        }
        const digest = (bytes: Uint8Array) =>
          createHash('sha256').update(bytes).digest('hex')
        const localBefore = digest(await native.readRetained(localManaged.id, localOwner))
        const baselinePtys = ptys.list().length
        const evaluate = <T>(body: string): Promise<T> =>
          win.webContents.executeJavaScript(`(()=>{${body}})()`)
        let phase = 'setup'
        const wait = async (read: () => boolean | Promise<boolean>, stage: string) => {
          phase = stage
          const deadline = Date.now() + 15000
          do {
            if (await read()) return
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          } while (Date.now() < deadline)
          throw new Error('native-ssh-timeout:' + stage)
        }
        const canvas = () =>
          evaluate<boolean>(
            `return !!document.querySelector('.workbench:not([hidden]) .native-terminal-pane canvas');`,
          )
        const clickProject = (name: string) =>
          evaluate(
            `const action=[...document.querySelectorAll('.project-tab-main')].find(button=>button.querySelector('strong')?.textContent?.trim()===${JSON.stringify(name)});if(!(action instanceof HTMLButtonElement)||action.disabled)throw new Error('native-ssh-project-action');action.click();return true;`,
          )
        let remote: ManagedPty | undefined
        let viewId: string | undefined
        let nativeHandle: string | undefined
        let observingStatus = false
        try {
          await evaluate(`
          const key='__hvirNativeSshStatusFixture';
          const previous=Object.getOwnPropertyDescriptor(window,key);
          const values=[];
          const failures=[];
          const stages=${JSON.stringify(FAILURE_STAGES)};
          const flagNames=${JSON.stringify(FAILURE_FLAGS)};
          const consume=entries=>{
            for(const entry of entries){
              if(entry.name!==${JSON.stringify(FAILURE_MARK)})continue;
              const detail=entry.detail;
              if(!detail||typeof detail!=='object'||!stages.includes(detail.stage))continue;
              const flags={};
              for(const name of flagNames)if(typeof detail.flags?.[name]==='boolean')flags[name]=detail.flags[name];
              failures.push({stage:detail.stage,flags});
              if(failures.length>16)failures.shift();
            }
          };
          let observer;
          try{observer=new PerformanceObserver(list=>consume(list.getEntries()));observer.observe({type:'mark'});}catch{observer?.disconnect();observer=undefined;}
          const stop=window.hvir.nativeTerminalPresentation.onStatus(status=>{
            if(!status||!/^[a-f0-9-]{36}$/.test(status.viewId)||!['native-gpu','native-pixels','unavailable'].includes(status.mode))return;
            const reasons=['import-unavailable','renderer-lost','native-lost','pixel-bound','geometry-failed'];
            values.push({viewId:status.viewId,mode:status.mode,...(status.reason===undefined?{}:{reason:reasons.includes(status.reason)?status.reason:'unknown'})});
            if(values.length>16)values.shift();
          });
          Object.defineProperty(window,key,{configurable:true,value:{
            read:()=>values.slice(),
            readFailures:()=>{try{if(observer)consume(observer.takeRecords());}catch{}return failures.slice();},
            failureObserverAvailable:()=>!!observer,
            dispose:()=>{try{stop();}finally{try{observer?.disconnect();}finally{if(previous)Object.defineProperty(window,key,previous);else delete window[key];}}}
          }});
          return true;
        `)
          observingStatus = true
          await ssh.connect()
          const selected = project.remote()
          const remoteState = {
            ...selected,
            projects: [...initial.projects, ...selected.projects],
          }
          project.publish(remoteState)
          await wait(
            () =>
              evaluate(
                `return !!document.querySelector('.workbench:not([hidden]) .terminal-empty button');`,
              ),
            'empty-remote-workspace',
          )
          await evaluate(
            `const action=document.querySelector('.workbench:not([hidden]) .terminal-empty button');if(!(action instanceof HTMLButtonElement))throw new Error('native-ssh-launch-action');action.click();return true;`,
          )
          await wait(() => {
            const matches = ptys.list().filter((item) => item.hostId === root.hostId)
            if (matches.length > 1) throw new Error('native-ssh-duplicate-pty')
            remote = matches[0]
            return !!remote
          }, 'ordinary-ssh-launch')
          const managed = remote!
          const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
          const read = async () =>
            new TextDecoder().decode(await native.readRetained(managed.id, owner))
          await wait(async () => (await read()).includes(VISIBLE), 'native-ssh-parser')
          await wait(canvas, 'ordinary-native-canvas')
          const handle = native.sessions.get(managed.id)?.handle
          nativeHandle = handle
          if (
            !handle ||
            managed.workspaceRoot.hostId !== root.hostId ||
            managed.workspaceRoot.path !== localManaged.workspaceRoot.path
          )
            throw new Error('native-ssh-host-qualified-identity')
          viewId = await evaluate<string>(
            `return document.querySelector('.workbench:not([hidden]) .native-terminal-pane [id^="native-terminal-"]').id.slice('native-terminal-'.length);`,
          )
          await wait(
            () => !!native.targets.drawn(viewId!, win.webContents.mainFrame),
            'native-ssh-drawn-authority',
          )
          await evaluate(
            `const input=document.querySelector('.workbench:not([hidden]) .native-terminal-pane textarea');if(!(input instanceof HTMLTextAreaElement))throw new Error('native-ssh-input');input.focus({preventScroll:true});return true;`,
          )
          win.focus()
          win.webContents.focus()
          await win.webContents.insertText(INPUT)
          await wait(() => received.equals(Buffer.from(INPUT)), 'ordinary-native-input')
          const channel = [...terminalChannels][0]
          if (!channel || terminalChannels.size !== 1)
            throw new Error('native-ssh-channel-identity')
          await clickProject(
            initial.projects.find((item) => item.id === initial.activeProjectId)!
              .displayName,
          )
          await wait(
            () => !native.targets.drawn(viewId!, win.webContents.mainFrame),
            'hidden-frame-revocation',
          )
          channel.pause()
          channel.write('\r\n' + HIDDEN + '\r\n\x1b[5')
          // Deliberately split the CSI request and delay receiver consumption.
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
          channel.write('n')
          await wait(async () => (await read()).includes(HIDDEN), 'hidden-native-output')
          channel.resume()
          await wait(
            () => received.equals(Buffer.from(INPUT + '\x1b[0n')),
            'exact-native-csi-reply',
          )
          if (
            digest(await native.readRetained(localManaged.id, localOwner)) !== localBefore
          )
            throw new Error('native-ssh-crossed-local-state')
          // Retiring only control transport must not replace its independent PTY.
          let reconnected!: () => void
          const reconnecting = new Promise<void>((resolve) => {
            reconnected = resolve
          })
          const stopConnection = ssh.onConnectionState((state) => {
            if (state === 'reconnecting') reconnected()
          })
          let reconnectTimer: ReturnType<typeof setTimeout> | undefined
          try {
            for (const connection of connections)
              if (!terminalConnections.has(connection)) connection.end()
            await Promise.race([
              reconnecting,
              new Promise<never>((_resolve, reject) => {
                reconnectTimer = setTimeout(
                  () => reject(new Error('native-ssh-timeout:control-disconnect')),
                  15000,
                )
              }),
            ])
            await ssh.connect()
            if (ssh.connectionState !== 'connected')
              throw new Error('native-ssh-control-not-connected')
          } finally {
            clearTimeout(reconnectTimer)
            await stopConnection()
          }
          if (
            ptys.get(managed.id)?.instanceId !== managed.instanceId ||
            terminalStarts !== 1 ||
            native.sessions.get(managed.id)?.handle !== handle
          )
            throw new Error('native-ssh-reconnect-replaced-terminal')
          channel.write('\r\n' + RECONNECTED + '\r\n')
          await wait(
            async () => (await read()).includes(RECONNECTED),
            'hidden-after-control-reconnect',
          )
          await evaluate(
            `const action=document.querySelector('.sessions-destination');if(!(action instanceof HTMLButtonElement))throw new Error('native-ssh-sessions-action');action.click();return true;`,
          )
          const remoteGroup = `const group=[...document.querySelectorAll('.sessions-group')].find(group=>group.querySelector('h2')?.textContent?.trim()==='remote-hvir');`
          await wait(
            () =>
              evaluate(
                `${remoteGroup}return !!group&&[...group.querySelectorAll('button')].some(button=>button.textContent?.trim()==='Interact'&&!button.disabled);`,
              ),
            'ssh-sessions-interact',
          )
          await evaluate(
            `${remoteGroup}const action=[...group.querySelectorAll('button')].find(button=>button.textContent?.trim()==='Interact'&&!button.disabled);if(!(action instanceof HTMLButtonElement))throw new Error('native-ssh-interact-action');action.click();return true;`,
          )
          await wait(
            () =>
              evaluate(
                `return !!document.querySelector('.sessions-detail-terminal.ready canvas');`,
              ),
            'ssh-sessions-borrowed-canvas',
          )
          channel.write('\r\nHVIR_M13_SSH_SESSIONS_INTERACT\r\n')
          await wait(
            async () => (await read()).includes('HVIR_M13_SSH_SESSIONS_INTERACT'),
            'ssh-sessions-native-output',
          )
          if (
            ptys.get(managed.id)?.instanceId !== managed.instanceId ||
            native.sessions.get(managed.id)?.handle !== handle
          )
            throw new Error('native-ssh-sessions-replaced-state')
          await evaluate(
            `const action=[...document.querySelectorAll('.sessions-terminal-detail button')].find(button=>button.textContent?.trim()==='Close');if(!(action instanceof HTMLButtonElement))throw new Error('native-ssh-detail-close');action.click();return true;`,
          )
          await wait(
            () =>
              evaluate(`return !document.querySelector('.sessions-terminal-detail');`),
            'ssh-sessions-return',
          )
          await clickProject(
            selected.projects.find((item) => item.id === selected.activeProjectId)!
              .displayName,
          )
          await wait(canvas, 'ssh-return-canvas')
          const returnedView = await evaluate<string>(
            `return document.querySelector('.workbench:not([hidden]) .native-terminal-pane [id^="native-terminal-"]').id.slice('native-terminal-'.length);`,
          )
          await wait(
            () => !!native.targets.drawn(returnedView, win.webContents.mainFrame),
            'ssh-return-drawn-authority',
          )
          win.focus()
          win.webContents.focus()
          await evaluate(
            `const input=document.querySelector('.workbench:not([hidden]) .native-terminal-pane textarea');if(!(input instanceof HTMLTextAreaElement))throw new Error('native-ssh-return-input');input.focus({preventScroll:true});return true;`,
          )
          await win.webContents.insertText(RETURN_INPUT)
          await wait(
            () => received.equals(Buffer.from(INPUT + '\x1b[0n' + RETURN_INPUT)),
            'ssh-return-input-lease',
          )
          if (
            ptys.get(managed.id)?.instanceId !== managed.instanceId ||
            native.sessions.get(managed.id)?.handle !== handle ||
            terminalStarts !== 1 ||
            terminalChannels.size !== 1 ||
            !terminalChannels.has(channel)
          )
            throw new Error('native-ssh-return-input-replaced-state')
          for (const connection of terminalConnections) connection.end()
          await wait(
            () => native.sessions.get(managed.id)?.readonly === true,
            'terminal-disconnect-readonly',
          )
          if (
            ptys.get(managed.id) ||
            native.sessions.get(managed.id)?.handle !== handle ||
            !(await read()).includes(HIDDEN)
          )
            throw new Error('native-ssh-disconnect-retention')
          await evaluate(
            `const action=document.querySelector('.workbench:not([hidden]) .terminal-close-button');if(!(action instanceof HTMLButtonElement))throw new Error('native-ssh-close-action');action.click();return true;`,
          )
          await wait(() => !native.sessions.get(managed.id), 'ordinary-ssh-close')
          await wait(async () => !(await canvas()), 'ordinary-ssh-canvas-release')
          if (native.targets.drawn(returnedView, win.webContents.mainFrame))
            throw new Error('native-ssh-close-retained-frame-authority')
          await dispose()
          if (
            connections.size ||
            channels.size ||
            terminalChannels.size ||
            terminalConnections.size ||
            ssh.transportDiagnostics().length ||
            ptys.list().length !== baselinePtys
          )
            throw new Error('native-ssh-resource-quiescence')
          return {
            ordinaryTerminalUi: true,
            realSsh2Transport: true,
            realNativeParser: true,
            syntheticFilesystemMetadata: true,
            syntheticRemoteProgram: true,
            externalSshHostQualified: false,
            remoteOsPtyQualified: false,
            sharedNativeHostLossQualified: false,
            sameNamedHostPathsIsolated: true,
            hiddenOutputAndReply: true,
            ordinaryWorkspaceNavigation: true,
            ordinarySessionsHandoff: true,
            returnedInputLease: true,
            inputBytes: Buffer.byteLength(INPUT) + Buffer.byteLength(RETURN_INPUT),
            replyBytes: 4,
            inputAndReplySha256: digest(received),
            terminalStarts,
            controlReconnectRetainedPty: true,
            terminalDisconnectRetainedParser: true,
            explicitUiClose: true,
            remainingConnections: connections.size,
            remainingChannels: channels.size,
            remainingHostTransports: ssh.transportDiagnostics().length,
          }
        } catch (error) {
          // Capture semantic state before cleanup changes physical/process facts.
          // No DOM body, terminal content or arbitrary error text enters this record.
          const currentPty = remote && ptys.get(remote.id)
          const currentNative = remote && native.sessions.get(remote.id)
          let browser: unknown = { available: false }
          let currentViews: string[] = []
          try {
            const state = await evaluate<{
              canvases: number
              workspaceCanvases: number
              borrowedCanvases: number
              readonlyPanes: number
              unavailableSurfaces: number
              destination: 'workspace' | 'sessions'
              paneErrors: string[]
              currentViews: string[]
              activeViewId?: string
              recentModes: string[]
              recentStatuses: { viewId: string; mode: string; reason?: string }[]
              failureStages: { stage: string; flags: Record<string, boolean> }[]
              failureObserverAvailable: boolean
            }>(`return {
            canvases:document.querySelectorAll('.native-terminal-pane canvas').length,
            workspaceCanvases:document.querySelectorAll('.workbench:not([hidden]) .native-terminal-pane canvas').length,
            borrowedCanvases:document.querySelectorAll('.sessions-detail-terminal canvas').length,
            readonlyPanes:document.querySelectorAll('.native-terminal-pane[aria-readonly="true"]').length,
            unavailableSurfaces:[...document.querySelectorAll('.native-terminal-pane [role="status"]')].filter(node=>node.textContent==='Terminal unavailable').length,
            destination:document.querySelector('.sessions-destination.active')?'sessions':'workspace',
            paneErrors:[...document.querySelectorAll('.native-terminal-pane [role="status"]')].map(node=>node.textContent).filter(Boolean).map(text=>text==='Terminal unavailable'?'surface-unavailable':text==='Native terminal unavailable'?'binding-unavailable':text==='Native appearance unavailable'?'appearance-unavailable':text==='Native input unavailable; terminal output remains visible'?'input-unavailable':text==='Compatibility rendering'?'compatibility':'other').slice(0,8),
            currentViews:[...document.querySelectorAll('.native-terminal-pane [id^="native-terminal-"]')].map(node=>node.id.slice('native-terminal-'.length)).filter(id=>/^[a-f0-9-]{36}$/.test(id)).slice(0,8),
            activeViewId:document.querySelector('.workbench:not([hidden]) .native-terminal-pane [id^="native-terminal-"]')?.id.slice('native-terminal-'.length),
            recentStatuses:window.__hvirNativeSshStatusFixture?.read()??[],
            failureStages:window.__hvirNativeSshStatusFixture?.readFailures()??[],
            failureObserverAvailable:window.__hvirNativeSshStatusFixture?.failureObserverAvailable()??false,
            recentModes:Array.isArray(window.nativeQualificationModes)?window.nativeQualificationModes.filter(mode=>['native-gpu','native-pixels','unavailable'].includes(mode)).slice(-8):[]
          };`)
            currentViews = state.currentViews
            browser = {
              available: true,
              ...state,
              sameOriginalView: !!viewId && state.activeViewId === viewId,
            }
          } catch {
            // The original failure remains authoritative if its document is gone.
          }
          let nativeStatus: unknown = { available: false }
          if (remote && currentNative) {
            try {
              const status = await native.inspectRetained(remote.id, {
                id: currentNative.session.ownerId,
                generation: currentNative.session.ownerGeneration,
              })
              nativeStatus = {
                available: true,
                geometrySerial: status.geometry.serial,
                failure: status.failure,
                presentationFailure: status.presentationFailure,
                rendererHealth: status.rendererHealth,
                inputFailure: status.inputFailure,
                closing: status.closing,
                queuedReplyBytes: status.queuedReplyBytes,
              }
            } catch {
              // Retiring or lost native identity need not admit an inspect job.
            }
          }
          console.error(
            'HVIR_NATIVE_SSH_LIFECYCLE_FAILURE ' +
              JSON.stringify({
                phase,
                project: {
                  id: project.get().activeProjectId,
                  workspace: project.get().activeWorkspaceId,
                  remoteSelected: project.get().root.hostId === root.hostId,
                },
                pty: {
                  present: !!currentPty,
                  sameInstance: !!remote && currentPty?.instanceId === remote.instanceId,
                  samePid: !!remote && currentPty?.pid === remote.pid,
                },
                native: {
                  present: !!currentNative,
                  sameHandle: !!currentNative && currentNative.handle === nativeHandle,
                  sameInstance:
                    !!remote && currentNative?.session.instanceId === remote.instanceId,
                  readonly: currentNative?.readonly,
                  unavailable: currentNative?.unavailable,
                  retiring: currentNative?.retiring,
                  inputUnavailable: currentNative?.inputUnavailable,
                },
                nativeStatus,
                drawn: {
                  original:
                    !!viewId && !!native.targets.drawn(viewId, win.webContents.mainFrame),
                  current: currentViews.map(
                    (id) => !!native.targets.drawn(id, win.webContents.mainFrame),
                  ),
                },
                browser,
                connectionState: ssh.connectionState,
                transports: ssh
                  .transportDiagnostics()
                  .map(({ role, channels }) => ({ role, channels })),
                server: {
                  connections: connections.size,
                  channels: channels.size,
                  terminalChannels: terminalChannels.size,
                  terminalStarts,
                },
              }),
          )
          throw error
        } finally {
          try {
            if (observingStatus)
              await evaluate(
                `window.__hvirNativeSshStatusFixture?.dispose();return true;`,
              )
          } finally {
            if (remote) {
              ptys.disposeSession(remote.id, remote.ownerId, remote.ownerGeneration)
              await native.remove(remote.id, remote.instanceId)
            }
            project.publish(initial)
            await dispose()
          }
        }
      },
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Native SSH fixture setup failed', {
        cause: cleanup,
      })
    }
    throw error
  }
}
