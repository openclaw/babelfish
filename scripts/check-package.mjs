import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedMetadata = {
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
};

for (const [field, expected] of Object.entries(expectedMetadata)) {
  if (packageJson[field] !== expected) {
    throw new Error(`package.json ${field} must be ${expected}`);
  }
}

if (packageJson.exports?.["."]?.import !== expectedMetadata.main) {
  throw new Error("package.json exports import must match main");
}
if (packageJson.exports?.["."]?.types !== expectedMetadata.types) {
  throw new Error("package.json exports types must match types");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const packOutput = JSON.parse(result.stdout);
const pack = Array.isArray(packOutput)
  ? packOutput[0]
  : packOutput[packageJson.name];
if (!pack || !Array.isArray(pack.files)) {
  throw new Error("npm pack returned an unsupported JSON shape");
}
const files = new Set(pack.files.map((file) => file.path));
const required = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/bin.js",
  "dist/index.d.ts",
  "dist/index.js",
  "openclaw.plugin.json",
];
const missing = required.filter((file) => !files.has(file));

if (missing.length > 0) {
  throw new Error(`Package is missing required files: ${missing.join(", ")}`);
}

// esbuild owns runtime JavaScript; TypeScript emits only the declarations.
const unexpected = [...files].filter((file) =>
  file.startsWith("dist/") && !file.endsWith(".d.ts") &&
  file !== "dist/index.js" && file !== "dist/bin.js",
);
if (unexpected.length > 0) {
  throw new Error(`Package contains unexpected build output: ${unexpected.join(", ")}`);
}

const entrypoint = await import(new URL(`../${packageJson.main}`, import.meta.url));
if (typeof entrypoint.default?.register !== "function") {
  throw new Error("Package entrypoint does not export the Babelfish plugin");
}

process.stdout.write(
  `Package contains ${pack.entryCount} files (${pack.unpackedSize} bytes unpacked).\n`,
);
