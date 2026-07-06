import { defineConfig } from "vitest/config";

// The bridge and SSH wrapper are plain Node modules (they depend on `node:stream`
// and `ssh2`), so the tests run in a normal Node environment. The Worker entry
// (`src/index.ts`) imports `cloudflare:sockets`, which only exists inside the
// Workers runtime; it is therefore never imported by the test suite.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The integration test spins up a real SSH server and performs a full
    // handshake, which can take a moment on a cold machine.
    testTimeout: 30_000,
  },
});
