import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./latex.js";

/** Compare actual project content, independently of pending diffs or Git HEAD. */
export async function projectFingerprint(dir: string): Promise<string> {
  const tree = createHash("sha256");
  for (const path of listFiles(dir)) {
    const file = createHash("sha256");
    for await (const chunk of createReadStream(join(dir, path))) file.update(chunk);
    tree.update(JSON.stringify(path)).update(file.digest());
  }
  return tree.digest("hex");
}
