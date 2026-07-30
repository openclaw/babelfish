import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-low-memory-e2e-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const stateRoot = path.join(tempRoot, "state");
const sourceRoot = path.join(tempRoot, "sources");
const runtimeEnv = {
  ...process.env,
  HOME: path.join(tempRoot, "home"),
  OPENCLAW_BABELFISH_ROOT: stateRoot,
  OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR: path.join(stateRoot, "hermes"),
  OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS: "15000",
};

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env ?? runtimeEnv,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function writeFiles(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

async function createGitSource(name, files) {
  const root = path.join(sourceRoot, name);
  await writeFiles(root, files);
  await run("git", ["init", "--quiet"], { cwd: root });
  await run("git", ["add", "."], { cwd: root });
  await run(
    "git",
    [
      "-c",
      "user.name=Babelfish Low Memory",
      "-c",
      "user.email=low-memory@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

async function runCli(args) {
  const { stdout } = await run(process.execPath, [path.join(runtimeRoot, "dist", "bin.js"), ...args]);
  return JSON.parse(stdout);
}

async function prepareRuntime() {
  await fs.mkdir(runtimeRoot, { recursive: true });
  for (const entry of ["assets", "dist", "python", "skills"]) {
    await fs.cp(path.join(packageRoot, entry), path.join(runtimeRoot, entry), { recursive: true });
  }
  for (const entry of ["openclaw.plugin.json", "package.json"]) {
    await fs.copyFile(path.join(packageRoot, entry), path.join(runtimeRoot, entry));
  }
  await fs.symlink(path.join(packageRoot, "node_modules"), path.join(runtimeRoot, "node_modules"), "junction");
  await fs.mkdir(runtimeEnv.HOME, { recursive: true });
}

async function prepareSources() {
  const hermes = path.join(sourceRoot, "hermes");
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.cp(path.join(packageRoot, "test", "fixtures", "simple-hermes-plugin"), hermes, {
    recursive: true,
  });
  await run("git", ["init", "--quiet"], { cwd: hermes });
  await run("git", ["add", "."], { cwd: hermes });
  await run(
    "git",
    [
      "-c",
      "user.name=Babelfish Low Memory",
      "-c",
      "user.email=low-memory@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: hermes },
  );

  const claude = await createGitSource("claude", {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "claude-low-memory",
      skills: "./skills",
      hooks: "./hooks/hooks.json",
    }),
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
      },
    }),
    "hook.mjs": "console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'ok'}}));\n",
    "skills/demo/SKILL.md": "---\nname: demo\ndescription: Claude fixture\n---\n\nDemo.\n",
  });

  const codex = await createGitSource("codex", {
    ".codex-plugin/plugin.json": JSON.stringify({
      name: "codex-low-memory",
      skills: "./skills",
    }),
    "skills/demo/SKILL.md": "---\nname: demo\ndescription: Codex fixture\n---\n\nDemo.\n",
  });

  return { hermes, claude, codex };
}

async function verifyMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(runtimeRoot, "dist", "bin.js"), "mcp"],
    env: runtimeEnv,
    stderr: "pipe",
  });
  const client = new Client({ name: "babelfish-low-memory-e2e", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (!names.includes("simple_echo")) {
      throw new Error(`MCP tool list did not include simple_echo: ${names.join(", ")}`);
    }
    const result = await client.callTool({
      name: "simple_echo",
      arguments: { value: "low-memory-ok" },
    });
    if (!JSON.stringify(result).includes("low-memory-ok")) {
      throw new Error("MCP simple_echo result was missing the expected value");
    }
    return names.length;
  } finally {
    await client.close();
  }
}

try {
  await prepareRuntime();
  const sources = await prepareSources();

  await runCli(["install", "hermes", sources.hermes, "--name", "hermes-low-memory"]);
  await runCli(["install", "claude-code", sources.claude, "--name", "claude-low-memory"]);
  await runCli(["install", "codex", sources.codex, "--name", "codex-low-memory"]);

  const installed = await runCli(["list"]);
  const counts = Object.fromEntries(
    installed.apps.map((entry) => [entry.app, entry.plugins.length]),
  );
  for (const app of ["hermes", "claude-code", "codex"]) {
    if (counts[app] !== 1) {
      throw new Error(`Expected one installed ${app} plugin, got ${counts[app] ?? 0}`);
    }
  }

  const registry = JSON.parse(
    await fs.readFile(path.join(runtimeRoot, "babelfish.generated.json"), "utf8"),
  );
  if (!registry.tools.some((tool) => tool.name === "simple_echo")) {
    throw new Error("Generated native tool registry did not include simple_echo");
  }

  const mcpTools = await verifyMcp();

  await runCli(["uninstall", "codex", "codex-low-memory"]);
  await runCli(["uninstall", "claude-code", "claude-low-memory"]);
  await runCli(["uninstall", "hermes", "hermes-low-memory"]);

  const empty = await runCli(["list"]);
  if (empty.apps.some((entry) => entry.plugins.length !== 0)) {
    throw new Error("Plugin state was not empty after uninstall");
  }

  console.log(JSON.stringify({ installed: counts, generatedTools: registry.tools.length, mcpTools }));
} finally {
  if (process.env.BABELFISH_KEEP_LOW_MEMORY_FIXTURE !== "1") {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } else {
    console.error(`low-memory fixture kept at ${tempRoot}`);
  }
}
