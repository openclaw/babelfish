import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTarball } from "./package-archive.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const output = option("--out");
const existing = option("--tarball");
const directory = output ? path.resolve(output) : await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-pack-"));
await fs.mkdir(directory, { recursive: true });
try {
  let tarball = existing && path.resolve(existing);
  if (!tarball) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const stdout = execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      cwd: root, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 1024 * 1024,
    });
    const [pack] = JSON.parse(stdout);
    assert.equal(path.basename(pack.filename), pack.filename);
    tarball = path.join(directory, pack.filename);
  }
  const inspected = inspectTarball(await fs.readFile(tarball));
  execFileSync(process.execPath, [path.join(root, "scripts", "consumer-proof.mjs"), tarball], {
    cwd: os.tmpdir(), stdio: "inherit", timeout: 240_000,
  });
  const { size, sha256, sha512, integrity } = inspected;
  const manifest = { filename: path.basename(tarball), size, sha256, sha512, integrity };
  if (output) {
    assert.equal(path.dirname(tarball), directory, "retained tarball must live in output directory");
    await fs.writeFile(path.join(directory, "package-proof.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...manifest, files: inspected.files.size, consumer: "passed" }));
} finally {
  if (!output) await fs.rm(directory, { recursive: true, force: true });
}
