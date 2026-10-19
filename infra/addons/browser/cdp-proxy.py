#!/usr/bin/env python3
"""Tiny CDP forwarder for the Docker backend of the browser add-on (no third-party modules).

Chromium's DevTools HTTP endpoints refuse requests whose Host header is not an IP address or `localhost`
("Host header is specified and is not an IP address or localhost"). Inside the add-on container Chromium listens on
127.0.0.1:<port>; the orchestrator reaches the container by its name (http://aigentron-browser:9222), so this proxy

  * listens on the container network (0.0.0.0:9222),
  * forwards each connection to 127.0.0.1:<port> with the Host header rewritten to 127.0.0.1:<port>,
  * rewrites `ws://127.0.0.1:<port>/...` in JSON answers (/json, /json/version, /json/list) back to the name the client
    used, so webSocketDebuggerUrl stays usable,
  * passes WebSocket upgrades through as a raw byte stream.

Usage: cdp-proxy.py <listen-host> <listen-port> <target-host> <target-port>
Only ever reachable on the internal Docker network — the orchestrator proxies CDP behind its own login.
"""
import re
import select
import socket
import socketserver
import sys
import threading

LISTEN_HOST, LISTEN_PORT, TARGET_HOST, TARGET_PORT = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4])
TARGET_AUTHORITY = f"{TARGET_HOST}:{TARGET_PORT}".encode()


def read_head(sock):
    """Read an HTTP head (up to the blank line); returns (head, rest-of-buffer) or (None, b'') on EOF."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            return None, b""
        buf += chunk
        if len(buf) > 1 << 20:
            return None, b""
    head, rest = buf.split(b"\r\n\r\n", 1)
    return head, rest


def pipe(a, b):
    """Forward bytes both ways until either side closes."""
    socks = [a, b]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 300)
            if not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        head, rest = read_head(client)
        if head is None:
            return
        lines = head.split(b"\r\n")
        client_host = b""
        is_upgrade = False
        out = [lines[0]]
        for line in lines[1:]:
            name, _, value = line.partition(b":")
            lname = name.strip().lower()
            if lname == b"host":
                client_host = value.strip()
                out.append(b"Host: " + TARGET_AUTHORITY)
            elif lname == b"upgrade" and value.strip().lower() == b"websocket":
                is_upgrade = True
                out.append(line)
            elif lname == b"connection" and not is_upgrade and b"upgrade" not in value.lower():
                out.append(b"Connection: close")
            else:
                out.append(line)
        if not any(l.lower().startswith(b"connection:") for l in out) and not is_upgrade:
            out.append(b"Connection: close")
        upstream = socket.create_connection((TARGET_HOST, TARGET_PORT), timeout=30)
        try:
            upstream.sendall(b"\r\n".join(out) + b"\r\n\r\n" + rest)
            if is_upgrade:
                upstream.settimeout(None)
                client.settimeout(None)
                pipe(client, upstream)
                return
            # Plain HTTP (the /json family): read the answer (Content-Length, or until close), rewrite the loopback
            # authority back to what the client used. DevTools keeps the connection open, so never wait for EOF alone.
            rhead, rbody = read_head(upstream)
            if rhead is None:
                return
            m = re.search(rb"(?im)^Content-Length:\s*(\d+)\s*$", rhead)
            if m:
                want = int(m.group(1))
                while len(rbody) < want:
                    chunk = upstream.recv(65536)
                    if not chunk:
                        break
                    rbody += chunk
            else:
                while True:
                    chunk = upstream.recv(65536)
                    if not chunk:
                        break
                    rbody += chunk
            if client_host:
                rbody = rbody.replace(TARGET_AUTHORITY, client_host)
            rhead = re.sub(rb"(?im)^Content-Length:.*$", b"Content-Length: %d" % len(rbody), rhead)
            rhead = re.sub(rb"(?im)^Connection:.*$", b"Connection: close", rhead)
            client.sendall(rhead + b"\r\n\r\n" + rbody)
        except OSError:
            pass
        finally:
            upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server((LISTEN_HOST, LISTEN_PORT), Handler) as srv:
        print(f"[cdp-proxy] {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}", flush=True)
        srv.serve_forever()
