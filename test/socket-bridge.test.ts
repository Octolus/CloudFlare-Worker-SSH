import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { CloudflareSocketDuplex } from "../src/socket-bridge.js";
import type { CloudflareSocketLike } from "../src/types.js";

/**
 * Build a fake Cloudflare socket from a fixed list of inbound chunks plus a sink
 * that records everything written back out. This mirrors the `{ readable,
 * writable }` shape of a real `connect()` socket without needing the runtime.
 */
function fakeSocket(inbound: Uint8Array[]): {
  socket: CloudflareSocketLike;
  written: Uint8Array[];
  writableClosed: Promise<void>;
} {
  const written: Uint8Array[] = [];
  let resolveClosed!: () => void;
  const writableClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of inbound) controller.enqueue(chunk);
      controller.close();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      // Copy so later mutation of the source can't corrupt our record.
      written.push(chunk.slice());
    },
    close() {
      resolveClosed();
    },
  });

  return { socket: { readable, writable }, written, writableClosed };
}

/** Collect everything a Node Readable emits into a single Buffer. */
function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("CloudflareSocketDuplex", () => {
  it("forwards inbound socket data to the Node readable side", async () => {
    const { socket } = fakeSocket([
      new TextEncoder().encode("hello "),
      new TextEncoder().encode("world"),
    ]);

    const duplex = new CloudflareSocketDuplex(socket);
    const received = await collect(duplex);

    expect(received.toString("utf8")).toBe("hello world");
  });

  it("ends the Node readable when the socket reaches EOF", async () => {
    const { socket } = fakeSocket([]);
    const duplex = new CloudflareSocketDuplex(socket);

    const ended = new Promise<void>((resolve) => duplex.on("end", resolve));
    duplex.resume(); // Enter flowing mode so 'end' can fire.

    await expect(ended).resolves.toBeUndefined();
  });

  it("writes Node buffers out to the socket as Uint8Array chunks", async () => {
    const { socket, written } = fakeSocket([]);
    const duplex = new CloudflareSocketDuplex(socket);

    await new Promise<void>((resolve, reject) => {
      duplex.write(Buffer.from("ping"), (err) => (err ? reject(err) : resolve()));
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(written[0]).toString("utf8")).toBe("ping");
  });

  it("closes the socket writable when the Node duplex finishes", async () => {
    const { socket, writableClosed } = fakeSocket([]);
    const duplex = new CloudflareSocketDuplex(socket);

    duplex.end(Buffer.from("bye"));

    await expect(writableClosed).resolves.toBeUndefined();
  });

  it("surfaces a read-side error as a Node stream 'error' event", async () => {
    const boom = new Error("socket exploded");
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const writable = new WritableStream<Uint8Array>();

    const duplex = new CloudflareSocketDuplex({ readable, writable });

    const error = await new Promise<Error>((resolve) =>
      duplex.on("error", resolve),
    );
    expect(error.message).toBe("socket exploded");
  });
});
