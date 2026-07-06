# Cloudflare Worker SSH

Run SSH commands from a Cloudflare Worker using Workers outbound TCP sockets
and the pure-JavaScript `ssh2` client.

This project is a sample base for developers who want to understand the
available shapes:

- buffered command execution over `POST /`
- streaming command execution over `POST /stream`
- a small browser UI over `GET /`
- a Cloudflare TCP socket to Node `Duplex` bridge for `ssh2`'s `sock` option

It is not a raw inbound SSH server. Workers can open outbound TCP sockets, but
they cannot accept inbound TCP SSH connections.

## What Works

- Password authentication.
- Single-command SSH `exec` sessions.
- Buffered JSON responses with stdout, stderr, exit code, and signal.
- Streaming NDJSON responses for live stdout/stderr chunks.
- Browser demo that remembers host, port, username, command, and mode in
  `localStorage`.
- Local unit tests for the Cloudflare socket bridge.
- Local integration tests against a real in-process SSH server.
- Wrangler dry-run bundle validation.

The browser demo deliberately does not save passwords or bearer tokens.

## Install

```sh
npm install
```

## Test

```sh
npm run typecheck
npm test
npm run check
```

`npm run check` runs TypeScript, Vitest, and `wrangler deploy --dry-run`.

## Local Worker

```sh
npm run dev
```

Open the browser demo:

```text
http://127.0.0.1:8787
```

## Buffered API

`POST /` waits for the SSH command to finish, then returns one JSON object.

```sh
curl -X POST http://127.0.0.1:8787 \
  -H "content-type: application/json" \
  -d '{
    "host": "ssh.example.com",
    "port": 22,
    "username": "root",
    "password": "secret",
    "command": "whoami && uname -a"
  }'
```

Response:

```json
{
  "stdout": "root\nLinux host 6.8.0 x86_64 GNU/Linux\n",
  "stderr": "",
  "code": 0,
  "signal": null
}
```

## Streaming API

`POST /stream` returns newline-delimited JSON (`application/x-ndjson`) while the
command is still running. Use this for long-running commands, installs, deploys,
or log tails.

```sh
curl -N -X POST http://127.0.0.1:8787/stream \
  -H "content-type: application/json" \
  -d '{
    "host": "ssh.example.com",
    "port": 22,
    "username": "root",
    "password": "secret",
    "command": "for i in 1 2 3; do echo tick-$i; sleep 1; done"
  }'
```

Example event stream:

```json
{"type":"start"}
{"type":"stdout","data":"tick-1\n"}
{"type":"stdout","data":"tick-2\n"}
{"type":"stdout","data":"tick-3\n"}
{"type":"exit","code":0,"signal":null}
{"type":"close"}
```

Errors inside the SSH session are emitted as:

```json
{"type":"error","error":"SSH session failed: ..."}
```

## Authentication Gate

Optionally require callers to pass `Authorization: Bearer <token>` by setting
`SSH_PROXY_TOKEN`.

For local development, copy `.dev.vars.example` to `.dev.vars`:

```sh
SSH_PROXY_TOKEN=change-me
```

For deployed Workers:

```sh
wrangler secret put SSH_PROXY_TOKEN
```

Then include:

```sh
-H "authorization: Bearer change-me"
```

## Runtime Notes

Cloudflare Workers TCP sockets are outbound only. The target SSH server must be
reachable from Cloudflare and cannot be a disallowed address such as localhost,
private IP space, Cloudflare IP ranges, or port 25.

`ssh2` normally tries algorithms that are awkward in Workers. This project pins
the SSH negotiation to Worker-safe primitives:

- KEX: `ecdh-sha2-nistp256`, `diffie-hellman-group14-sha256`
- Cipher: `aes256-ctr`, `aes128-ctr`
- MAC: `hmac-sha2-256`, `hmac-sha2-512`
- Host key: RSA SHA-2 or ECDSA P-256

The `patches/ssh2+1.17.0.patch` file disables `ssh2`'s eager
`chacha20-poly1305` WASM initialization. That cipher is intentionally not
negotiated here; if it is ever selected, the patched code throws a clear error.

## Security

Do not deploy this as an unauthenticated public endpoint. Without
`SSH_PROXY_TOKEN`, Cloudflare Access, an IP allowlist, or another gate, the
Worker acts as an SSH relay to any target the runtime allows.

Production hardening should include:

- host allowlisting
- command policy or allowlisting for automation use cases
- host key fingerprint pinning
- command timeouts
- output byte limits
- cancellation on client disconnect
- no request-body logging because request bodies contain SSH passwords

## What This Is Not

This is not a full interactive terminal yet. Interactive SSH needs a WebSocket
route, a PTY-backed `shell()` channel, and a browser terminal such as xterm.js:

```text
browser terminal <-> Worker WebSocket <-> ssh2 shell({ pty }) <-> SSH server
```
