import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hookAdditionalContext,
  hookBlock,
  hookUpdatedInput,
  inspectBundlePlugin,
  invokeBundleHooks,
} from "./bundle-plugins.js";

const fixtureTimeoutMs = 15_000;

async function fixture(app: "claude-code" | "codex") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `babelfish-${app}-`));
  const manifestDir = app === "codex" ? ".codex-plugin" : ".claude-plugin";
  await fs.mkdir(path.join(root, manifestDir), { recursive: true });
  await fs.writeFile(
    path.join(root, manifestDir, "plugin.json"),
    JSON.stringify({ name: "fixture", skills: "./skills", hooks: "./hooks/hooks.json" }),
  );
  await fs.mkdir(path.join(root, "skills", "demo"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  await fs.mkdir(path.join(root, "hooks"));
  await fs.writeFile(
    path.join(root, "hook.mjs"),
    "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'from hook'}})));",
  );
  await fs.writeFile(
    path.join(root, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }] } }),
  );
  return root;
}

describe("bundle plugins", () => {
  it.each(["claude-code", "codex"] as const)("discovers %s skills and command hooks", async (app) => {
    const root = await fixture(app);
    const plugin = await inspectBundlePlugin(app, root);
    expect(plugin.skillDirs).toEqual([await fs.realpath(path.join(root, "skills"))]);
    expect(plugin.hooks).toMatchObject([{ event: "SessionStart", command: "node hook.mjs" }]);
  });

  it("executes compatible command hooks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const plugin = await fixture("codex");
    await fs.mkdir(path.join(rootDir, "codex"), { recursive: true });
    await fs.rename(plugin, path.join(rootDir, "codex", "fixture"));
    const results = await invokeBundleHooks(
      { rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: fixtureTimeoutMs, env: {} },
      "SessionStart",
      {},
    );
    expect(results.map(hookAdditionalContext)).toEqual(["from hook"]);
  }, 30_000);

  it("terminates hooks that exceed the output limit", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "noisy.mjs"),
      "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120)); setTimeout(() => {}, 30_000);",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node noisy.mjs" }] }],
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      rootDir,
      installDir: path.join(rootDir, "hermes"),
      python: "python3",
      timeoutMs: fixtureTimeoutMs,
      env: {},
    };
    try {
      await expect(invokeBundleHooks(config, "SessionStart", {})).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("1048576-byte output limit"));
    } finally {
      warn.mockRestore();
    }
  });

  it("normalizes hook decisions", () => {
    expect(hookBlock({ decision: "block", reason: "no" })).toEqual({ block: true, reason: "no" });
    expect(hookUpdatedInput({ hookSpecificOutput: { updatedInput: { value: 2 } } })).toEqual({ value: 2 });
  });

  it.each([0, 2])("preserves exit %s when a hook closes stdin early", async (code) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-early-exit-"));
    const plugin = path.join(rootDir, "codex", "fixture");
    try {
      await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
      await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }] },
      }));
      await fs.writeFile(path.join(plugin, "hook.mjs"), `
import fs from "node:fs";
fs.closeSync(0);
console.log(JSON.stringify({ systemMessage: "ready" }));
console.error("denied");
process.exitCode = ${code};
`);
      const results = await invokeBundleHooks({
        rootDir, installDir: path.join(rootDir, "hermes"), python: "python3",
        timeoutMs: fixtureTimeoutMs, env: {},
      }, "PreToolUse", { tool_input: { text: "x".repeat(2 * 1024 * 1024) } });
      expect(results).toEqual(code === 0
        ? [{ systemMessage: "ready" }]
        : [{ decision: "block", reason: "denied" }]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("passes each pre-tool rewrite to subsequent hooks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "rewrite.mjs"),
      "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({hookSpecificOutput:{updatedInput:{value:2}}})));",
    );
    await fs.writeFile(
      path.join(pluginRoot, "validate.mjs"),
      "let input=''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => { const event=JSON.parse(input); if(event.tool_input.value===2){ console.error('rewritten input blocked'); process.exit(2); } });",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
        { type: "command", command: "node rewrite.mjs" },
        { type: "command", command: "node validate.mjs" },
      ] }] } }),
    );
    const config = { rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: fixtureTimeoutMs, env: {} };
    await expect(invokeBundleHooks(config, "PreToolUse", { tool_input: { value: 1 } })).resolves.toEqual([
      { hookSpecificOutput: { updatedInput: { value: 2 } } },
      { decision: "block", reason: "rewritten input blocked" },
    ]);
  });

  it("evaluates prompt hook handlers through the host callback", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "claude-code", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ hooks: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: "Check $ARGUMENTS" }] }] } } }),
    );
    const config = { rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: fixtureTimeoutMs, env: {} };
    const evaluate = vi.fn(async () => ({ decision: "block", reason: "model denied" }));
    await expect(invokeBundleHooks(config, "UserPromptSubmit", { prompt: "deny" }, "", evaluate))
      .resolves.toEqual([{ decision: "block", reason: "model denied" }]);
    expect(evaluate).toHaveBeenCalledWith("Check $ARGUMENTS", expect.objectContaining({ prompt: "deny" }), 60_000);
  });

  it("merges conventional paths and inline MCP servers", async () => {
    const root = await fixture("claude-code");
    await fs.mkdir(path.join(root, "extra", "custom"), { recursive: true });
    await fs.writeFile(path.join(root, "extra", "custom", "SKILL.md"), "---\nname: custom\ndescription: custom\n---\n");
    await fs.writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "fixture",
        skills: ["./skills/", "./extra"],
        mcpServers: { inline: { command: "node", args: ["server.mjs"] } },
      }),
    );
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.skillDirs).toEqual([
      await fs.realpath(path.join(root, "skills")),
      await fs.realpath(path.join(root, "extra")),
    ]);
    expect(plugin.servers.map((server) => server.name)).toEqual(["inline"]);
  });

  it.each(["\n", "\r\n"])("discovers Claude output styles with %j line endings", async (eol) => {
    const root = await fixture("claude-code");
    await fs.mkdir(path.join(root, "output-styles"));
    await fs.writeFile(
      path.join(root, "output-styles", "brief.md"),
      ["---", "name: Brief", "description: Keep replies short", "keep-coding-instructions: true", "---", "Answer in three sentences."].join(eol),
    );
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.outputStyles).toEqual([{
      name: "Brief",
      description: "Keep replies short",
      instructions: "Answer in three sentences.",
      keepCodingInstructions: true,
    }]);
  });

  it("discovers always-on Claude monitors and reports deferred triggers", async () => {
    const root = await fixture("claude-code");
    await fs.mkdir(path.join(root, "monitors"));
    await fs.writeFile(
      path.join(root, "monitors", "monitors.json"),
      JSON.stringify([
        { name: "status", command: "printf ready", description: "Status" },
        { name: "debug", command: "printf debug", description: "Debug", when: "on-skill-invoke:debug" },
      ]),
    );
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.monitors).toEqual([{ name: "status", command: "printf ready", description: "Status" }]);
    expect(plugin.unsupported).toContain("monitor debug trigger on-skill-invoke:debug");
  });

  it("loads declared hook directories and gives inline MCP servers precedence", async () => {
    const root = await fixture("codex");
    await fs.mkdir(path.join(root, "custom-hooks", "nested"), { recursive: true });
    await fs.writeFile(
      path.join(root, "custom-hooks", "nested", "session.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "exit 0" }] }] } }),
    );
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "file-command" } } }),
    );
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: "./custom-hooks",
        mcpServers: { shared: { command: "inline-command" } },
      }),
    );
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.hooks).toContainEqual(expect.objectContaining({ event: "SessionEnd" }));
    expect(plugin.hooks).not.toContainEqual(expect.objectContaining({ event: "SessionStart" }));
    expect(plugin.servers).toEqual([{
      name: "shared",
      config: { command: "inline-command" },
      baseDir: root,
    }]);
  });

  it("uses a declared MCP file instead of the conventional file", async () => {
    const root = await fixture("codex");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { conventional: { command: "ignored" } } }),
    );
    await fs.writeFile(
      path.join(root, "config", "servers.json"),
      JSON.stringify({ mcpServers: { declared: { command: "./server" } } }),
    );
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: "./config/servers.json" }),
    );
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.servers).toEqual([{
      name: "declared",
      config: { command: "./server" },
      baseDir: path.join(root, "config"),
    }]);
  });

  it("keeps Claude conventional MCP servers with declared files", async () => {
    const root = await fixture("claude-code");
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { conventional: { command: "default" } } }),
    );
    await fs.writeFile(
      path.join(root, "config", "servers.json"),
      JSON.stringify({ mcpServers: { declared: { command: "custom" } } }),
    );
    await fs.writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: "./config/servers.json" }),
    );
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.servers.map((server) => server.name)).toEqual(["conventional", "declared"]);
  });

  it("reports authenticated MCP servers without executing them", async () => {
    const root = await fixture("codex");
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: { secure: { type: "http", url: "https://example.invalid", oauth: {} } } }),
    );
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.servers).toEqual([]);
    expect(plugin.unsupported).toContain("MCP authentication for secure");
  });

  it("rejects skill roots that escape through symlinks", async () => {
    const root = await fixture("codex");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-outside-"));
    await fs.rm(path.join(root, "skills"), { recursive: true });
    await fs.symlink(outside, path.join(root, "skills"));
    await expect(inspectBundlePlugin("codex", root)).rejects.toThrow(/symlink/);
  });

  it("treats status 2 as a block and successful text output as a no-op", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "pre-block.mjs"),
      "console.error('blocked'); process.exit(2);",
    );
    await fs.writeFile(path.join(pluginRoot, "stop-block.mjs"), "process.exit(2);");
    await fs.writeFile(
      path.join(pluginRoot, "diagnostic.mjs"),
      "console.log('diagnostic');",
    );
    await fs.writeFile(path.join(pluginRoot, "fail.mjs"), "process.exit(1);");
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node pre-block.mjs" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node stop-block.mjs" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "node diagnostic.mjs" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "node fail.mjs" }] }],
      } }),
    );
    const config = { rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: fixtureTimeoutMs, env: {} };
    await expect(invokeBundleHooks(config, "PreToolUse", {}, "Read")).resolves.toEqual([]);
    await expect(invokeBundleHooks(config, "PreToolUse", {}, "Bash")).resolves.toEqual([
      { decision: "block", reason: "blocked" },
    ]);
    await expect(invokeBundleHooks(config, "SessionStart", {})).resolves.toEqual([]);
    await expect(invokeBundleHooks(config, "Stop", {})).resolves.toEqual([
      { decision: "block", reason: "Blocked by fixture Stop hook" },
    ]);
    await expect(invokeBundleHooks(config, "SessionEnd", {})).resolves.toEqual([]);
  });
});
