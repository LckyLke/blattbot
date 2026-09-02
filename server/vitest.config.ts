import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Several suites boot the real server, run git, and drive a fake compile
    // engine. On the Windows CI runner a single compile or commit takes close
    // to a second, so a test doing five of each (compile-rev's eviction test)
    // cannot fit vitest's 5 s default. Hung tests still fail, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
