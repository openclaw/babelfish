import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-low-memory-"));
try {
  const windows = process.platform === "win32";
  const output = execFileSync(windows ? "npm.cmd" : "npm", [
    "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
  ], { cwd: root, encoding: "utf8", shell: windows });
  const [pack] = JSON.parse(output);
  execFileSync(process.execPath, [
    path.join(root, "scripts", "consumer-proof.mjs"), path.join(directory, pack.filename), "--runtime-only",
  ], { stdio: "inherit" });
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
