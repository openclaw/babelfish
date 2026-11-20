import { registerTestHooks } from "../test/register-hooks.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("rejected session start", () => {
  it.each([
    ["session_end", "pending"], ["session_end", "consumed"],
    ["before_reset", "pending"], ["before_reset", "consumed"],
    ["session_end", "empty"], ["before_reset", "empty"],
  ])("does not let older %s cleanup erase a %s replacement", async (eventName, mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-start-owner-"));
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    vi.resetModules();
    const hermes = await import("./hermes-python.js");
    const bundles = await import("./bundle-plugins.js");
    let releaseEnd!: () => void;
    let releaseStart!: () => void;
    const endWait = new Promise<void>((resolve) => { releaseEnd = resolve; });
    const startWait = new Promise<void>((resolve) => { releaseStart = resolve; });
    let starts = 0;
    vi.spyOn(hermes, "invokeHermesHook").mockImplementation(async (_config, params) => {
      if (params.hook === "on_session_reset") await endWait;
      return { hook: params.hook, invoked: [], results: [] };
    });
    const release = vi.spyOn(hermes, "releaseHermesBridge").mockImplementation(() => {});
    vi.spyOn(hermes, "listHermesPlugins").mockResolvedValue({ installDir: root, plugins: [] });
    vi.spyOn(bundles, "listBundlePlugins").mockResolvedValue([]);
    vi.spyOn(bundles, "invokeBundleHooks").mockImplementation(async (_config, event) => {
      if (event === "SessionEnd") await endWait;
      if (event !== "SessionStart") return [];
      if (++starts === 1) return [{ systemMessage: "old context" }];
      await startWait;
      return mode === "empty" ? [] : [{ systemMessage: "replacement context" }];
    });
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    try {
      const entry = (await import("./index.js")).default;
      registerTestHooks(entry, hooks);
      const session = { sessionId: "replaced" };
      await hooks.get("session_start")!({}, session);
      const ending = hooks.get(eventName)!({}, session);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const replacement = hooks.get("session_start")!({}, session);
      if (mode === "consumed") {
        releaseStart();
        await replacement;
        await expect(hooks.get("agent_turn_prepare")!({}, session)).resolves.toEqual({ prependContext: "replacement context" });
      }
      releaseEnd();
      await ending;
      expect(release).not.toHaveBeenCalled();
      releaseStart();
      await replacement;
      await expect(hooks.get("agent_turn_prepare")!({}, session)).resolves.toEqual(
        mode === "pending" ? { prependContext: "replacement context" } : undefined,
      );
      await hooks.get("session_end")!({}, session);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      releaseEnd();
      releaseStart();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["replacement", "end"])("preserves callback ordering across session %s", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-start-lifecycle-"));
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    vi.resetModules();
    const hermes = await import("./hermes-python.js");
    const bundles = await import("./bundle-plugins.js");
    const calls: string[] = [];
    let releaseHook!: () => void;
    let releaseStart!: () => void;
    const waitHook = new Promise<void>((resolve) => { releaseHook = resolve; });
    const waitStart = new Promise<void>((resolve) => { releaseStart = resolve; });
    let holdStart = false;
    vi.spyOn(hermes, "invokeHermesHook").mockImplementation(async (_config, params) => {
      calls.push(params.hook);
      if (params.hook === "pre_llm_call") await waitHook;
      if (params.hook === "on_session_start" && holdStart) await waitStart;
      return { hook: params.hook, invoked: [], results: [] };
    });
    vi.spyOn(hermes, "listHermesPlugins").mockResolvedValue({ installDir: root, plugins: [] });
    vi.spyOn(bundles, "listBundlePlugins").mockResolvedValue([]);
    vi.spyOn(bundles, "invokeBundleHooks").mockImplementation(async (_config, event) => {
      if (event === "SessionStart" && mode === "end") await waitStart;
      return [];
    });
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    try {
      const entry = (await import("./index.js")).default;
      registerTestHooks(entry, hooks);
      const session = { sessionId: "lifecycle" };
      let start = hooks.get("session_start")!({}, session);
      if (mode === "replacement") await start;
      let settled = false;
      const prepare = Promise.resolve(hooks.get("agent_turn_prepare")!({}, session))
        .then((value) => { settled = true; return value; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "replacement") {
        holdStart = true;
        start = hooks.get("session_start")!({}, session);
      }
      releaseHook();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      if (mode === "end") await hooks.get("session_end")!({}, session);
      releaseStart();
      await start;
      await prepare;
      if (mode === "replacement") await hooks.get("session_end")!({}, session);
      expect(calls.filter((name) => name === "pre_llm_call")).toHaveLength(1);
      expect(calls.indexOf("pre_llm_call")).toBeLessThan(calls.indexOf("on_session_finalize"));
    } finally {
      releaseHook();
      releaseStart();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("initializes real Hermes state before a concurrent turn callback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-start-order-"));
    const plugin = path.join(root, "hermes", "stateful");
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const session = { sessionId: "stateful-start" };
    try {
      await fs.mkdir(plugin, { recursive: true });
      await fs.writeFile(path.join(plugin, "plugin.yaml"), "name: stateful\n");
      await fs.writeFile(path.join(plugin, "__init__.py"), [
        "state = 'uninitialized'",
        "def register(ctx):",
        "    def start(**kwargs):",
        "        global state",
        "        state = 'initialized'",
        "    ctx.register_hook('on_session_start', start)",
        "    ctx.register_hook('pre_llm_call', lambda **kwargs: {'context': state})",
        "",
      ].join("\n"));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      registerTestHooks(entry, hooks);
      const start = hooks.get("session_start")!({}, session);
      const prepare = hooks.get("agent_turn_prepare")!({}, session);
      await expect(prepare).resolves.toEqual({ prependContext: "initialized" });
      await start;
    } finally {
      await hooks.get("session_end")?.({}, session);
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps concurrent prepares waiting and does not remove a newer start", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-pending-start-"));
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    vi.resetModules();
    const hermes = await import("./hermes-python.js");
    const bundles = await import("./bundle-plugins.js");
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const waits = [
      new Promise<void>((resolve) => { releaseFirst = resolve; }),
      new Promise<void>((resolve) => { releaseSecond = resolve; }),
    ];
    let starts = 0;
    vi.spyOn(hermes, "invokeHermesHook").mockImplementation(async (_config, params) => {
      if (params.hook === "on_session_start") await waits[starts++];
      return { hook: params.hook, invoked: [], results: params.hook === "pre_llm_call" ? ["turn context"] : [] };
    });
    vi.spyOn(hermes, "listHermesPlugins").mockResolvedValue({ installDir: root, plugins: [] });
    vi.spyOn(bundles, "listBundlePlugins").mockResolvedValue([]);
    vi.spyOn(bundles, "invokeBundleHooks").mockImplementation(async (_config, event) =>
      event === "SessionStart" ? [{ systemMessage: "start context" }] : []);
    const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    try {
      const entry = (await import("./index.js")).default;
      entry.register({
        on: (name, handler) => { hooks.set(name, handler as (event: unknown, ctx: unknown) => Promise<unknown>); },
        registerTool: () => undefined, registerCommand: () => undefined,
        registerCli: () => undefined, registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      const session = { sessionId: "pending-session" };
      const firstStart = hooks.get("session_start")!({}, session);
      let settled = 0;
      const prepare = () => hooks.get("agent_turn_prepare")!({}, session).then((value) => {
        settled += 1;
        return value;
      });
      const firstPrepare = prepare();
      const secondPrepare = prepare();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(0);
      const secondStart = hooks.get("session_start")!({}, session);
      releaseFirst();
      await firstStart;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(0);
      releaseSecond();
      await secondStart;
      expect(await Promise.all([firstPrepare, secondPrepare])).toEqual([
        { prependContext: "start context\n\nturn context" },
        { prependContext: "turn context" },
      ]);
      await hooks.get("session_end")!({}, session);
    } finally {
      releaseFirst();
      releaseSecond();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not fail later turns after session_start times out", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-session-start-"));
    const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-bundles-"));
    const pluginDir = path.join(installDir, "slow-start");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.yaml"), "name: slow-start\n");
    await fs.writeFile(
      path.join(pluginDir, "__init__.py"),
      [
        "import time",
        "",
        "def register(ctx):",
        "    def on_session_start(**kwargs):",
        "        time.sleep(2)",
        "    ctx.register_hook('on_session_start', on_session_start)",
        "    ctx.register_hook('pre_llm_call', lambda **kwargs: {'context': 'after timeout'})",
        "",
      ].join("\n"),
    );
    const previousPluginDir = process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
    const previousRoot = process.env.OPENCLAW_BABELFISH_ROOT;
    const previousTimeout = process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS;
    const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const session = { sessionId: "slow-session" };
    try {
      process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = installDir;
      process.env.OPENCLAW_BABELFISH_ROOT = bundleRoot;
      process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS = "200";
      vi.resetModules();
      const module = await import("./index.js");
      const logger = { warn: vi.fn() };
      const api = {
        logger,
        on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          hooks.set(name, handler);
        }),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerCli: vi.fn(),
        registerAgentToolResultMiddleware: vi.fn(),
      };

      module.default.register(api);

      await expect(
        hooks.get("session_start")?.({ sessionId: "slow-session" }, session),
      ).rejects.toThrow(/adapter timed out/);

      const prepare = hooks.get("agent_turn_prepare");
      for (let turn = 0; turn < 3; turn += 1) {
        await expect(prepare?.({}, session)).resolves.toEqual({ prependContext: "after timeout" });
      }
      expect(logger.warn.mock.calls.filter(([message]) =>
        String(message).startsWith("Babelfish session start failed:"))).toHaveLength(1);
    } finally {
      await hooks.get("session_end")?.({ sessionId: "slow-session" }, session);
      if (previousPluginDir === undefined) {
        delete process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
      } else {
        process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = previousPluginDir;
      }
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_BABELFISH_ROOT;
      } else {
        process.env.OPENCLAW_BABELFISH_ROOT = previousRoot;
      }
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS = previousTimeout;
      }
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.rm(bundleRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
