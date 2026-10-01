import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_HOOK_OUTPUT_BYTES } from "./bundle-plugins.js";

async function removeTemp(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function copyFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
  await fs.cp(fixture, path.join(target, "simple"), { recursive: true });
}

describe("native OpenClaw hook entry", () => {
  it("keeps imported guards active when Hermes is empty and Python is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-no-hermes-"));
    const plugin = path.join(root, "codex", "guard");
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PYTHON", path.join(root, "missing-python"));
    try {
      await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
      await fs.writeFile(path.join(plugin, "guard.mjs"),
        'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({decision:"block",reason:"imported guard"})));');
      await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [process.execPath, "guard.mjs"] }] }] },
      }));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      entry.register({
        on: (name, handler) => { hooks.set(name, handler); },
        registerTool: () => undefined, registerCommand: () => undefined,
        registerCli: () => undefined, registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      await expect(hooks.get("before_tool_call")!({ toolName: "fixture", params: {} }, { sessionId: "guard" }))
        .resolves.toEqual({ block: true, blockReason: "imported guard" });
    } finally {
      vi.unstubAllEnvs();
      await removeTemp(root);
    }
  });

  it("consumes session-start context once and clears it on session end after reset", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-start-context-"));
    const plugin = path.join(root, "codex", "start");
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    try {
      await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
      await fs.writeFile(path.join(plugin, "start.mjs"),
        'process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({systemMessage:"start context"})));');
      await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: [process.execPath, "start.mjs"] }] }] },
      }));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      entry.register({
        on: (name, handler) => { hooks.set(name, handler); },
        registerTool: () => undefined, registerCommand: () => undefined,
        registerCli: () => undefined, registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      const first = { sessionId: "first" };
      const second = { sessionId: "second" };
      await hooks.get("session_start")!({}, first);
      await hooks.get("session_start")!({}, second);
      await expect(hooks.get("agent_turn_prepare")!({}, first)).resolves.toEqual({ prependContext: "start context" });
      await expect(hooks.get("agent_turn_prepare")!({}, first)).resolves.toBeUndefined();
      await hooks.get("before_reset")!({}, second);
      await hooks.get("session_end")!({ reason: "reset" }, second);
      await expect(hooks.get("agent_turn_prepare")!({}, second)).resolves.toBeUndefined();
      await hooks.get("session_end")!({}, first);
    } finally {
      vi.unstubAllEnvs();
      await removeTemp(root);
    }
  }, 15_000);

  it.each([
    ["PreToolUse", "before_tool_call", { block: true }],
    ["UserPromptSubmit", "before_agent_run", { outcome: "block" }],
    ["Stop", "before_agent_finalize", { action: "revise" }],
  ] as const)("blocks failed %s expansion through the registered handler", async (eventName, handlerName, expected) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-failed-guard-"));
    const plugin = path.join(root, "codex", "guard");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
    vi.stubEnv("BABELFISH_TEST_UNSET", undefined);
    try {
      await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
      await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
        hooks: { [eventName]: [{ hooks: [{ type: "command", command: "node ${BABELFISH_TEST_UNSET}" }] }] },
      }));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      entry.register({
        on: (name, handler) => { hooks.set(name, handler); },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerCli: () => undefined,
        registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      const result = await hooks.get(handlerName)?.({ toolName: "fixture" }, {});
      expect(result).toMatchObject(expected);
      expect(JSON.stringify(result)).toContain("command expansion failed");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("BABELFISH_TEST_UNSET"));
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
      await removeTemp(root);
    }
  });

  it("registers hooks and maps Hermes pre_tool_call blocks", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-native-"));
    await copyFixture(installDir);
    const previous = process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
    const previousRoot = process.env.OPENCLAW_BABELFISH_ROOT;
    const hookLog = path.join(installDir, "hook.log");
    const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-bundles-"));
    try {
      process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = installDir;
      process.env.OPENCLAW_BABELFISH_ROOT = bundleRoot;
      process.env.BABELFISH_TEST_HOOK_LOG = hookLog;
      const pluginRoot = path.join(bundleRoot, "codex", "prompt-hooks");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "hook.mjs"),
        "let input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const event=JSON.parse(input); console.log(JSON.stringify(event.prompt === 'deny' ? {decision:'block',reason:'denied'} : {hookSpecificOutput:{additionalContext:'prompt context'}})); });",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({ hooks: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }] } } }),
      );
      const promptPluginRoot = path.join(bundleRoot, "claude-code", "model-hooks");
      await fs.mkdir(path.join(promptPluginRoot, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(promptPluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ hooks: { hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Check $ARGUMENTS" }] }] } } }),
      );
      const monitorRoot = path.join(bundleRoot, "claude-code", "monitor-plugin");
      const monitorPidPath = path.join(bundleRoot, "monitor-child.pid");
      // Readiness must follow the PID write so the test can safely inspect the child.
      const monitorCommand = process.platform === "win32"
        ? 'node "%CLAUDE_PLUGIN_ROOT%\\monitor.mjs"'
        : `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > ${JSON.stringify(monitorPidPath)}; printf 'ready\\n'`;
      await fs.mkdir(path.join(monitorRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(monitorRoot, "monitors"));
      await fs.writeFile(
        path.join(monitorRoot, "monitor.mjs"),
        "console.log('ready'); setTimeout(() => {}, 30000);",
      );
      await fs.writeFile(path.join(monitorRoot, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "monitor-plugin" }));
      await fs.writeFile(
        path.join(monitorRoot, "monitors", "monitors.json"),
        JSON.stringify([{ name: "status", description: "Status", command: monitorCommand }]),
      );
      vi.resetModules();
      const module = await import("./index.js");
      const entry = module.default;
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const api = {
        config: {
          plugins: {
            entries: {
              babelfish: {
                llm: { allowAgentIdOverride: true, allowModelOverride: true },
              },
            },
          },
        },
        logger: { warn: vi.fn() },
        runtime: { llm: { complete: vi.fn(async () => ({ text: '{"ok":false,"reason":"model denied"}' })) } },
        on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          hooks.set(name, handler);
        }),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerCli: vi.fn(),
        registerAgentToolResultMiddleware: vi.fn(),
      };

      entry.register(api);

      expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
      await expect(
        hooks.get("before_prompt_build")?.(
          { prompt: "hello", messages: [] },
          { sessionId: "session-1" },
        ),
      ).resolves.toEqual({
        prependContext: "middleware context",
        appendSystemContext: "middleware system context",
      });
      await expect(
        hooks.get("before_tool_call")?.({ toolName: "blocked" }, { sessionId: "session-1" }),
      ).resolves.toEqual({ block: true, blockReason: "blocked" });
      expect(api.registerAgentToolResultMiddleware).toHaveBeenCalledOnce();

      const styleApi = { registerCommand: vi.fn() };
      module.registerOutputStyles(styleApi, [{
        name: "babelfish-style-fixture-brief",
        plugin: "fixture",
        description: "Keep replies short",
        instructions: "Answer briefly.",
        keepCodingInstructions: true,
      }]);
      const styleCommand = styleApi.registerCommand.mock.calls[0]?.[0];
      expect(styleCommand.handler({ sessionId: "styled-session" })).toEqual({
        text: "Output style selected: Keep replies short",
      });
      await expect(
        hooks.get("agent_turn_prepare")?.({}, { sessionId: "styled-session" }),
      ).resolves.toEqual({ prependContext: "fixture context\n\nAnswer briefly." });

      await hooks.get("session_start")?.({ sessionId: "monitor-session" }, { sessionId: "monitor-session" });
      await vi.waitFor(async () => {
        await expect(
          hooks.get("agent_turn_prepare")?.({}, { sessionId: "monitor-session" }),
        ).resolves.toEqual({ prependContext: "fixture context\n\nStatus: ready" });
      }, { timeout: 5000 });
      const monitorPid = process.platform === "win32"
        ? undefined
        : Number((await fs.readFile(monitorPidPath, "utf8")).trim());
      if (monitorPid) {
        expect(() => process.kill(monitorPid, 0)).not.toThrow();
      }
      await hooks.get("session_end")?.({ sessionId: "monitor-session" }, { sessionId: "monitor-session" });
      if (monitorPid) {
        await vi.waitFor(() => {
          expect(() => process.kill(monitorPid, 0)).toThrow();
        });
      }

      await hooks.get("session_start")?.(
        { sessionId: "broken-monitor-session" },
        {
          sessionId: "broken-monitor-session",
          workspaceDir: path.join(bundleRoot, "missing-workspace"),
        },
      );
      await vi.waitFor(() => {
        expect(api.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("monitor-plugin/status failed to start"),
        );
      }, { timeout: 5000 });
      await hooks.get("session_end")?.(
        { sessionId: "broken-monitor-session" },
        { sessionId: "broken-monitor-session" },
      );

      await expect(
        hooks.get("before_agent_run")?.({ prompt: "deny" }, { runId: "run-blocked" }),
      ).resolves.toEqual({ outcome: "block", reason: "denied", message: "denied" });
      await expect(
        hooks.get("before_agent_run")?.({ prompt: "allow" }, { runId: "run-context" }),
      ).resolves.toEqual({ outcome: "pass" });
      await expect(
        hooks.get("agent_turn_prepare")?.({}, { runId: "run-context" }),
      ).resolves.toEqual({ prependContext: "fixture context\n\nprompt context" });
      await expect(
        hooks.get("agent_turn_prepare")?.({}, { runId: "run-context" }),
      ).resolves.toEqual({ prependContext: "fixture context" });
      await expect(
        hooks.get("before_agent_finalize")?.(
          { sessionId: "session-1" },
          {
            sessionId: "session-1",
            agentId: "review-agent",
            modelProviderId: "openai",
            modelId: "gpt-5.5",
          },
        ),
      ).resolves.toMatchObject({ action: "revise", reason: "model denied" });
      expect(api.runtime.llm.complete).toHaveBeenCalledWith(expect.objectContaining({
        agentId: "review-agent",
        model: "openai/gpt-5.5",
        purpose: "babelfish-hook-evaluation",
        systemPrompt: expect.stringContaining('{"ok":true}'),
      }));

      const hooksWithoutLlm = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      entry.register({
        on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          hooksWithoutLlm.set(name, handler);
        }),
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerCli: vi.fn(),
        registerAgentToolResultMiddleware: vi.fn(),
      });
      await expect(
        hooksWithoutLlm.get("before_agent_finalize")?.({}, {}),
      ).resolves.toBeUndefined();
      expect(api.runtime.llm.complete).toHaveBeenCalledOnce();

      await hooks.get("model_call_ended")?.({ outcome: "error" }, { sessionId: "session-1" });
      await hooks.get("model_call_ended")?.({ outcome: "success" }, { sessionId: "session-1" });
      await expect(fs.readFile(hookLog, "utf8")).resolves.toBe(
        ["api_request_error", "post_api_request", ""].join(os.EOL),
      );

      const nativeApi = {
        registerTool: vi.fn(),
      };
      module.registerNativeTools(nativeApi, [
        {
          kind: "tool",
          name: "simple_echo",
          plugin: "simple",
          originalName: "simple_echo",
          description: "Simple echo",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: { value: { type: "string" } },
          },
        },
      ]);
      expect(nativeApi.registerTool).toHaveBeenCalledWith(expect.any(Function), {
        names: ["babelfish_plugins_list", "simple_echo"],
      });
      const factory = nativeApi.registerTool.mock.calls[0]?.[0];
      const tools = factory({ sessionId: "session-1" });
      await expect(tools.find((tool) => tool.name === "simple_echo")?.execute("call-1", {
        value: "native-ok",
      })).resolves.toMatchObject({ details: { echo: "native-ok" } });

      const commandApi = { registerCommand: vi.fn() };
      module.registerHermesCommands(commandApi, [
        {
          name: "simple",
          plugin: "simple",
          originalName: "simple",
          description: "Simple command",
          argsHint: "<raw text>",
        },
      ]);
      const command = commandApi.registerCommand.mock.calls[0]?.[0];
      await expect(command.handler({ args: "from-slash" })).resolves.toEqual({
        text: '{\n  "command": "from-slash"\n}',
      });

      const cliAction = vi.fn();
      const cliProgram = {
        command: vi.fn(() => ({
          description: vi.fn().mockReturnThis(),
          argument: vi.fn().mockReturnThis(),
          allowUnknownOption: vi.fn().mockReturnThis(),
          action: cliAction,
        })),
      };
      const cliApi = { registerCli: vi.fn((register: (ctx: unknown) => void) => register({ program: cliProgram })) };
      module.registerBabelfishCli(cliApi);
      expect(cliProgram.command).toHaveBeenCalledWith("babelfish");
      cliProgram.command.mockClear();
      cliAction.mockClear();
      module.registerHermesCliCommands(cliApi, [
        {
          name: "simplecli",
          plugin: "simple",
          originalName: "simplecli",
          description: "Simple CLI command",
          argsHint: "",
        },
      ]);
      expect(cliProgram.command).toHaveBeenCalledWith("simplecli");
      expect(cliApi.registerCli).toHaveBeenCalledTimes(2);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        await expect(cliAction.mock.calls[0]?.[0](["from-cli"])).resolves.toBeUndefined();
        expect(write).toHaveBeenCalledWith("printed:from-cli\n");
        expect(log).toHaveBeenCalledWith('{\n  "cli": "from-cli"\n}');
      } finally {
        write.mockRestore();
        log.mockRestore();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
      } else {
        process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = previous;
      }
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_BABELFISH_ROOT;
      } else {
        process.env.OPENCLAW_BABELFISH_ROOT = previousRoot;
      }
      delete process.env.BABELFISH_TEST_HOOK_LOG;
    }
  }, 30_000); // Covers cold Python and multiple Windows supervisor launches.

  it("terminates a monitor that exceeds the hook output limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-monitor-cap-"));
    const plugin = path.join(root, "claude-code", "monitor-plugin");
    const scriptPath = path.join(plugin, "flood.cjs");
    const pidPath = path.join(root, "pid");
    const bytes = MAX_HOOK_OUTPUT_BYTES + 8192;
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "empty-hermes"));
    const warn = vi.fn();
    let hooks: Map<string, (event: unknown, ctx: unknown) => unknown> | undefined;
    try {
      await fs.mkdir(path.join(root, "empty-hermes"), { recursive: true });
      await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(plugin, "monitors"), { recursive: true });
      await fs.writeFile(
        scriptPath,
        `require("node:fs").writeFileSync(process.argv[2], String(process.pid)); process.stdout.write("A".repeat(${bytes})); setInterval(() => {}, 1000);\n`,
      );
      const quote = (value: string) => process.platform === "win32"
        ? `"${value.replaceAll('"', '""')}"`
        : JSON.stringify(value);
      const command = process.platform === "win32"
        ? `node "%CLAUDE_PLUGIN_ROOT%\\flood.cjs" ${quote(pidPath)}`
        : `${quote(process.execPath)} ${quote(scriptPath)} ${quote(pidPath)}`;
      await fs.writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "monitor-plugin" }));
      await fs.writeFile(path.join(plugin, "monitors", "monitors.json"), JSON.stringify([
        { name: "status", description: "Status", command },
      ]));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      hooks = new Map();
      entry.register({
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerCli: () => undefined,
        registerAgentToolResultMiddleware: () => undefined,
        logger: { warn },
      });
      await hooks.get("session_start")?.(
        { sessionId: "flood-monitor" },
        { sessionId: "flood-monitor", workspaceDir: root },
      );
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number(await fs.readFile(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`${MAX_HOOK_OUTPUT_BYTES}-byte output limit`),
        );
      }, { timeout: 10_000 });
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 5_000 });
    } finally {
      await hooks?.get("session_end")?.({ sessionId: "flood-monitor" }, { sessionId: "flood-monitor" });
      vi.unstubAllEnvs();
      await removeTemp(root);
    }
  }, 20_000);

  it("keeps monitor lines split across bytes, breaks, and end of output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-monitor-lines-"));
    const plugin = path.join(root, "claude-code", "monitor-plugin");
    const scriptPath = path.join(plugin, "lines.cjs");
    const pidPath = path.join(root, "pid");
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "empty-hermes"));
    let hooks: Map<string, (event: unknown, ctx: unknown) => unknown> | undefined;
    try {
      await fs.mkdir(path.join(root, "empty-hermes"), { recursive: true });
      await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(plugin, "monitors"), { recursive: true });
      await fs.writeFile(scriptPath, `
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[2], String(process.pid));
        const out = process.stdout;
        const accent = Buffer.from("é", "utf8");
        out.write(Buffer.from("cr-one\\rcr-two\\n"));
        out.write(accent.subarray(0, 1));
        out.write(Buffer.concat([accent.subarray(1), Buffer.from("\\n")]));
        out.write(Buffer.from("final"));
      `);
      const quote = (value: string) => process.platform === "win32"
        ? `"${value.replaceAll('"', '""')}"`
        : JSON.stringify(value);
      const command = process.platform === "win32"
        ? `node "%CLAUDE_PLUGIN_ROOT%\\lines.cjs" ${quote(pidPath)}`
        : `${quote(process.execPath)} ${quote(scriptPath)} ${quote(pidPath)}`;
      await fs.writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "monitor-plugin" }));
      await fs.writeFile(path.join(plugin, "monitors", "monitors.json"), JSON.stringify([
        { name: "status", description: "Status", command },
      ]));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      hooks = new Map();
      entry.register({
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerCli: () => undefined,
        registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      await hooks.get("session_start")?.(
        { sessionId: "line-monitor" },
        { sessionId: "line-monitor", workspaceDir: root },
      );
      await vi.waitFor(async () => {
        const pid = Number(await fs.readFile(pidPath, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(hooks.get("agent_turn_prepare")?.({}, { sessionId: "line-monitor" })).resolves.toEqual({
        prependContext: ["Status: cr-one", "Status: cr-two", "Status: é", "Status: final"].join("\n\n"),
      });
    } finally {
      await hooks?.get("session_end")?.({ sessionId: "line-monitor" }, { sessionId: "line-monitor" });
      vi.unstubAllEnvs();
      await removeTemp(root);
    }
  }, 20_000);

  it("keeps a complete line in the chunk that crosses the output limit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-monitor-prefix-"));
    const plugin = path.join(root, "claude-code", "monitor-plugin");
    const scriptPath = path.join(plugin, "prefix.cjs");
    const pidPath = path.join(root, "pid");
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "empty-hermes"));
    const warn = vi.fn();
    let hooks: Map<string, (event: unknown, ctx: unknown) => unknown> | undefined;
    try {
      await fs.mkdir(path.join(root, "empty-hermes"), { recursive: true });
      await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.join(plugin, "monitors"), { recursive: true });
      await fs.writeFile(scriptPath, `
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[2], String(process.pid));
        process.stdout.write(Buffer.concat([
          Buffer.from("ready\\n"),
          Buffer.alloc(${MAX_HOOK_OUTPUT_BYTES}, 0x41),
        ]));
        setInterval(() => {}, 1000);
      `);
      const quote = (value: string) => process.platform === "win32"
        ? `"${value.replaceAll('"', '""')}"`
        : JSON.stringify(value);
      const command = process.platform === "win32"
        ? `node "%CLAUDE_PLUGIN_ROOT%\\prefix.cjs" ${quote(pidPath)}`
        : `${quote(process.execPath)} ${quote(scriptPath)} ${quote(pidPath)}`;
      await fs.writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "monitor-plugin" }));
      await fs.writeFile(path.join(plugin, "monitors", "monitors.json"), JSON.stringify([
        { name: "status", description: "Status", command },
      ]));
      vi.resetModules();
      const entry = (await import("./index.js")).default;
      hooks = new Map();
      entry.register({
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { hooks.set(name, handler); },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerCli: () => undefined,
        registerAgentToolResultMiddleware: () => undefined,
        logger: { warn },
      });
      await hooks.get("session_start")?.(
        { sessionId: "prefix-monitor" },
        { sessionId: "prefix-monitor", workspaceDir: root },
      );
      let pid = 0;
      await vi.waitFor(async () => {
        pid = Number(await fs.readFile(pidPath, "utf8"));
        expect(pid).toBeGreaterThan(0);
      }, { timeout: 10_000 });
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${MAX_HOOK_OUTPUT_BYTES}-byte output limit`));
      }, { timeout: 10_000 });
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 5_000 });
      await expect(hooks.get("agent_turn_prepare")?.({}, { sessionId: "prefix-monitor" })).resolves.toEqual({
        prependContext: "Status: ready",
      });
    } finally {
      await hooks?.get("session_end")?.({ sessionId: "prefix-monitor" }, { sessionId: "prefix-monitor" });
      vi.unstubAllEnvs();
      await removeTemp(root);
    }
  }, 20_000);
});

describe("Stop hook finalization", () => {
  async function finalize(
    decision: Record<string, unknown> | Record<string, unknown>[],
    options: { event?: Record<string, unknown>; hookEvent?: string; exitCode?: number } = {},
  ) {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-stop-hermes-"));
    const bundleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-stop-root-"));
    const previous = process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
    const previousRoot = process.env.OPENCLAW_BABELFISH_ROOT;
    const pluginRoot = path.join(bundleRoot, "codex", "stop-hooks");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    const decisions = Array.isArray(decision) ? decision : [decision];
    for (const [index, result] of decisions.entries()) {
      await fs.writeFile(
        path.join(pluginRoot, `hook-${index}.mjs`),
        `process.stdin.resume(); process.stdin.on("end", () => { console.log(${JSON.stringify(JSON.stringify(result))}); process.exitCode = ${options.exitCode ?? 0}; });`,
      );
    }
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: { [options.hookEvent ?? "Stop"]: [{ hooks: decisions.map((_, index) => ({
          type: "command",
          command: [process.execPath, `hook-${index}.mjs`],
        })) }] },
      }),
    );
    process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = installDir;
    process.env.OPENCLAW_BABELFISH_ROOT = bundleRoot;
    try {
      vi.resetModules();
      const module = await import("./index.js");
      const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      module.default.register({
        on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
          hooks.set(name, handler);
        },
        registerTool: () => undefined,
        registerCommand: () => undefined,
        registerCli: () => undefined,
        registerAgentToolResultMiddleware: () => undefined,
        logger: { warn: () => undefined },
      });
      const handler = options.hookEvent === "PreToolUse" ? "before_tool_call"
        : options.hookEvent === "UserPromptSubmit" ? "before_agent_run"
        : "before_agent_finalize";
      return await hooks.get(handler)?.(options.event ?? {}, {});
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR;
      else process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR = previous;
      if (previousRoot === undefined) delete process.env.OPENCLAW_BABELFISH_ROOT;
      else process.env.OPENCLAW_BABELFISH_ROOT = previousRoot;
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.rm(bundleRoot, { recursive: true, force: true });
    }
  }

  it("finalizes when a Stop hook sets continue false", async () => {
    await expect(finalize({ continue: false, stopReason: "finished" })).resolves.toBeUndefined();
  });

  it("revises when a Stop hook sets decision block", async () => {
    await expect(finalize({ decision: "block", reason: "tests failed" })).resolves.toEqual({
      action: "revise",
      reason: "tests failed",
      retry: { instruction: "tests failed" },
    });
  });

  it("lets continue false outrank a Stop block on the same hook", async () => {
    await expect(finalize({
      continue: false,
      decision: "block",
      reason: "keep going",
      stopReason: "halt",
    })).resolves.toBeUndefined();
  });

  it.each([false, true])("retains a separate Stop block (block first: %s)", async (blockFirst) => {
    const decisions = [
      { continue: false, stopReason: "finished" },
      { decision: "block", reason: "separate guard" },
    ];
    await expect(finalize(blockFirst ? decisions.reverse() : decisions)).resolves.toEqual({
      action: "revise",
      reason: "separate guard",
      retry: { instruction: "separate guard" },
    });
  });

  it("retains revision for exit-2 Stop hooks", async () => {
    await expect(finalize({ continue: false }, { exitCode: 2 })).resolves.toMatchObject({
      action: "revise",
      reason: expect.stringContaining("Stop hook"),
    });
  });

  it("retains revision for oversized Stop input", async () => {
    await expect(finalize({ continue: false }, {
      event: { text: "x".repeat(1024 * 1024) },
    })).resolves.toMatchObject({
      action: "revise",
      reason: expect.stringContaining("1048576-byte payload limit"),
    });
  });

  it.each(["PreToolUse", "UserPromptSubmit"])("still blocks %s for continue false", async (hookEvent) => {
    await expect(finalize({ continue: false, stopReason: "halt" }, { hookEvent })).resolves.toEqual(
      hookEvent === "PreToolUse"
        ? { block: true, blockReason: "halt" }
        : { outcome: "block", reason: "halt", message: "halt" },
    );
  });
});
