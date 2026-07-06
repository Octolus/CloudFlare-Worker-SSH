import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import { Server } from "ssh2";
import type { AuthContext, Connection } from "ssh2";
import { runCommand, runCommandStream } from "../src/ssh.js";
import type { SshCommandStreamEvent } from "../src/ssh.js";
import type { CloudflareSocketLike } from "../src/types.js";

/**
 * End-to-end test of the whole path — bridge + ssh2 client — against a REAL SSH
 * server, entirely on localhost. No Cloudflare account or network required.
 *
 * The trick: a Cloudflare socket is just `{ readable, writable }` Web Streams.
 * We open a normal TCP connection with `net`, convert it to Web Streams with
 * `Readable.toWeb` / `Writable.toWeb`, and hand that to `runCommand` exactly as
 * the Worker does. The bytes flowing through are a genuine SSH handshake,
 * password auth, and `exec` — so this exercises the identical code path that
 * runs in production.
 */

const USERNAME = "root";
const PASSWORD = "correct horse battery staple";

/** A minimal SSH server: password auth + a canned `exec` responder. */
function startTestSshServer(): Promise<{ port: number; close: () => Promise<void> }> {
  // A throwaway RSA host key generated per test run.
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const hostKey = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", (ctx: AuthContext) => {
      const ok =
        ctx.method === "password" &&
        ctx.username === USERNAME &&
        ctx.password === PASSWORD;
      if (ok) ctx.accept();
      else ctx.reject(["password"]);
    });

    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          const stream = acceptExec();
          if (info.command === "fail") {
            stream.stderr.write("boom\n");
            stream.exit(3);
            stream.end();
            return;
          }
          stream.write(`ran: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

/** Open a TCP connection and present it as a Cloudflare-style socket. */
async function connectAsCloudflareSocket(
  port: number,
): Promise<CloudflareSocketLike> {
  const sock = net.connect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  return {
    readable: Readable.toWeb(sock) as unknown as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(sock) as unknown as WritableStream<Uint8Array>,
  };
}

describe("runCommand (integration, real SSH server)", () => {
  let server: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    server = await startTestSshServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("authenticates with a password and captures command stdout", async () => {
    const socket = await connectAsCloudflareSocket(server.port);
    const result = await runCommand({
      socket,
      username: USERNAME,
      password: PASSWORD,
      command: "uname -a",
    });

    expect(result.stdout).toBe("ran: uname -a\n");
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("captures stderr and a non-zero exit code", async () => {
    const socket = await connectAsCloudflareSocket(server.port);
    const result = await runCommand({
      socket,
      username: USERNAME,
      password: PASSWORD,
      command: "fail",
    });

    expect(result.stderr).toBe("boom\n");
    expect(result.code).toBe(3);
  });

  it("rejects a wrong password", async () => {
    const socket = await connectAsCloudflareSocket(server.port);
    await expect(
      runCommand({
        socket,
        username: USERNAME,
        password: "wrong",
        command: "whoami",
      }),
    ).rejects.toThrow(/authentication|denied|failed/i);
  });

  it("streams stdout, stderr, and exit events as they arrive", async () => {
    const socket = await connectAsCloudflareSocket(server.port);
    const events: SshCommandStreamEvent[] = [];

    await runCommandStream(
      {
        socket,
        username: USERNAME,
        password: PASSWORD,
        command: "fail",
      },
      (event) => {
        events.push(event);
      },
    );

    expect(events).toEqual([
      { type: "stderr", data: "boom\n" },
      { type: "exit", code: 3, signal: null },
    ]);
  });
});
