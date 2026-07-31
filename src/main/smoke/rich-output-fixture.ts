import { joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

const FAKE_CODEX = String.raw`#!/usr/bin/env python3
import json
import os
import re
import select
import socket
import sys
import time

def unix_path(value):
    return value.removeprefix("unix://")

def connect(path):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    deadline = time.time() + 4
    while True:
        try:
            client.connect(path)
            return client
        except (FileNotFoundError, ConnectionRefusedError):
            if time.time() >= deadline:
                raise
            time.sleep(0.025)

def notification(method, params):
    return json.dumps(
        {"jsonrpc": "2.0", "method": method, "params": params},
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"

def emit_message(connection, thread_id, index):
    turn_id = "smoke-turn-" + str(index)
    item_id = "smoke-message-" + str(index)
    if index == 1:
        parts = [
            "# Progressive smoke\n",
            "\n[Open docs](https://example.com/) and [package](file:package.json)\n",
        ]
    elif index == 2:
        parts = ["native fallback marker\n"]
    else:
        parts = ["## Hidden rich smoke\n", "\nretained while hidden\n"]
    text = "".join(parts)
    connection.sendall(notification("item/started", {
        "threadId": thread_id,
        "turnId": turn_id,
        "item": {"type": "agentMessage", "id": item_id},
    }))
    for part in parts:
        connection.sendall(notification("item/agentMessage/delta", {
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": item_id,
            "delta": part,
        }))
        time.sleep(0.35)
    connection.sendall(notification("item/completed", {
        "threadId": thread_id,
        "turnId": turn_id,
        "item": {"type": "agentMessage", "id": item_id, "text": text},
    }))

def app_server(arguments):
    listen_at = arguments.index("--listen")
    path = unix_path(arguments[listen_at + 1])
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(path)
    listener.listen(1)
    connection, _ = listener.accept()
    buffer = b""
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            return
        buffer += chunk
        while b"\n" in buffer:
            raw, buffer = buffer.split(b"\n", 1)
            try:
                request = json.loads(raw)
            except Exception:
                continue
            if request.get("method") != "hvir/smoke":
                continue
            params = request.get("params") or {}
            emit_message(connection, params["threadId"], params["index"])

def tui(arguments):
    remote_at = arguments.index("--remote")
    client = connect(unix_path(arguments[remote_at + 1]))
    session_id = next(
        (
            value
            for value in reversed(arguments)
            if re.fullmatch(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                value,
            )
        ),
        "00000000-0000-4000-8000-000000000000",
    )
    sys.stdout.write("\x1b]0;Rich output smoke\x07")
    sys.stdout.flush()
    buffer = b""
    while True:
        readable, _, _ = select.select([sys.stdin, client], [], [], 0.5)
        if sys.stdin in readable:
            line = sys.stdin.readline()
            if line == "":
                return
            command = line.strip()
            if command == "render-rich":
                client.sendall(json.dumps({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "hvir/smoke",
                    "params": {"threadId": session_id, "index": 1},
                }, separators=(",", ":")).encode("utf-8") + b"\n")
            elif command == "render-native":
                client.sendall(json.dumps({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "hvir/smoke",
                    "params": {"threadId": session_id, "index": 2},
                }, separators=(",", ":")).encode("utf-8") + b"\n")
            elif command == "render-rich-hidden":
                client.sendall(json.dumps({
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "hvir/smoke",
                    "params": {"threadId": session_id, "index": 3},
                }, separators=(",", ":")).encode("utf-8") + b"\n")
            else:
                sys.stdout.write("input:" + command + "\n")
                sys.stdout.flush()
        if client in readable:
            chunk = client.recv(65536)
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                raw, buffer = buffer.split(b"\n", 1)
                sys.stdout.write(raw.decode("utf-8", "replace") + "\n")
                sys.stdout.flush()

arguments = sys.argv[1:]
if "--version" in arguments:
    print("hvir-agent 0.146.2")
elif arguments[:1] == ["app-server"]:
    app_server(arguments)
elif "--remote" in arguments:
    tui(arguments)
else:
    raise SystemExit(2)
`

export interface RichOutputSmokeFixture {
  readonly executable: HostPath
  readonly dispose: () => Promise<void>
}

/**
 * Supplies a deterministic Codex 0.146.x transport only to the Electron smoke
 * process. The product still exercises its real provider, proxy, PTY and IPC
 * seams; the fixture replaces only the external Codex executable.
 */
export async function installRichOutputSmokeFixture(
  host: ProjectHost,
  root: HostPath,
): Promise<RichOutputSmokeFixture> {
  const executable = joinHostPath(root, '.hvir-smoke-agent')
  await host.writeFile(executable, FAKE_CODEX)
  const mode = await host.exec('chmod', ['700', executable.path])
  if (mode.code !== 0) throw new Error('Rich output smoke fixture was not executable')
  return {
    executable,
    dispose: async () => {
      await host.exec('rm', ['-f', '--', executable.path]).then(() => undefined)
    },
  }
}
