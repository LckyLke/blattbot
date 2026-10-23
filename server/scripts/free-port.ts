/**
 * Browser verify scripts pick their ports at runtime instead of hard-coding
 * them, so two scripts (or a script and a running BlattBot) never collide.
 */
import { createServer, type AddressInfo } from "node:net";

/** A TCP port that was free on 127.0.0.1 a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
