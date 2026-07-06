import { Client } from "ssh2";
import type { Algorithms } from "ssh2";
import { CloudflareSocketDuplex } from "./socket-bridge.js";
import type { CloudflareSocketLike } from "./types.js";

/**
 * Algorithm set pinned to primitives that map cleanly onto the crypto available
 * in the Workers runtime (Web Crypto + the `nodejs_compat` polyfill).
 *
 * ssh2's *defaults* prefer `curve25519-sha256` and `chacha20-poly1305`, which
 * are exactly the two primitives most likely to be missing or awkward on
 * Workers. Pinning to NIST-P256 / group14 key exchange, AES-CTR, and
 * HMAC-SHA2 keeps every operation on well-supported code paths. Every modern
 * `sshd` accepts these, so interoperability is not a concern.
 */
export const WORKER_SAFE_ALGORITHMS: Algorithms = {
  kex: ["ecdh-sha2-nistp256", "diffie-hellman-group14-sha256"],
  cipher: ["aes256-ctr", "aes128-ctr"],
  // Host-key types whose SIGNATURE we can verify with the Workers crypto
  // polyfill. Ed25519 is deliberately omitted: the runtime cannot verify
  // ssh-ed25519 signatures ("Unsupported algorithm: ssh-ed25519"), the same
  // limitation that rules out curve25519 key exchange above. Every mainstream
  // sshd also ships an RSA or ECDSA host key, so this negotiates cleanly.
  serverHostKey: ["rsa-sha2-256", "rsa-sha2-512", "ecdsa-sha2-nistp256"],
  hmac: ["hmac-sha2-256", "hmac-sha2-512"],
};

export interface SshCommandOptions {
  /** A Cloudflare TCP socket already connected to the SSH server's port. */
  socket: CloudflareSocketLike;
  username: string;
  password: string;
  /** A single command to execute, e.g. `"uname -a"`. */
  command: string;
  /** Override the pinned algorithm set. Defaults to {@link WORKER_SAFE_ALGORITHMS}. */
  algorithms?: Algorithms;
  /** How long to wait for the SSH handshake before giving up. Defaults to 20s. */
  readyTimeoutMs?: number;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or `null` if the command was killed by a signal. */
  code: number | null;
  /** Signal name if the command was killed by one, otherwise `null`. */
  signal: string | null;
}

export type SshCommandStreamEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; signal: string | null };

/**
 * Open an SSH session over the given Cloudflare socket, authenticate with a
 * password, run a single command, and resolve with its captured output.
 *
 * The connection is always torn down before the promise settles, whether the
 * command succeeded, authentication failed, or the handshake errored.
 */
export function runCommand(options: SshCommandOptions): Promise<SshCommandResult> {
  const {
    socket,
    username,
    password,
    command,
    algorithms = WORKER_SAFE_ALGORITHMS,
    readyTimeoutMs = 20_000,
  } = options;

  return new Promise<SshCommandResult>((resolve, reject) => {
    const conn = new Client();
    const duplex = new CloudflareSocketDuplex(socket);

    // Guard against double-settling: ssh2 can emit `error` after we've already
    // resolved from a clean `close`, and vice versa.
    let settled = false;
    const succeed = (result: SshCommandResult): void => {
      if (settled) return;
      settled = true;
      conn.end();
      resolve(result);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            fail(err);
            return;
          }

          let stdout = "";
          let stderr = "";
          let code: number | null = null;
          let signal: string | null = null;

          stream
            .on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf8");
            })
            .on("exit", (exitCode: number | null, exitSignal?: string | null) => {
              code = exitCode ?? null;
              signal = exitSignal ?? null;
            })
            .on("close", () => {
              succeed({ stdout, stderr, code, signal });
            });

          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
        });
      })
      .on("error", fail)
      .connect({
        sock: duplex,
        username,
        password,
        algorithms,
        readyTimeout: readyTimeoutMs,
      });
  });
}

/**
 * Open an SSH session and emit stdout/stderr chunks as soon as ssh2 receives
 * them. This is the streaming sibling of {@link runCommand}: useful for long
 * commands such as package installs, migrations, or log tails where buffering
 * all output until process exit gives a poor user experience.
 *
 * The returned promise resolves after the SSH channel closes and all emitted
 * events have been handed to `onEvent`.
 */
export function runCommandStream(
  options: SshCommandOptions,
  onEvent: (event: SshCommandStreamEvent) => void | Promise<void>,
): Promise<void> {
  const {
    socket,
    username,
    password,
    command,
    algorithms = WORKER_SAFE_ALGORITHMS,
    readyTimeoutMs = 20_000,
  } = options;

  return new Promise<void>((resolve, reject) => {
    const conn = new Client();
    const duplex = new CloudflareSocketDuplex(socket);
    let settled = false;
    let eventQueue = Promise.resolve();

    const emit = (event: SshCommandStreamEvent): void => {
      eventQueue = eventQueue.then(() => onEvent(event));
      eventQueue.catch((err: unknown) => fail(asError(err)));
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      eventQueue
        .then(() => {
          conn.end();
          resolve();
        })
        .catch((err: unknown) => {
          conn.end();
          reject(asError(err));
        });
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(err);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            fail(err);
            return;
          }

          let code: number | null = null;
          let signal: string | null = null;

          stream
            .on("data", (chunk: Buffer) => {
              emit({ type: "stdout", data: chunk.toString("utf8") });
            })
            .on("exit", (exitCode: number | null, exitSignal?: string | null) => {
              code = exitCode ?? null;
              signal = exitSignal ?? null;
            })
            .on("close", () => {
              emit({ type: "exit", code, signal });
              succeed();
            });

          stream.stderr.on("data", (chunk: Buffer) => {
            emit({ type: "stderr", data: chunk.toString("utf8") });
          });
        });
      })
      .on("error", fail)
      .connect({
        sock: duplex,
        username,
        password,
        algorithms,
        readyTimeout: readyTimeoutMs,
      });
  });
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
