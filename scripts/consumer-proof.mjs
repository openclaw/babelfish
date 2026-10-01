import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "@openclaw/babelfish";
const compilerVersion = "7.0.2";
const nodeTypesVersion = "26.6.3";
const script = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(script), "..");

function stopProcessesIn(root) {
  if (process.platform !== "win32") return;
  const literal = root.replaceAll("'", "''");
  const command = [
    `$root = '${literal}'`,
    "Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($root)",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    timeout: 20_000,
    stdio: "ignore",
    windowsHide: true,
  });
}

async function removeConsumerTree(root) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = error && error.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      stopProcessesIn(root);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

if (process.argv[2] !== "--worker") {
  const target = process.argv[2];
  assert(target, "tarball or registry package required");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-consumer-")));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const config = path.join(root, "empty.npmrc");
  await fs.writeFile(config, "");
  const globalConfig = path.join(root, "empty-global.npmrc");
  await fs.writeFile(globalConfig, "");
  const env = Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "NODE_OPTIONS"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
    npm_config_userconfig: config, npm_config_globalconfig: globalConfig,
    npm_config_cache: process.env.BABELFISH_CONSUMER_CACHE || path.join(root, "cache"), npm_config_registry: "https://registry.npmjs.org/",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config,
    OPENCLAW_BABELFISH_ROOT: path.join(root, "state"),
    OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR: path.join(root, "state", "hermes"),
    OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS: "15000",
  });
  const offline = process.env.BABELFISH_CONSUMER_OFFLINE === "1";
  if (offline) {
    env.npm_config_offline = "true";
    env.npm_config_cache = process.env.npm_config_cache || path.join(os.homedir(), ".npm");
  }
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && command.endsWith(".cmd") });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let workerError;
  try {
    const tools = process.env.BABELFISH_CONSUMER_TOOLS || path.join(root, "tools");
    if (!process.env.BABELFISH_CONSUMER_TOOLS) {
      await fs.mkdir(tools);
      await fs.writeFile(path.join(tools, "package.json"), '{"private":true}\n');
      run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `typescript@${compilerVersion}`, `@types/node@${nodeTypesVersion}`], tools);
    }
    const consumer = path.join(root, "consumer");
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", target.startsWith("@") ? target : path.resolve(target)], consumer);
    run(process.execPath, [script, "--worker", consumer, path.resolve(tools)], consumer);
    if (process.env.BABELFISH_AUDIT_SIGNATURES === "1") {
      assert(target.startsWith("@"), "registry installation required for signature audit");
      const audit = JSON.parse(run(npm, ["audit", "signatures", "--json", "--include-attestations"], consumer));
      assert.equal(audit.invalid?.length, 0);
      assert.equal(audit.missing?.length, 0);
      assert(audit.verified?.some((entry) => entry.name === packageName && entry.version === "0.1.1"), "explicit Babelfish provenance verification");
      process.stdout.write(`${JSON.stringify(audit)}\n`);
    } else {
      console.log(JSON.stringify({ package: `${packageName}@0.1.1`, cli: "passed", runtime: "passed", mcp: "passed", declarations: "passed", rollback: "passed", productionOnly: true, offline }));
    }
  } catch (error) {
    workerError = error;
  } finally {
    try {
      await removeConsumerTree(root);
    } catch (error) {
      if (!workerError) workerError = error;
    }
  }
  if (workerError) throw workerError;
} else {
  const [consumer, tools] = process.argv.slice(3);
  const installed = path.join(consumer, "node_modules", "@openclaw", "babelfish");
  const state = process.env.OPENCLAW_BABELFISH_ROOT;
  const requireInstalled = createRequire(path.join(installed, "package.json"));
  const json = async (filename) => JSON.parse(await fs.readFile(filename, "utf8"));
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
  const dependencyLock = await json(path.join(consumer, "package-lock.json"));
  assert(Object.values(dependencyLock.packages).every((entry) => !entry.dev), "production-only installation");
  assert.equal((await json(path.join(installed, "package.json"))).version, "0.1.1");
  for (const dependency of ["typescript", "vitest", "esbuild", "@types/node"]) {
    assert(!dependencyLock.packages[`node_modules/${dependency}`], "no development toolchain in consumer");
  }
  const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, env: process.env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && command.endsWith(".cmd") });
  const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "babelfish.cmd" : "babelfish");
  const cli = (args) => JSON.parse(run(bin, args));
  assert.match(run(bin, ["--help"]), /install.*<app>/s);
  const write = async (root, relative, contents) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), contents);
  };
  const commit = (root) => {
    run("git", ["init", "--quiet"], root);
    run("git", ["add", "."], root);
    run("git", ["-c", "user.name=Package Consumer", "-c", "user.email=consumer@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], root);
  };
  const sources = path.join(consumer, "sources");
  const hermes = path.join(sources, "hermes");
  await fs.cp(path.join(packageRoot, "test", "fixtures", "simple-hermes-plugin"), hermes, { recursive: true });
  commit(hermes);
  for (const app of ["claude-code", "codex"]) {
    const source = path.join(sources, app);
    const manifest = app === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
    await write(source, manifest, JSON.stringify({ name: `${app}-consumer`, skills: "./skills" }));
    await write(source, "skills/demo/SKILL.md", `---\nname: demo\ndescription: ${app} consumer fixture\n---\n\nconsumer skill.\n`);
    commit(source);
  }
  const names = { hermes: "hermes-consumer", "claude-code": "claude-consumer", codex: "codex-consumer" };
  for (const app of Object.keys(names)) cli(["install", app, path.join(sources, app), "--name", names[app]]);
  const list = () => {
    const result = cli(["list"]);
    for (const app of Object.keys(names)) assert.equal(result.apps.find((entry) => entry.app === app)?.plugins.length, 1);
    return result;
  };
  list();
  const registry = await json(path.join(installed, "babelfish.generated.json"));
  const manifest = await json(path.join(installed, "openclaw.plugin.json"));
  assert(registry.tools.some((tool) => tool.name === "simple_echo"));
  assert(manifest.contracts.tools.includes("simple_echo"));
  assert(registry.skillDirs.length >= 2);
  const sdk = async (specifier) => {
    const resolved = requireInstalled.resolve(`@modelcontextprotocol/sdk/${specifier}`);
    assert(resolved.startsWith(path.join(consumer, "node_modules") + path.sep));
    return import(pathToFileURL(resolved).href);
  };
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const echo = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(installed, "dist", "bin.js"), "mcp"], env: process.env, stderr: "pipe" });
    const client = new Client({ name: "package-consumer", version: "1" });
    try {
      await client.connect(transport);
      assert.deepEqual(client.getServerVersion(), { name: "babelfish", version: "0.1.1" });
      assert((await client.listTools()).tools.some((tool) => tool.name === "simple_echo"));
      const result = await client.callTool({ name: "simple_echo", arguments: { value: "immutable-consumer-ok" } });
      assert(!result.isError && JSON.stringify(result).includes("immutable-consumer-ok"));
    } finally {
      await client.close();
    }
  };
  await echo();
  await write(consumer, "runtime-import.mjs", `export { default } from "${packageName}";\n`);
  const plugin = (await import(pathToFileURL(path.join(consumer, "runtime-import.mjs")).href)).default;
  assert.equal(plugin.id, "babelfish");
  const hooks = new Map();
  const commands = [];
  let factory;
  plugin.register({
    pluginConfig: { rootDir: state, installDir: path.join(state, "hermes"), python: "python3", timeoutMs: 15_000 },
    on: (name, handler) => hooks.set(name, handler),
    registerTool: (handler) => { factory = handler; },
    registerCommand: (command) => commands.push(command),
    registerCli: () => {}, registerAgentToolResultMiddleware: () => {}, logger: { warn: () => {} },
  });
  assert(commands.some((command) => command.name === "simple"));
  const context = { sessionKey: "consumer-session", sessionId: "consumer-session", workspaceDir: consumer };
  try {
    await hooks.get("session_start")({ sessionId: "consumer-session", value: "consumer-start" }, context);
    const native = factory(context).find((tool) => tool.name === "simple_echo");
    assert(native);
    assert(JSON.stringify(await native.execute("consumer-call", { value: "native-consumer-ok" })).includes("native-consumer-ok"));
    const stateTool = factory(context).find((tool) => tool.name === "simple_state");
    assert(JSON.stringify(await stateTool.execute("consumer-state", {})).includes("consumer-start"));
  } finally {
    await hooks.get("session_end")({ sessionId: "consumer-session" }, context);
  }
  for (const [name, version] of [["typescript", compilerVersion], ["@types/node", nodeTypesVersion]]) {
    assert.equal((await json(path.join(tools, "node_modules", name, "package.json"))).version, version, "separate pinned type toolchain");
  }
  await write(consumer, "probe.mts", 'import plugin, { registerNativeTools } from "@openclaw/babelfish";\nconst registration: typeof plugin.register = plugin.register;\nvoid registration; void registerNativeTools;\n');
  await write(consumer, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [path.join(tools, "node_modules", "@types")] }, files: ["probe.mts"] }));
  const compiler = path.join(tools, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [compiler, "-p", path.join(consumer, "tsconfig.json"), "--traceResolution"]);
  const snapshot = async (root) => {
    const entries = {};
    const walk = async (relative) => {
      for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
        const next = path.join(relative, entry.name);
        if (entry.isDirectory()) await walk(next);
        else {
          assert(entry.isFile(), "regular fixture bytes");
          entries[next] = createHash("sha256").update(await fs.readFile(path.join(root, next))).digest("hex");
        }
      }
    };
    await walk("");
    return entries;
  };
  const oldInstall = await snapshot(path.join(state, "hermes", names.hermes));
  const oldSkills = await snapshot(path.join(installed, "skills"));
  const oldRegistry = await fs.readFile(path.join(installed, "babelfish.generated.json"));
  const oldManifest = await fs.readFile(path.join(installed, "openclaw.plugin.json"));
  await write(hermes, "skills/simple.md", Buffer.from([0xff, 0xfe, 0xfd]));
  commit(hermes);
  let failure;
  try { cli(["install", "hermes", hermes, "--name", names.hermes, "--force"]); } catch (error) { failure = error; }
  assert(failure && failure.status !== 0);
  assert.match(String(failure.stderr), /utf-8|UnicodeDecodeError/i, "actual late skill regeneration failure");
  assert.deepEqual(await snapshot(path.join(state, "hermes", names.hermes)), oldInstall);
  assert.deepEqual(await snapshot(path.join(installed, "skills")), oldSkills);
  assert.deepEqual(await fs.readFile(path.join(installed, "babelfish.generated.json")), oldRegistry);
  assert.deepEqual(await fs.readFile(path.join(installed, "openclaw.plugin.json")), oldManifest);
  assert(!(await fs.readdir(path.join(state, "hermes"))).some((name) => name.startsWith(".babelfish")));
  assert(!(await fs.readdir(installed)).some((name) => name.startsWith(".babelfish")));
  list();
  await echo();
  for (const app of Object.keys(names)) cli(["uninstall", app, names[app]]);
  assert(cli(["list"]).apps.every((entry) => entry.plugins.length === 0));
}
