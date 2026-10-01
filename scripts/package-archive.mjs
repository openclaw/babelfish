import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const PACKAGE_NAME = "@openclaw/babelfish";
export const PACKAGE_VERSION = "0.1.1";
export const REPOSITORY = "https://github.com/openclaw/babelfish";

export function inspectTarball(bytes) {
  assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, "bounded compressed archive");
  const archive = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const files = new Map();
  const names = new Set();
  let offset = 0;
  let ended = false;
  const text = (buffer) => buffer.toString("utf8").replace(/\0.*$/s, "");
  const octal = (buffer) => {
    const value = text(buffer).trim();
    assert(/^[0-7]+$/.test(value), "octal TAR field");
    return Number.parseInt(value, 8);
  };
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      assert(archive.length - offset >= 1024 && archive.subarray(offset).every((byte) => byte === 0), "TAR end markers");
      ended = true;
      break;
    }
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assert.equal(octal(header.subarray(148, 156)), checksum, "TAR checksum");
    const prefix = text(header.subarray(345, 500));
    const name = `${prefix ? `${prefix}/` : ""}${text(header.subarray(0, 100))}`;
    const type = String.fromCharCode(header[156]);
    assert(type === "0" || type === "\0" || type === "5", "no links or extended TAR records");
    assert(/^package\/[A-Za-z0-9_./@-]+$/.test(name), "safe package path");
    const segments = name.replace(/\/$/, "").split("/");
    assert(segments.every((segment) => segment && segment !== "." && segment !== ".."), "no path traversal");
    assert(!names.has(name) && names.size < 200, "bounded unique entries");
    names.add(name);
    const size = octal(header.subarray(124, 136));
    assert(size <= 4 * 1024 * 1024 && offset + 512 + size <= archive.length, "bounded complete TAR entry");
    if (type === "5") assert.equal(size, 0);
    else files.set(name.slice(8), archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert(ended, "complete TAR archive");
  for (const required of ["package.json", "LICENSE", "README.md", "CHANGELOG.md", "docs/compatibility.md", "dist/index.js", "dist/index.d.ts", "dist/bin.js", "openclaw.plugin.json", "python/hermes_openclaw_bridge.py"]) {
    assert(files.has(required), `required package file: ${required}`);
  }
  for (const name of files.keys()) {
    assert(!/(^|\/)(node_modules|\.git|test|src)(\/|$)/.test(name), "no development tree");
    if (name.startsWith("dist/")) assert(name.endsWith(".d.ts") || ["dist/index.js", "dist/bin.js"].includes(name), "bundled runtime only");
  }
  const pkg = JSON.parse(files.get("package.json").toString("utf8"));
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, PACKAGE_VERSION);
  assert.equal(pkg.repository?.url, `git+${REPOSITORY}.git`);
  assert.equal(pkg.main, "./dist/index.js");
  assert.equal(pkg.types, "./dist/index.d.ts");
  assert.deepEqual(pkg.exports, { ".": { types: pkg.types, import: pkg.main } });
  assert.deepEqual(pkg.bin, { babelfish: "dist/bin.js" });
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  assert.equal(pkg.type, "module");
  return {
    pkg, files,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
