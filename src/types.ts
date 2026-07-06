/**
 * The minimal shape we need from a Cloudflare TCP socket.
 *
 * The real object returned by `connect()` from `cloudflare:sockets` has more on
 * it (`opened`, `closed`, `startTls()`, ...), but the bridge only ever touches
 * the two Web Streams. Declaring just those keeps the code testable: in the test
 * suite we hand the bridge a plain object with `readable`/`writable` streams
 * built from a real TCP connection, and it behaves identically to production.
 */
export interface CloudflareSocketLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}
