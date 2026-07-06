import { Duplex } from "node:stream";
import { Buffer } from "node:buffer";
import type { CloudflareSocketLike } from "./types.js";

/**
 * Adapts a Cloudflare Workers TCP socket (a pair of Web Streams) into a Node.js
 * `Duplex` stream.
 *
 * This is the single seam that lets an unmodified `ssh2` client run on Workers.
 * `ssh2` normally opens its own `net.Socket`, but `Client.connect()` accepts a
 * `sock` option: any `Duplex` to read from and write to instead. We give it one
 * of these, backed by `cloudflare:sockets`, and ssh2 never knows the difference.
 *
 * Responsibilities handled here, so the rest of the code doesn't have to:
 *   - Convert between Web Streams (`Uint8Array`) and Node streams (`Buffer`).
 *   - Respect backpressure in both directions rather than buffering without
 *     bound.
 *   - Propagate end-of-stream and errors so ssh2 sees a clean close or a real
 *     failure instead of hanging.
 */
export class CloudflareSocketDuplex extends Duplex {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;

  /**
   * When the readable side fills up, `push()` returns `false`. We then park the
   * read pump on this resolver and only resume once Node calls `_read()` again,
   * which is how backpressure is signalled upstream to the socket.
   */
  #resumeRead: (() => void) | null = null;

  constructor(socket: CloudflareSocketLike) {
    super();
    this.#reader = socket.readable.getReader();
    this.#writer = socket.writable.getWriter();
    // Start draining the socket immediately; `_read` will unpause us as needed.
    void this.#pumpReadable();
  }

  /**
   * Continuously read chunks from the Cloudflare socket and push them into the
   * Node stream, pausing whenever the consumer applies backpressure.
   */
  async #pumpReadable(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.#reader.read();
        if (done) {
          this.push(null); // Signal EOF to ssh2.
          return;
        }
        // `Buffer.from(value)` copies the bytes. That copy is deliberate: the
        // underlying ArrayBuffer may be reused by the runtime after `read()`
        // resolves, and Node consumers may hold onto the chunk.
        const hasCapacity = this.push(Buffer.from(value));
        if (!hasCapacity) {
          await new Promise<void>((resolve) => {
            this.#resumeRead = resolve;
          });
        }
      }
    } catch (err) {
      this.destroy(err as Error);
    }
  }

  override _read(): void {
    // The consumer wants more data. If the pump is parked on backpressure,
    // release it.
    const resume = this.#resumeRead;
    if (resume) {
      this.#resumeRead = null;
      resume();
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // ssh2 always writes Buffers. `new Uint8Array(chunk)` copies them into a
    // fresh, non-pooled buffer before handing them to the async writer, since
    // Node may recycle the source Buffer once this callback returns.
    this.#writer
      .write(new Uint8Array(chunk))
      .then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    // ssh2 has finished sending. Close our half of the socket gracefully.
    this.#writer.close().then(() => callback(), callback);
  }

  override _destroy(
    err: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    // Tear down both directions. Either side may already be closed, so ignore
    // teardown failures and surface the original error instead.
    void Promise.allSettled([
      this.#writer.abort(err ?? undefined),
      this.#reader.cancel(err ?? undefined),
    ]).then(() => callback(err));
  }
}
