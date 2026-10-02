import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { BrowserWindow, type WebContents } from 'electron'

/** Reachable positive controls distinguish isolation from an unavailable destination. */
export async function verifyExtensionNetwork(guest: WebContents): Promise<void> {
  let httpContacts = 0,
    socketContacts = 0
  const server = createServer((_request, response) => {
    httpContacts++
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
    response.end('reachable fixture')
  })
  server.on('upgrade', (request, socket) => {
    socketContacts++
    const accept = createHash('sha1')
      .update(
        `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest('base64')
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
  })
  let control: BrowserWindow | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Network fixture did not listen')
    const http = `http://127.0.0.1:${address.port}/fixture`
    const socket = `ws://127.0.0.1:${address.port}/fixture`
    const probe = (realm: string): string => `(async () => {
      const realm = ${realm};
      const http = await realm.fetch(${JSON.stringify(http)}).then(response => response.ok, () => false);
      const socket = await new Promise(resolve => {
        let connection;
        try { connection = new realm.WebSocket(${JSON.stringify(socket)}) } catch { resolve(false); return }
        const timer = setTimeout(() => { connection.close(); resolve(false) }, 1500);
        connection.onopen = () => { clearTimeout(timer); connection.close(); resolve(true) };
        connection.onerror = () => { clearTimeout(timer); resolve(false) };
      });
      return { http, socket };
    })()`
    control = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    await control.loadURL('data:text/html,<title>Extension network control</title>')
    const positive = (await control.webContents.executeJavaScript(probe('window'))) as {
      http: boolean
      socket: boolean
    }
    if (!positive.http || !positive.socket || !httpContacts || !socketContacts)
      throw new Error('HTTP/WebSocket positive network controls failed')
    control.destroy()
    control = undefined
    const before = { httpContacts, socketContacts }
    for (const realm of [
      'window',
      "(() => { const frame = document.createElement('iframe'); document.body.append(frame); return frame.contentWindow })()",
    ]) {
      const result = (await guest.executeJavaScript(probe(realm))) as {
        http: boolean
        socket: boolean
      }
      if (
        result.http ||
        result.socket ||
        httpContacts !== before.httpContacts ||
        socketContacts !== before.socketContacts
      )
        throw new Error(
          'Guest or fresh realm contacted an ungranted HTTP/WebSocket origin',
        )
    }
    await guest.executeJavaScript(
      "document.querySelectorAll('iframe').forEach(frame => frame.remove())",
    )
  } finally {
    control?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
