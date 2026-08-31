import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function copyFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
  await fs.cp(fixture, path.join(target, "simple"), { recursive: true });
}

describe("native OpenClaw hook entry", () => {
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
  }, 20_000);
});
