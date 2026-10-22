import { createServer } from 'node:net'
import { createSocket } from 'node:dgram'
import { BrowserWindow, type WebContents } from 'electron'

/** Positive transports establish that an absent guest packet means engine refusal. */
export async function verifyExtensionWebRtc(guest: WebContents): Promise<void> {
  const tcp = createServer((socket) => {
    tcpContacts++
    socket.destroy()
  })
  const udp = createSocket('udp4')
  let tcpContacts = 0,
    udpContacts = 0
  udp.on('message', () => {
    udpContacts++
  })
  const listenTcp = new Promise<void>((resolve, reject) => {
    tcp.once('error', reject)
    tcp.listen(0, '127.0.0.1', resolve)
  })
  const listenUdp = new Promise<void>((resolve, reject) => {
    udp.once('error', reject)
    udp.bind(0, '127.0.0.1', resolve)
  })
  let control: BrowserWindow | undefined
  try {
    await Promise.all([listenTcp, listenUdp])
    const tcpAddress = tcp.address()
    if (!tcpAddress || typeof tcpAddress === 'string')
      throw new Error('TCP probe did not listen')
    const udpPort = udp.address().port
    const configuration = {
      iceServers: [
        {
          urls: `turn:127.0.0.1:${tcpAddress.port}?transport=tcp`,
          username: 'fixture',
          credential: 'fixture',
        },
        { urls: `stun:127.0.0.1:${udpPort}` },
      ],
    }
    const setup = `const connection = new RTCPeerConnection(${JSON.stringify(configuration)}); connection.createDataChannel('fixture'); globalThis.fixtureConnection = connection; await connection.setLocalDescription(await connection.createOffer());`
    control = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    })
    await control.loadURL('data:text/html,<title>Extension RTC transport control</title>')
    await control.webContents.executeJavaScript(
      `(async () => { ${setup} return true })()`,
    )
    await observeUntil(
      () => tcpContacts > 0 && udpContacts > 0,
      'positive TCP and UDP WebRTC controls',
    )
    await control.webContents.executeJavaScript('fixtureConnection.close()')
    control.destroy()
    control = undefined
    const tcpBefore = tcpContacts,
      udpBefore = udpContacts
    const script = `(async () => {
      let connection;
      try {
        ${setup.replace('const connection = ', 'connection = ')}
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('RTC engine did not refuse')), 3000);
          const done = () => { if (connection.connectionState === 'failed') { clearTimeout(timer); resolve() } };
          connection.addEventListener('connectionstatechange', done); done();
        });
        return { refused: true, state: 'failed' };
      } catch (error) {
        if (error.name !== 'NotAllowedError') throw error;
        return { refused: true, error: error.name };
      } finally { connection?.close() }
    })()`
    // This distinct world has the original browser constructor: the main-world
    // preload override cannot make the engine evidence pass.
    const result = (await guest.executeJavaScriptInIsolatedWorld(999, [
      { code: script },
    ])) as { refused?: boolean; state?: string; error?: string }
    if (result.refused !== true || tcpContacts !== tcpBefore || udpContacts !== udpBefore)
      throw new Error('Extension RTC engine allowed a network transport')
    const freshRealm: unknown = await guest.executeJavaScript(`(async () => {
      const frame = document.createElement('iframe'); document.body.append(frame);
      let outcome;
      try {
        const Constructor = frame.contentWindow.RTCPeerConnection;
        const connection = new Constructor(${JSON.stringify(configuration)});
        connection.createDataChannel('fresh-realm'); await connection.setLocalDescription(await connection.createOffer());
        outcome = await new Promise((resolve) => { const finish = () => resolve(connection.connectionState); connection.addEventListener('connectionstatechange', finish, { once: true }); if (connection.connectionState === 'failed') finish(); setTimeout(() => resolve(connection.connectionState), 1000) });
        connection.close();
      } catch (error) { if (error.name !== 'NotAllowedError') throw error; outcome = 'refused' }
      frame.remove(); return outcome;
    })()`)
    if (freshRealm !== 'failed' && freshRealm !== 'refused')
      throw new Error('Fresh guest realm did not inherit WebRTC refusal')
    if (tcpContacts !== tcpBefore || udpContacts !== udpBefore)
      throw new Error('Fresh guest realm contacted WebRTC transport')
  } finally {
    control?.destroy()
    await Promise.all([
      new Promise<void>((resolve) => tcp.close(() => resolve())),
      new Promise<void>((resolve) => {
        try {
          udp.close(resolve)
        } catch {
          resolve()
        }
      }),
    ])
  }
}

async function observeUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Missing ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
