import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  callHermesCliCommand,
  callHermesCommand,
  callHermesTool,
  invokeHermesHook,
  listHermesPlugins,
  readHermesSkill,
  releaseHermesBridge,
} from "./hermes-python.js";

async function copyFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
  await fs.cp(fixture, path.join(target, "simple"), { recursive: true });
}

async function copyRelativeFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/relative-hermes-plugin");
  await fs.cp(fixture, path.join(target, "relative"), { recursive: true });
}

async function writeRoutingFixture(
  installDir: string,
  key: string,
  manifestName: string,
  marker: string,
): Promise<void> {
  const pluginDir = path.join(installDir, key);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.yaml"), `name: ${manifestName}\n`);
  await fs.writeFile(path.join(pluginDir, "skill.md"), marker);
  await fs.writeFile(
    path.join(pluginDir, "__init__.py"),
    [
      "from pathlib import Path",
      "",
      "def _setup(parser):",
      "    pass",
      "",
      "def register(ctx):",
      `    ctx.register_tool(name="shared", toolset="test", schema={"name": "shared", "parameters": {"type": "object"}}, handler=lambda args: {"marker": "${marker}"})`,
      `    ctx.register_command("shared", lambda raw: {"marker": "${marker}"}, "Shared command")`,
      `    ctx.register_cli_command("sharedcli", "Shared CLI", _setup, lambda args: {"marker": "${marker}"}, "Shared CLI")`,
      `    ctx.register_skill("shared_skill", Path("skill.md"), "${marker}")`,
      "",
    ].join("\n"),
  );
}

describe("Hermes Python bridge", () => {
  it("lists and calls a Hermes register(ctx) tool", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    await copyFixture(installDir);

    const config = {
      installDir,
      python: "python3",
      timeoutMs: 10000,
      env: {},
    };

    const listed = await listHermesPlugins(config);
    expect(listed.plugins).toHaveLength(1);
    expect(listed.plugins[0]?.tools.map((tool) => tool.name)).toEqual([
      "simple_echo",
      "simple_state",
      "simple_optional",
    ]);
    expect(listed.plugins[0]?.hooks).toEqual([
      "api_request_error",
      "on_session_start",
      "post_api_request",
      "post_tool_call",
      "pre_llm_call",
      "pre_tool_call",
      "transform_tool_result",
    ]);
    expect(listed.plugins[0]?.commands).toEqual([
      {
        name: "simple",
        description: "Simple command",
        argsHint: "<raw text>",
        available: true,
      },
    ]);
    expect(listed.plugins[0]?.cliCommands).toEqual([
      {
        name: "simplecli",
        description: "Simple CLI command",
        argsHint: "",
        available: true,
      },
    ]);
    expect(listed.plugins[0]?.skills.map((skill) => skill.name)).toEqual(["simple_skill"]);

    const called = await callHermesTool(config, {
      plugin: "simple",
      tool: "simple_echo",
      args: { value: "ok" },
      context: { sessionId: "session-1" },
    });
    expect(called.parsedResult).toEqual({ echo: "ok" });
    await expect(
      callHermesTool(config, {
        plugin: "simple",
        tool: "simple_optional",
        args: { value: "kept" },
      }),
    ).resolves.toMatchObject({ result: { optional: { value: "kept" } } });

    await expect(
      callHermesCommand(config, {
        plugin: "simple",
        command: "simple",
        args: "raw",
      }),
    ).resolves.toMatchObject({ result: { command: "raw" } });

    await expect(
      callHermesCliCommand(config, {
        plugin: "simple",
        command: "simplecli",
        args: ["from-cli"],
      }),
    ).resolves.toMatchObject({ result: { cli: "from-cli" }, stdout: "printed:from-cli\n" });

    await expect(
      readHermesSkill(config, { plugin: "simple", skill: "simple_skill" }),
    ).resolves.toMatchObject({ text: expect.stringContaining("Simple Skill") });

    await expect(
      invokeHermesHook(config, {
        hook: "pre_tool_call",
        kwargs: { tool_name: "blocked" },
        context: { sessionId: "session-1" },
      }),
    ).resolves.toMatchObject({
      results: [{ action: "block", message: "blocked" }],
    });

    await expect(
      invokeHermesHook(config, {
        hook: "post_tool_call",
        kwargs: { tool_name: "simple_echo" },
        context: { sessionId: "session-1" },
      }),
    ).resolves.toMatchObject({ results: ["no-arg"] });
  }, 15_000); // Allow cold Python startup on shared CI runners.

  it("does not spawn the adapter for an already-cancelled call", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      callHermesTool(
        { installDir: "/tmp/unused", python: "/definitely/missing", timeoutMs: 10000, env: {} },
        { tool: "unused", args: {} },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled");
  });

  it("preserves plugin state across hook and tool calls", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    await copyFixture(installDir);
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };

    const context = { sessionId: "stateful-session" };
    await invokeHermesHook(config, { hook: "on_session_start", kwargs: { value: "kept" }, context });
    await expect(
      callHermesTool(config, { plugin: "simple", tool: "simple_state", args: {}, context }),
    ).resolves.toMatchObject({ result: { state: "kept" } });

    releaseHermesBridge(config, context);
    await expect(
      callHermesTool(config, { plugin: "simple", tool: "simple_state", args: {}, context }),
    ).resolves.toMatchObject({ result: { state: "unset" } });
  });

  it("does not block independent sessions behind one adapter lane", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    const pluginDir = path.join(installDir, "concurrent");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "plugin.yaml"), "name: concurrent\n");
    await fs.writeFile(
      path.join(pluginDir, "__init__.py"),
      'import time\n\ndef register(ctx):\n    ctx.register_tool(name="slow", toolset="test", schema={"name":"slow","parameters":{"type":"object"}}, handler=lambda args: (time.sleep(2), {"done": True})[1])\n    ctx.register_hook("pre_llm_call", lambda **kwargs: {"context": "fast"})\n',
    );
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };
    const slow = callHermesTool(config, {
      plugin: "concurrent",
      tool: "slow",
      args: {},
      context: { sessionId: "slow-session" },
    });
    const fast = invokeHermesHook(config, {
      hook: "pre_llm_call",
      kwargs: {},
      context: { sessionId: "fast-session" },
    });

    await expect(
      Promise.race([
        fast,
        new Promise((_, reject) => setTimeout(() => reject(new Error("blocked")), 1500)),
      ]),
    ).resolves.toMatchObject({ results: [{ context: "fast" }] });
    await slow;
  });

  it("loads Hermes plugins that use package-relative imports", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    await copyRelativeFixture(installDir);

    const config = {
      installDir,
      python: "python3",
      timeoutMs: 10000,
      env: {},
    };

    const listed = await listHermesPlugins(config);
    expect(listed.plugins[0]?.error).toBeUndefined();
    expect(listed.plugins[0]?.tools.map((tool) => tool.name)).toEqual(["relative_echo"]);

    const called = await callHermesTool(config, {
      plugin: "relative",
      tool: "relative_echo",
      args: { value: "ok" },
    });
    expect(called.result).toEqual({ echo: "ok" });
  });

  it("isolates relative imports for plugin names that sanitize alike", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    const fixture = path.join(process.cwd(), "test/fixtures/relative-hermes-plugin");
    await fs.cp(fixture, path.join(installDir, "a.b"), { recursive: true });
    await fs.cp(fixture, path.join(installDir, "a_b"), { recursive: true });
    await fs.writeFile(path.join(installDir, "a.b", "helper.py"), 'MARKER = "first"\n');
    await fs.writeFile(path.join(installDir, "a_b", "helper.py"), 'MARKER = "second"\n');
    const registration = `from .helper import MARKER\n\ndef register(ctx):\n    ctx.register_tool(\n        name="relative_echo",\n        toolset=MARKER,\n        schema={"name": "relative_echo", "description": MARKER, "parameters": {"type": "object"}},\n        handler=lambda args: {"marker": MARKER},\n    )\n`;
    await fs.writeFile(path.join(installDir, "a.b", "__init__.py"), registration);
    await fs.writeFile(path.join(installDir, "a_b", "__init__.py"), registration);
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };

    const listed = await listHermesPlugins(config);
    expect(listed.plugins.map((plugin) => plugin.tools[0]?.description)).toEqual([
      "first",
      "second",
    ]);
  });

  it("prefers an exact installed key over another plugin's manifest alias", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    await writeRoutingFixture(installDir, "a-alias", "real", "alias");
    await writeRoutingFixture(installDir, "real", "actual", "exact");
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };

    await expect(
      callHermesTool(config, { plugin: "real", tool: "shared", args: {} }),
    ).resolves.toMatchObject({ plugin: "real", result: { marker: "exact" } });
    await expect(
      callHermesCommand(config, { plugin: "real", command: "shared", args: "" }),
    ).resolves.toMatchObject({ plugin: "real", result: { marker: "exact" } });
    await expect(
      callHermesCliCommand(config, { plugin: "real", command: "sharedcli", args: [] }),
    ).resolves.toMatchObject({ plugin: "real", result: { marker: "exact" } });
    await expect(
      readHermesSkill(config, { plugin: "real", skill: "shared_skill" }),
    ).resolves.toMatchObject({ plugin: "real", text: "exact" });
  });

  it("rejects an ambiguous manifest alias", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-"));
    await writeRoutingFixture(installDir, "first", "shared-alias", "first");
    await writeRoutingFixture(installDir, "second", "shared-alias", "second");
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };

    await expect(
      callHermesTool(config, { plugin: "shared-alias", tool: "shared", args: {} }),
    ).rejects.toThrow("Plugin selector 'shared-alias' is ambiguous");
  });
});
