import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageName = "@openclaw/babelfish";
const script = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(script), "..");
const toolFixture = path.join(packageRoot, "test", "consumer-tools");

let phaseStart = performance.now();
function reportPhase(name) {
  const now = performance.now();
  console.error(`[package consumer] ${name}: ${Math.round(now - phaseStart)} ms`);
  phaseStart = now;
}

if (process.argv[2] !== "--worker") {
  const target = process.argv[2];
  const runtimeOnly = process.argv[3] === "--runtime-only";
  assert(target, "tarball or registry package required");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-consumer-")));
  const home = path.join(root, "home");
  await fs.mkdir(home);
  const gitTemplate = path.join(root, "empty-git-template");
  await fs.mkdir(gitTemplate);
  const config = path.join(root, "empty.npmrc");
  await fs.writeFile(config, "");
  const globalConfig = path.join(root, "empty-global.npmrc");
  await fs.writeFile(globalConfig, "");
  const offline = process.env.BABELFISH_CONSUMER_OFFLINE === "1";
  const defaultCache = offline ? process.env.npm_config_cache || path.join(os.homedir(), ".npm") : path.join(root, "cache");
  const env = Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR", "NODE_OPTIONS"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home,
    npm_config_userconfig: config, npm_config_globalconfig: globalConfig,
    npm_config_cache: process.env.BABELFISH_CONSUMER_CACHE || defaultCache, npm_config_registry: "https://registry.npmjs.org/",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: config, GIT_TEMPLATE_DIR: gitTemplate,
    OPENCLAW_BABELFISH_ROOT: path.join(root, "state"),
    OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR: path.join(root, "state", "hermes"),
    OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS: "15000",
  });
  if (offline) {
    env.npm_config_offline = "true";
  }
  const run = (command, args, cwd, timeout = 120_000) => execFileSync(command, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && command.endsWith(".cmd") });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let workerError;
  try {
    const tools = process.env.BABELFISH_CONSUMER_TOOLS || path.join(root, "tools");
    if (!runtimeOnly && !process.env.BABELFISH_CONSUMER_TOOLS) {
      await fs.mkdir(tools);
      for (const file of ["package.json", "package-lock.json"]) {
        await fs.copyFile(path.join(toolFixture, file), path.join(tools, file));
      }
      run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], tools);
      reportPhase("install type tools");
    }
    const consumer = path.join(root, "consumer");
    await fs.mkdir(consumer);
    await fs.writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
    run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", target.startsWith("@") ? target : path.resolve(target)], consumer);
    reportPhase("install package");
    // The worker runs the full lifecycle suite, not just one bounded command.
    run(process.execPath, [script, "--worker", consumer, ...(runtimeOnly ? [] : [path.resolve(tools)])], consumer, 360_000);
    reportPhase("run consumer lifecycle");
    if (process.env.BABELFISH_AUDIT_SIGNATURES === "1") {
      assert(target.startsWith("@"), "registry installation required for signature audit");
      const audit = JSON.parse(run(npm, ["audit", "signatures", "--json", "--include-attestations"], consumer));
      assert.equal(audit.invalid?.length, 0);
      assert.equal(audit.missing?.length, 0);
      assert(audit.verified?.some((entry) => entry.name === packageName && entry.version === "0.1.2"), "explicit Babelfish provenance verification");
      process.stdout.write(`${JSON.stringify(audit)}\n`);
    } else {
      console.log(JSON.stringify({ package: `${packageName}@0.1.2`, cli: "passed", runtime: "passed", mcp: "passed", declarations: runtimeOnly ? "skipped" : "passed", rollback: "passed", productionOnly: true, offline }));
    }
  } catch (error) {
    workerError = error;
  } finally {
    try {
      phaseStart = performance.now();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      reportPhase("cleanup");
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
  assert.equal((await json(path.join(installed, "package.json"))).version, "0.1.2");
  for (const dependency of ["typescript", "vitest", "esbuild", "@types/node"]) {
    assert(!dependencyLock.packages[`node_modules/${dependency}`], "no development toolchain in consumer");
  }
  const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, env: process.env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && command.endsWith(".cmd") });
  const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "babelfish.cmd" : "babelfish");
  const cli = (args) => JSON.parse(run(bin, args));
  // Put a copy outside the installed dependencies to catch eager SDK imports.
  const standalone = path.join(process.env.TMPDIR, "help-probe.mjs");
  await fs.copyFile(path.join(installed, "dist", "bin.js"), standalone);
  assert.match(run(process.execPath, [standalone, "--help"]), /install.*<app>/s);
  assert.match(run(bin, ["--help"]), /install.*<app>/s);
  reportPhase("installed CLI entry points");
  const write = async (root, relative, contents) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), contents);
  };
  const commitArgs = [
    "-c", "user.name=Package Consumer", "-c", "user.email=consumer@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture",
  ];
  const initFixture = (root) => {
    run("git", ["init", "--quiet"], root);
    run("git", ["add", "."], root);
    run("git", commitArgs, root);
  };
  const sources = path.join(consumer, "sources");
  const hermes = path.join(sources, "hermes");
  await fs.cp(path.join(packageRoot, "test", "fixtures", "simple-hermes-plugin"), hermes, { recursive: true });
  initFixture(hermes);
  for (const app of ["claude-code", "codex"]) {
    const source = path.join(sources, app);
    const manifest = app === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
    await write(source, manifest, JSON.stringify({ name: `${app}-consumer`, skills: "./skills" }));
    await write(source, "skills/demo/SKILL.md", `---\nname: demo\ndescription: ${app} consumer fixture\n---\n\nconsumer skill.\n`);
    initFixture(source);
  }
  reportPhase("prepare Git fixtures");
  const names = { hermes: "hermes-consumer", "claude-code": "claude-consumer", codex: "codex-consumer" };
  for (const app of Object.keys(names)) {
    cli(["install", app, path.join(sources, app), "--name", names[app]]);
    reportPhase(`install ${app} fixture`);
  }
  const list = (expectedCount = 1) => {
    const result = cli(["list"]);
    for (const app of Object.keys(names)) {
      const entry = result.apps.find((entry) => entry.app === app);
      assert.equal(entry?.plugins.length, expectedCount, `installed plugin count for ${app}`);
    }
    return result;
  };
  list();
  const registry = await json(path.join(installed, "babelfish.generated.json"));
  const manifest = await json(path.join(installed, "openclaw.plugin.json"));
  assert(registry.tools.some((tool) => tool.name === "simple_echo"));
  assert(manifest.contracts.tools.includes("simple_echo"));
  for (const app of ["claude-code", "codex"]) {
    const skill = path.join(installed, "skills", "babelfish-bundles", `${app}-${names[app]}-demo`, "SKILL.md");
    assert((await fs.readFile(skill, "utf8")).includes(`${app} consumer fixture`));
  }
  reportPhase("list and generated files");
  const sdk = async (specifier) => {
    const resolved = requireInstalled.resolve(`@modelcontextprotocol/sdk/${specifier}`);
    assert(resolved.startsWith(path.join(consumer, "node_modules") + path.sep));
    return import(pathToFileURL(resolved).href);
  };
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");
  const withMcp = async (verify) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(installed, "dist", "bin.js"), "mcp"], env: process.env, stderr: "pipe" });
    const client = new Client({ name: "package-consumer", version: "1" });
    try {
      await client.connect(transport);
      await verify(client);
    } finally {
      await client.close();
    }
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
    assert(!result.isError, JSON.stringify(result.content));
    return JSON.parse(result.content[0].text);
  };
  const echo = async (client) => {
    assert.deepEqual(await call(client, "simple_echo", { value: "immutable-consumer-ok" }), { echo: "immutable-consumer-ok" });
  };
  await withMcp(async (client) => {
    assert.deepEqual(client.getServerVersion(), { name: "babelfish", version: "0.1.2" });
    const { tools } = await client.listTools();
    const command = "babelfish_command__hermes__hermes-consumer__simple";
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      command, "babelfish_plugins_list", "babelfish_task_start", "babelfish_task_status",
      "babelfish_task_stop", "simple_echo", "simple_optional", "simple_state",
    ].sort());
    assert.match(tools.find((tool) => tool.name === command).description, /Args: <raw text>/);
    for (const args of [undefined, {}, { args: "" }, { args: "explicit text" }]) {
      assert.deepEqual(await call(client, command, args), { command: args?.args ?? "" });
    }
    await echo(client);
    for (const [args, expected] of [
      [{ kind: "command", plugin: names.hermes, name: "simple" }, { command: "simple", result: { command: "" } }],
      [{ kind: "tool", name: "simple_echo", args: { value: "task-ok" } }, { tool: "simple_echo", parsedResult: { echo: "task-ok" } }],
    ]) {
      const task = await call(client, "babelfish_task_start", args);
      assert.equal(task.status, "running");
      const deadline = Date.now() + 15_000;
      let status;
      do {
        status = await call(client, "babelfish_task_status", { id: task.id });
        if (status.status !== "running") break;
        assert(Date.now() < deadline, `Timed out waiting for ${args.name}`);
        await delay(50);
      } while (true);
      assert.equal(status.status, "completed", status.error);
      assert.partialDeepStrictEqual(status.result, { plugin: names.hermes, ...expected });
    }
  });
  await write(consumer, "runtime-import.mjs", `export { default } from "${packageName}";\n`);
  const plugin = (await import(pathToFileURL(path.join(consumer, "runtime-import.mjs")).href)).default;
  assert.equal(plugin.id, "babelfish");
  const cliRoots = [];
  plugin.register({
    registrationMode: "cli-metadata",
    registerCli: (_register, options) => cliRoots.push(...options.commands),
    get runtime() { throw new Error("Runtime unavailable during CLI metadata discovery"); },
  });
  assert.deepEqual(cliRoots.sort(), ["babelfish", "simplecli"]);
  const hooks = new Map();
  const commands = [];
  let factory;
  plugin.register({
    on: (name, handler) => hooks.set(name, handler),
    registerTool: (handler) => { factory = handler; },
    registerCommand: (command) => commands.push(command),
    registerCli: () => {}, registerAgentToolResultMiddleware: () => {}, logger: { warn: () => {} },
  });
  assert(commands.some((command) => command.name === "simple"));
  const context = { sessionKey: "consumer-session", sessionId: "consumer-session", workspaceDir: consumer };
  try {
    await hooks.get("session_start")({ sessionId: "consumer-session", value: "consumer-start" }, context);
    const tools = factory(context);
    for (const [name, args, expected] of [
      ["simple_echo", { value: "native-consumer-ok" }, { echo: "native-consumer-ok" }],
      ["simple_state", {}, { state: "consumer-start" }],
    ]) {
      const tool = tools.find((entry) => entry.name === name);
      assert(tool, name);
      const { content, details } = await tool.execute("consumer-call", args);
      assert.equal(content[0].type, "text");
      assert.deepEqual(JSON.parse(content[0].text), expected);
      assert.deepEqual(details, expected);
    }
  } finally {
    await hooks.get("session_end")({ sessionId: "consumer-session" }, context);
  }
  reportPhase("MCP and plugin runtime");
  if (tools) {
    const { dependencies } = await json(path.join(toolFixture, "package.json"));
    for (const [name, version] of Object.entries(dependencies)) {
      assert.equal((await json(path.join(tools, "node_modules", name, "package.json"))).version, version, "separate pinned type toolchain");
    }
    await write(consumer, "probe.mts", 'import plugin, { registerNativeTools } from "@openclaw/babelfish";\nconst registration: typeof plugin.register = plugin.register;\nvoid registration; void registerNativeTools;\n');
    await write(consumer, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], typeRoots: [path.join(tools, "node_modules", "@types")] }, files: ["probe.mts"] }));
    const compiler = path.join(tools, "node_modules", "typescript", "bin", "tsc");
    run(process.execPath, [compiler, "-p", path.join(consumer, "tsconfig.json")]);
    reportPhase("check declarations");
  }
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
  run("git", [...commitArgs, "--", "skills/simple.md"], hermes);
  let failure;
  try { cli(["install", "hermes", hermes, "--name", names.hermes, "--force"]); } catch (error) { failure = error; }
  assert(failure && failure.status !== 0);
  assert.match(String(failure.stderr), /utf-8|UnicodeDecodeError/i, "actual late skill regeneration failure");
  for (const extra of ["--dry-run", "second-plugin"]) {
    assert.throws(() => cli(["uninstall", "hermes", names.hermes, extra]), {
      status: 1,
      stderr: new RegExp(`Unexpected uninstall argument: ${extra}`),
    });
  }
  assert.deepEqual(await snapshot(path.join(state, "hermes", names.hermes)), oldInstall);
  assert.deepEqual(await snapshot(path.join(installed, "skills")), oldSkills);
  assert.deepEqual(await fs.readFile(path.join(installed, "babelfish.generated.json")), oldRegistry);
  assert.deepEqual(await fs.readFile(path.join(installed, "openclaw.plugin.json")), oldManifest);
  assert(!(await fs.readdir(path.join(state, "hermes"))).some((name) => name.startsWith(".babelfish")));
  assert(!(await fs.readdir(installed)).some((name) => name.startsWith(".babelfish")));
  list();
  await withMcp(echo);
  for (const app of Object.keys(names)) cli(["uninstall", app, names[app]]);
  list(0);
  reportPhase("rollback and uninstall");
}
