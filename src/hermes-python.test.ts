import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyFixture } from "../test/hermes-fixtures.js";
import {
  callHermesCliCommand,
  callHermesCommand,
  callHermesTool,
  invokeHermesHook,
  invokeHermesMiddleware,
  listHermesPlugins,
  readHermesSkill,
  releaseHermesBridge,
} from "./hermes-python.js";

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
  it.each(["empty", "missing", "nested-missing"])("skips Python only for a verified %s installation", async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-absence-"));
    const installDir = kind === "empty" ? root : path.join(root, kind === "missing" ? "missing" : "missing/nested");
    const config = { rootDir: root, installDir, python: path.join(root, "no-python"), timeoutMs: 1000, env: {} };
    try {
      await expect(listHermesPlugins(config)).resolves.toEqual({ installDir, plugins: [] });
      await expect(invokeHermesHook(config, { hook: "pre_tool_call", kwargs: {} }))
        .resolves.toEqual({ hook: "pre_tool_call", invoked: [], results: [] });
      await expect(invokeHermesMiddleware(config, { kind: "tool_request", kwargs: {} }))
        .resolves.toEqual({ middleware: "tool_request", invoked: [], results: [] });
      for (const invoke of [
        () => callHermesTool(config, { tool: "missing", args: {} }),
        () => callHermesCommand(config, { command: "missing", args: "" }),
        () => callHermesCliCommand(config, { command: "missing", args: [] }),
        () => readHermesSkill(config, { skill: "missing" }),
      ]) await expect(invoke()).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not cache absence or infer it from incomplete files or a stale registry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-unknown-"));
    const config = { rootDir: root, installDir: root, python: path.join(root, "no-python"), timeoutMs: 1000, env: {} };
    try {
      await expect(listHermesPlugins(config)).resolves.toMatchObject({ plugins: [] });
      await fs.writeFile(path.join(root, "plugin.yaml"), "name: incomplete\n");
      await fs.writeFile(path.join(root, "babelfish.generated.json"), '{"plugins":[]}');
      await expect(listHermesPlugins(config)).rejects.toThrow();
      await expect(invokeHermesHook(config, { hook: "pre_tool_call", kwargs: {} })).rejects.toThrow();
      await expect(invokeHermesMiddleware(config, { kind: "tool_request", kwargs: {} })).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unreadable installation discovery", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    const read = vi.spyOn(fs, "readdir").mockRejectedValue(error);
    try {
      await expect(invokeHermesHook(
        { installDir: "unreadable", rootDir: ".", python: "python3", timeoutMs: 1000, env: {} },
        { hook: "pre_tool_call", kwargs: {} },
      )).rejects.toThrow("denied");
    } finally {
      read.mockRestore();
    }
  });

  it.each(["~", "~/guard", "~fixture/guard"])("leaves %s expansion to Python", async (installDir) => {
    const read = vi.spyOn(fs, "readdir");
    const config = { rootDir: ".", installDir, python: path.join(os.tmpdir(), "babelfish-no-such-python"), timeoutMs: 1000, env: {} };
    try {
      await expect(listHermesPlugins(config)).rejects.toThrow();
      await expect(invokeHermesHook(config, { hook: "pre_tool_call", kwargs: {} })).rejects.toThrow();
      await expect(invokeHermesMiddleware(config, { kind: "tool_request", kwargs: {} })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("does not mistake dangling symlinks for absent installations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-dangling-"));
    const link = path.join(root, "link");
    try {
      await fs.symlink(path.join(root, "missing"), link);
      for (const installDir of [link, path.join(link, "nested")]) {
        await expect(listHermesPlugins({ rootDir: root, installDir, python: "python3", timeoutMs: 1000, env: {} }))
          .rejects.toThrow();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not normalize away a missing component before an installed guard", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-path-identity-"));
    try {
      await copyFixture(path.join(root, "hermes"));
      await fs.symlink(path.join(root, "absent-target"), path.join(root, "dangling"));
      for (const prefix of ["missing", "dangling"]) {
        const config = {
          rootDir: root, installDir: `${root}/${prefix}/../hermes`,
          python: "python3", timeoutMs: 1000, env: {},
        };
        await expect(listHermesPlugins(config)).rejects.toThrow();
        await expect(invokeHermesHook(config, { hook: "pre_tool_call", kwargs: { tool_name: "blocked" } }))
          .rejects.toThrow();
        await expect(invokeHermesMiddleware(config, { kind: "tool_request", kwargs: {} })).rejects.toThrow();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes event keywords through async callbacks and keeps printed output off the protocol", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-event-"));
    const plugin = path.join(installDir, "observer");
    const config = { installDir, python: "python3", timeoutMs: 10000, env: {} };
    const context = { sessionId: "outer" };
    try {
      await fs.mkdir(plugin);
      await fs.writeFile(path.join(plugin, "plugin.yaml"), "name: observer\n");
      await fs.writeFile(path.join(plugin, "__init__.py"), [
        "async def callback(*, handler, sessionId, openclaw_context):",
        "    print('observer output')",
        "    return [handler, sessionId, openclaw_context['sessionId']]",
        "def register(ctx):",
        "    ctx.register_hook('post_tool_call', callback)",
      ].join("\n"));
      const response = await invokeHermesHook(config, {
        hook: "post_tool_call", context,
        kwargs: { handler: "event field", sessionId: "inner", openclaw_context: "ignored" },
      });
      expect(response.results).toEqual([["event field", "inner", "outer"]]);
    } finally {
      releaseHermesBridge(config, context);
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });

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

  it("keeps discovery in the request lane before a concurrent tool call", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-discovery-order-"));
    await copyFixture(installDir);
    const config = { rootDir: installDir, installDir, python: "python3", timeoutMs: 10000, env: {} };
    const context = { sessionId: "discovery-order" };
    const readdir = fs.readdir.bind(fs);
    const read = vi.spyOn(fs, "readdir").mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return readdir(installDir);
    });
    try {
      const start = invokeHermesHook(config, { hook: "on_session_start", kwargs: { value: "ordered" }, context });
      const call = callHermesTool(config, { plugin: "simple", tool: "simple_state", args: {}, context });
      await expect(call).resolves.toMatchObject({ result: { state: "ordered" } });
      await start;
    } finally {
      read.mockRestore();
      releaseHermesBridge(config, context);
      await fs.rm(installDir, { recursive: true, force: true });
    }
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
    await copyFixture(installDir, "relative-hermes-plugin", "relative");

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
