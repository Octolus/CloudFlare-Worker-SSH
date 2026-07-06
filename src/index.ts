/// <reference types="@cloudflare/workers-types" />
import { connect } from "cloudflare:sockets";
import { renderApp } from "./browser-ui.js";
import { runCommand, runCommandStream } from "./ssh.js";
import type { SshCommandStreamEvent } from "./ssh.js";
import type { CloudflareSocketLike } from "./types.js";

export interface Env {
  /**
   * Optional shared secret. When set, callers must send
   * `Authorization: Bearer <SSH_PROXY_TOKEN>`. Store it as a secret:
   *   wrangler secret put SSH_PROXY_TOKEN
   *
   * WARNING: without this (or some other gate such as an IP allowlist or
   * Cloudflare Access in front of the Worker) you are running an open SSH relay.
   * Anyone who can reach the Worker can attempt logins against arbitrary hosts.
   */
  SSH_PROXY_TOKEN?: string;
}

interface SshRequestBody {
  host: string;
  port?: number;
  username: string;
  password: string;
  command: string;
}

type StreamResponseEvent =
  | { type: "start" }
  | SshCommandStreamEvent
  | { type: "error"; error: string }
  | { type: "close" };

const DEFAULT_SSH_PORT = 22;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return html(renderApp());
    }

    if (request.method !== "POST") {
      return json({ error: "Use GET / for the browser UI, POST / for JSON, or POST /stream for NDJSON." }, 405);
    }

    if (url.pathname !== "/" && url.pathname !== "/stream") {
      return json({ error: "Not found." }, 404);
    }

    if (!isAuthorized(request, env)) {
      return json({ error: "Unauthorized." }, 401);
    }

    let body: SshRequestBody;
    try {
      body = (await request.json()) as SshRequestBody;
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }

    const validationError = validate(body);
    if (validationError) {
      return json({ error: validationError }, 400);
    }

    let socket: CloudflareSocketLike;
    try {
      socket = openSshSocket(body);
    } catch (err) {
      return json({ error: `Socket connection failed: ${errorMessage(err)}` }, 502);
    }

    if (url.pathname === "/stream") {
      return streamCommand(socket, body);
    }

    try {
      const result = await runCommand({
        socket,
        username: body.username,
        password: body.password,
        command: body.command,
      });
      return json(result, 200);
    } catch (err) {
      return json({ error: `SSH session failed: ${errorMessage(err)}` }, 502);
    }
  },
} satisfies ExportedHandler<Env>;

function openSshSocket(body: SshRequestBody): CloudflareSocketLike {
  // Open the raw TCP socket. `secureTransport: "off"` is important: SSH runs
  // its own transport-layer encryption over a plain socket, so wrapping it in
  // TLS would corrupt the SSH handshake. The socket must be created inside a
  // request handler, never in global scope.
  return connect(
    { hostname: body.host, port: body.port ?? DEFAULT_SSH_PORT },
    { secureTransport: "off", allowHalfOpen: false },
  );
}

function streamCommand(socket: CloudflareSocketLike, body: SshRequestBody): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let writerOpen = true;

  const writeEvent = async (event: StreamResponseEvent): Promise<void> => {
    if (!writerOpen) return;
    try {
      await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch (err) {
      writerOpen = false;
      throw err;
    }
  };

  void (async () => {
    try {
      await writeEvent({ type: "start" });
      await runCommandStream(
        {
          socket,
          username: body.username,
          password: body.password,
          command: body.command,
        },
        writeEvent,
      );
      await writeEvent({ type: "close" });
    } catch (err) {
      if (writerOpen) {
        await writeEvent({ type: "error", error: `SSH session failed: ${errorMessage(err)}` }).catch(
          () => undefined,
        );
      }
    } finally {
      if (writerOpen) {
        await writer.close().catch(() => undefined);
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Constant-time-ish bearer check. Returns true when no token is configured. */
function isAuthorized(request: Request, env: Env): boolean {
  if (!env.SSH_PROXY_TOKEN) return true; // No gate configured (see Env warning).
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.SSH_PROXY_TOKEN}`;
  return timingSafeEqual(header, expected);
}

function validate(body: SshRequestBody): string | null {
  if (typeof body !== "object" || body === null) return "Body must be an object.";
  if (!body.host) return "`host` is required.";
  if (!body.username) return "`username` is required.";
  if (typeof body.password !== "string") return "`password` is required.";
  if (!body.command) return "`command` is required.";
  if (body.port !== undefined && !Number.isInteger(body.port)) {
    return "`port` must be an integer.";
  }
  if (body.port !== undefined && (body.port < 1 || body.port > 65_535)) {
    return "`port` must be between 1 and 65535.";
  }
  return null;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(markup: string): Response {
  return new Response(markup, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Length-independent string comparison to avoid leaking the token via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
