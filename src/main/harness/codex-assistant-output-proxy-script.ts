/**
 * Runs on the owning ProjectHost via `python3 -c`; it installs no remote file
 * or service. Stdout is reserved for bounded assistant lifecycle JSON.
 */
export const CODEX_ASSISTANT_OUTPUT_PROXY_SCRIPT = String.raw`
import hashlib
import json
import os
import select
import socket
import sys
import threading
REVISION = 1
MAX_RECORD = 64 * 1024
MAX_DELTA = 8 * 1024
MAX_MESSAGE = 1024 * 1024

front_path, back_path = sys.argv[1], sys.argv[2]
desired_rich = False
healthy = True
mode_lock = threading.Lock()
order = 0
active = None
seen = {}

def control():
    global desired_rich, healthy, active
    try:
        for line in sys.stdin:
            parts = line.rstrip("\n").split("\t")
            with mode_lock:
                if len(parts) == 2 and parts[0] == "MODE":
                    desired_rich = parts[1] == "1" and healthy
                elif parts == ["REVOKE"]:
                    desired_rich = False
                    healthy = False
                    if active and active["owner"] == "rich":
                        active["revoked"] = True
    finally:
        with mode_lock:
            desired_rich = False
            healthy = False
            if active and active["owner"] == "rich":
                active["revoked"] = True

def emit(kind, source_id, thread_id, turn_id, item_id, **extra):
    global order
    order += 1
    frame = {
        "revision": REVISION,
        "sourceId": source_id,
        "order": order,
        "kind": kind,
        "threadId": thread_id,
        "turnId": turn_id,
        "itemId": item_id,
    }
    frame.update(extra)
    try:
        sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        pass

def revoke(source_id):
    global desired_rich, healthy
    with mode_lock:
        was_healthy = healthy
        healthy = False
        desired_rich = False
    if (
        was_healthy
        and active
        and active["owner"] == "rich"
        and not active["revoked"]
    ):
        emit(
            "abort",
            source_id,
            active["thread"],
            active["turn"],
            active["item"],
            reason="source-invalid",
        )
        active["revoked"] = True

def source_identity(message, raw):
    emitted_at = message.get("emittedAtMs")
    if (
        isinstance(emitted_at, bool)
        or not isinstance(emitted_at, int)
        or emitted_at < 0
    ):
        return None
    return "h:" + hashlib.sha256(raw).hexdigest()

def utf8_chunks(text):
    chunk = []
    size = 0
    for character in text:
        encoded_size = len(character.encode("utf-8"))
        if chunk and size + encoded_size > MAX_DELTA:
            yield "".join(chunk)
            chunk = []
            size = 0
        chunk.append(character)
        size += encoded_size
    if chunk or not text:
        yield "".join(chunk)

def classify(raw):
    global active
    try:
        text = raw.decode("utf-8", "strict")
        message = json.loads(text)
    except Exception:
        revoke("invalid:" + str(order + 1))
        return True
    if not isinstance(message, dict):
        revoke("invalid:" + str(order + 1))
        return True
    method = message.get("method")
    params = message.get("params")
    if method not in (
        "item/started",
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
    ):
        return True
    source_id = source_identity(message, raw)
    if source_id is None:
        revoke("unstamped:" + str(order + 1))
        return True
    prior = seen.get(source_id)
    digest = hashlib.sha256(raw).digest()
    if prior is not None:
        if prior[0] != digest:
            revoke(source_id)
            return True
        return prior[1]
    forward = True
    if not isinstance(params, dict):
        revoke(source_id)
        seen[source_id] = (digest, True)
        return True
    thread_id = params.get("threadId")
    turn_id = params.get("turnId")
    if not isinstance(thread_id, str):
        revoke(source_id)
        seen[source_id] = (digest, True)
        return True
    if method != "turn/completed" and not isinstance(turn_id, str):
        revoke(source_id)
        seen[source_id] = (digest, True)
        return True
    if method == "item/started":
        item = params.get("item")
        if not isinstance(item, dict) or item.get("type") != "agentMessage":
            seen[source_id] = (digest, True)
            return True
        item_id = item.get("id")
        if not isinstance(item_id, str) or active is not None:
            revoke(source_id)
            seen[source_id] = (digest, True)
            return True
        with mode_lock:
            owner = "rich" if desired_rich and healthy else "native"
        active = {
            "owner": owner,
            "revoked": False,
            "thread": thread_id,
            "turn": turn_id,
            "item": item_id,
            "hash": hashlib.sha256(),
            "bytes": 0,
        }
        if owner == "rich":
            emit("start", source_id, thread_id, turn_id, item_id)
            forward = False
    elif method == "item/agentMessage/delta":
        item_id = params.get("itemId")
        delta = params.get("delta")
        if (
            active is None
            or item_id != active["item"]
            or thread_id != active["thread"]
            or turn_id != active["turn"]
            or not isinstance(delta, str)
        ):
            revoke(source_id)
            seen[source_id] = (digest, True)
            return True
        if active["owner"] == "rich":
            encoded = delta.encode("utf-8")
            if active["bytes"] + len(encoded) > MAX_MESSAGE:
                revoke(source_id)
                forward = False
            else:
                active["bytes"] += len(encoded)
                active["hash"].update(encoded)
                if not active["revoked"]:
                    for index, part in enumerate(utf8_chunks(delta)):
                        emit(
                            "delta",
                            source_id + ":" + str(index),
                            thread_id,
                            turn_id,
                            item_id,
                            text=part,
                        )
                forward = False
    elif method == "item/completed":
        item = params.get("item")
        item_id = item.get("id") if isinstance(item, dict) else None
        if (
            active is None
            or not isinstance(item, dict)
            or item.get("type") != "agentMessage"
            or item_id != active["item"]
            or thread_id != active["thread"]
            or turn_id != active["turn"]
        ):
            revoke(source_id)
            seen[source_id] = (digest, True)
            return True
        owner = active["owner"]
        if owner == "rich":
            final_text = item.get("text")
            if active["revoked"]:
                forward = False
            elif not isinstance(final_text, str):
                revoke(source_id)
                forward = False
            else:
                encoded = final_text.encode("utf-8")
                emit(
                    "end",
                    source_id,
                    thread_id,
                    turn_id,
                    item_id,
                    finalBytes=len(encoded),
                    finalDigest=hashlib.sha256(encoded).hexdigest(),
                )
                forward = False
        active = None
    else:
        turn = params.get("turn")
        status = turn.get("status") if isinstance(turn, dict) else None
        completed_turn_id = turn.get("id") if isinstance(turn, dict) else None
        if active and thread_id == active["thread"] and completed_turn_id == active["turn"]:
            if status in ("interrupted", "failed"):
                if active["owner"] == "rich" and not active["revoked"]:
                    emit(
                        "abort",
                        source_id,
                        active["thread"],
                        active["turn"],
                        active["item"],
                        reason=(
                            "turn-interrupted"
                            if status == "interrupted"
                            else "turn-failed"
                        ),
                    )
                active = None
            elif status == "completed":
                revoke(source_id)
                active = None
    seen[source_id] = (digest, forward)
    if len(seen) > 4096:
        seen.pop(next(iter(seen)))
    return forward

threading.Thread(target=control, daemon=True).start()
try:
    os.unlink(front_path)
except FileNotFoundError:
    pass
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(front_path)
os.chmod(front_path, 0o600)
listener.listen(1)
client, _ = listener.accept()
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.connect(back_path)
buffer = b""
passthrough = False
discarding_oversized = False
while True:
    readable, _, _ = select.select([client, server], [], [], 0.5)
    if client in readable:
        chunk = client.recv(65536)
        if not chunk:
            break
        server.sendall(chunk)
    if server in readable:
        chunk = server.recv(65536)
        if not chunk:
            break
        if discarding_oversized:
            if b"\n" in chunk:
                _, remainder = chunk.split(b"\n", 1)
                discarding_oversized = False
                passthrough = True
                if remainder:
                    client.sendall(remainder)
            continue
        if passthrough:
            client.sendall(chunk)
            continue
        buffer += chunk
        if len(buffer) > MAX_RECORD and b"\n" not in buffer:
            rich_active = active is not None and active["owner"] == "rich"
            revoke("oversized:" + str(order + 1))
            if rich_active:
                discarding_oversized = True
            else:
                client.sendall(buffer)
            buffer = b""
            passthrough = not rich_active
            continue
        while b"\n" in buffer:
            raw, buffer = buffer.split(b"\n", 1)
            if len(raw) > MAX_RECORD:
                rich_active = active is not None and active["owner"] == "rich"
                revoke("oversized:" + str(order + 1))
                if not rich_active:
                    client.sendall(raw + b"\n")
                passthrough = True
                if buffer:
                    client.sendall(buffer)
                    buffer = b""
                break
            if classify(raw):
                client.sendall(raw + b"\n")
if buffer:
    client.sendall(buffer)
`
