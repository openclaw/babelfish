import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hookAdditionalContext,
  hookBlock,
  hookUpdatedInput,
  inspectBundlePlugin,
  inspectBundleServer,
  invokeBundleHooks,
  type BundlePlugin,
  type BundleServer,
  MAX_HOOK_JSON_FILES,
  MAX_HOOK_WALK_DEPTH,
} from "./bundle-plugins.js";

const fixtureTimeoutMs = 15_000;

function hookPayloadWithByteSize(bytes: number): Record<string, unknown> {
  const overhead = Buffer.byteLength('{"tool_response":""}', "utf8");
  return { tool_response: "x".repeat(bytes - overhead) };
}

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
  it.each(["claude-code", "codex"] as const)("accepts %s skill directories beginning with two dots", async (app) => {
    const root = await fixture(app);
    try {
      await fs.rename(path.join(root, "skills"), path.join(root, "..skills"));
      const manifestDir = app === "codex" ? ".codex-plugin" : ".claude-plugin";
      await fs.writeFile(path.join(root, manifestDir, "plugin.json"), JSON.stringify({ skills: "./..skills" }));
      const plugin = await inspectBundlePlugin(app, root);
      expect(plugin.skillDirs).toEqual([await fs.realpath(path.join(root, "..skills"))]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["..", "../outside"])("rejects a skill root outside the plugin: %s", async (skills) => {
    const root = await fixture("codex");
    try {
      await fs.writeFile(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ skills }));
      await expect(inspectBundlePlugin("codex", root)).rejects.toThrow("Plugin path escapes its root");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["claude-code", "codex"] as const)("discovers %s skills and command hooks", async (app) => {
    const root = await fixture(app);
    const plugin = await inspectBundlePlugin(app, root);
    expect(plugin.skillDirs).toEqual([await fs.realpath(path.join(root, "skills"))]);
    expect(plugin.hooks).toMatchObject([{ event: "SessionStart", command: "node hook.mjs" }]);
  });

  it("discovers exec-form command hooks from args and command arrays", async () => {
    const root = await fixture("claude-code");
    await fs.writeFile(
      path.join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node", args: ["hook.mjs"] }] }],
          SessionEnd: [{ hooks: [{ type: "command", command: ["node", "hook.mjs", "done"] }] }],
        },
      }),
    );
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.hooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "SessionStart", command: "node", args: ["hook.mjs"] }),
      expect.objectContaining({ event: "SessionEnd", command: "node", args: ["hook.mjs", "done"] }),
    ]));
  });

  it("executes argv command hooks without a shell", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "argv-hook.mjs"),
      "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:process.argv.slice(2).join('\\0')}})));",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{
            type: "command",
            command: "node",
            args: ["${PLUGIN_ROOT}/argv-hook.mjs", "$(echo INJECTED)"],
          }] }],
        },
      }),
    );
    const results = await invokeBundleHooks(
      { rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: fixtureTimeoutMs, env: {} },
      "SessionStart",
      {},
    );
    expect(results.map(hookAdditionalContext)).toEqual(["$(echo INJECTED)"]);
  }, 30_000);

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

  it("rejects hooks whose stdin payload exceeds 1 MiB", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    const marker = path.join(pluginRoot, "ran.txt");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "reader.mjs"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ok:true})));`,
    );
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "node reader.mjs" }] }],
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
      await expect(invokeBundleHooks(config, "PostToolUse", hookPayloadWithByteSize(1024 * 1024 + 1))).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("1048576-byte payload limit"));
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  it("runs hooks whose stdin payload is exactly 1 MiB", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
    const pluginRoot = path.join(rootDir, "codex", "fixture");
    await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "reader.mjs"),
      "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'ok'}})));",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: "command", command: "node reader.mjs" }] }],
        },
      }),
    );
    const config = {
      rootDir,
      installDir: path.join(rootDir, "hermes"),
      python: "python3",
      timeoutMs: fixtureTimeoutMs,
      env: {},
    };
    await expect(
      invokeBundleHooks(config, "PostToolUse", hookPayloadWithByteSize(1024 * 1024)),
    ).resolves.toEqual([{ hookSpecificOutput: { additionalContext: "ok" } }]);
  }, 30_000);

  it.each(["PreToolUse", "UserPromptSubmit", "Stop"] as const)(
    "blocks %s when stdin exceeds 1 MiB instead of skipping the decision",
    async (event) => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-root-"));
      const pluginRoot = path.join(rootDir, "codex", "fixture");
      const marker = path.join(pluginRoot, "ran.txt");
      await fs.mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginRoot, "reader.mjs"),
        `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran"); process.exit(0);`,
      );
      await fs.writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({
          hooks: {
            [event]: [{ hooks: [{ type: "command", command: "node reader.mjs" }] }],
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
        await expect(
          invokeBundleHooks(config, event, hookPayloadWithByteSize(1024 * 1024 + 1)),
        ).resolves.toEqual([
          {
            decision: "block",
            reason: expect.stringContaining("1048576-byte payload limit"),
          },
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("1048576-byte payload limit"));
        await expect(fs.access(marker)).rejects.toThrow();
      } finally {
        warn.mockRestore();
      }
    },
  );

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
      }, "PreToolUse", { tool_input: { text: "x".repeat(512 * 1024) } });
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

  it("reads a folded output-style description", async () => {
    const root = await fixture("claude-code");
    await fs.mkdir(path.join(root, "output-styles"));
    await fs.writeFile(path.join(root, "output-styles", "brief.md"), [
      "---",
      "name: Brief",
      "description: >",
      "  Keep replies short",
      "  and specific.",
      "keep-coding-instructions: true",
      "---",
      "Answer in three sentences.",
      "",
    ].join("\n"));
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.outputStyles).toEqual([{
      name: "Brief",
      description: "Keep replies short and specific.\n",
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
  }, 30_000); // Four Windows supervisor launches can exceed Vitest's default deadline.

  it("rejects a hook directory with more than 50 JSON files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-files-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "too-many-hooks", hooks: "./hooks" }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    for (let index = 0; index < MAX_HOOK_JSON_FILES + 1; index += 1) {
      await fs.writeFile(
        path.join(hooksDir, `hook-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    await expect(inspectBundlePlugin("codex", root)).rejects.toThrow(
      `Plugin hook tree exceeded the ${MAX_HOOK_JSON_FILES}-file limit`,
    );
  });

  it("loads a hook directory at the 50-file cap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-cap-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "hook-file-cap", hooks: "./hooks" }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    for (let index = 0; index < MAX_HOOK_JSON_FILES; index += 1) {
      await fs.writeFile(
        path.join(hooksDir, `hook-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.hooks).toHaveLength(MAX_HOOK_JSON_FILES);
  });

  it("counts conventional hooks.json once when the declared hooks directory also contains it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-conventional-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".claude-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "conventional-plus-dir", hooks: "./hooks" }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    await fs.writeFile(path.join(hooksDir, "hooks.json"), JSON.stringify({ hooks: hook }));
    for (let index = 1; index < MAX_HOOK_JSON_FILES; index += 1) {
      await fs.writeFile(
        path.join(hooksDir, `hook-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    const plugin = await inspectBundlePlugin("claude-code", root);
    expect(plugin.hooks).toHaveLength(MAX_HOOK_JSON_FILES);
  });

  it("charges overlapping Codex hook paths once at the 50-file cap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-overlap-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "overlap-cap", hooks: ["hooks/hooks.json", "./hooks"] }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    await fs.writeFile(path.join(hooksDir, "hooks.json"), JSON.stringify({ hooks: hook }));
    for (let index = 1; index < MAX_HOOK_JSON_FILES; index += 1) {
      await fs.writeFile(
        path.join(hooksDir, `hook-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.hooks).toHaveLength(MAX_HOOK_JSON_FILES);
  });

  it("still rejects overlapping Codex hook paths that exceed 50 unique files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-overlap-over-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "overlap-over", hooks: ["hooks/hooks.json", "./hooks"] }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    await fs.writeFile(path.join(hooksDir, "hooks.json"), JSON.stringify({ hooks: hook }));
    for (let index = 1; index < MAX_HOOK_JSON_FILES + 1; index += 1) {
      await fs.writeFile(
        path.join(hooksDir, `hook-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    await expect(inspectBundlePlugin("codex", root)).rejects.toThrow(
      `Plugin hook tree exceeded the ${MAX_HOOK_JSON_FILES}-file limit`,
    );
  });

  it("shares the 50-file cap across declared hook directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-shared-"));
    const firstDir = path.join(root, "hooks-a");
    const secondDir = path.join(root, "hooks-b");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(firstDir, { recursive: true });
    await fs.mkdir(secondDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "shared-cap", hooks: ["./hooks-a", "./hooks-b"] }),
    );
    const hook = { SessionStart: [{ hooks: [{ type: "command", command: "exit 0" }] }] };
    const perDir = Math.ceil((MAX_HOOK_JSON_FILES + 1) / 2);
    for (let index = 0; index < perDir; index += 1) {
      await fs.writeFile(
        path.join(firstDir, `a-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
      await fs.writeFile(
        path.join(secondDir, `b-${String(index).padStart(2, "0")}.json`),
        JSON.stringify({ hooks: hook }),
      );
    }
    await expect(inspectBundlePlugin("codex", root)).rejects.toThrow(
      `Plugin hook tree exceeded the ${MAX_HOOK_JSON_FILES}-file limit`,
    );
  });

  it("walks a wide non-JSON directory without loading it as one array", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-wide-"));
    const hooksDir = path.join(root, "hooks");
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "wide-hooks", hooks: "./hooks" }),
    );
    for (let index = 0; index < 80; index += 1) {
      await fs.writeFile(path.join(hooksDir, `noise-${String(index).padStart(2, "0")}.txt`), "x");
    }
    await fs.writeFile(
      path.join(hooksDir, "session.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "exit 0" }] }] } }),
    );
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.hooks).toEqual([expect.objectContaining({ event: "SessionEnd" })]);
  });

  it("rejects a hook directory deeper than 8 levels", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-depth-"));
    const segments = Array.from({ length: MAX_HOOK_WALK_DEPTH + 1 }, (_, index) => `d${index}`);
    const deepDir = path.join(root, "hooks", ...segments);
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "deep-hooks", hooks: "./hooks" }),
    );
    await fs.writeFile(
      path.join(deepDir, "session.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "exit 0" }] }] } }),
    );
    await expect(inspectBundlePlugin("codex", root)).rejects.toThrow(
      `Plugin hook tree exceeded the ${MAX_HOOK_WALK_DEPTH}-directory depth limit`,
    );
  });

  it("loads a hook file at the 8-directory depth cap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-hooks-depth-ok-"));
    const segments = Array.from({ length: MAX_HOOK_WALK_DEPTH }, (_, index) => `d${index}`);
    const deepDir = path.join(root, "hooks", ...segments);
    await fs.mkdir(path.join(root, ".codex-plugin"), { recursive: true });
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(
      path.join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "depth-ok", hooks: "./hooks" }),
    );
    await fs.writeFile(
      path.join(deepDir, "session.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "exit 0" }] }] } }),
    );
    const plugin = await inspectBundlePlugin("codex", root);
    expect(plugin.hooks).toEqual([expect.objectContaining({ event: "SessionEnd" })]);
  });
});

function bundlePlugin(root: string): BundlePlugin {
  return {
    app: "codex",
    key: "fixture",
    name: "fixture",
    version: "1",
    description: "",
    path: root,
    skillDirs: [],
    servers: [],
    hooks: [],
    outputStyles: [],
    monitors: [],
    unsupported: [],
  };
}

async function writePagerServer(
  root: string,
  mode: "repeat" | "increment" | "two-page" | "slow-increment" | "fifty-page",
): Promise<BundleServer> {
  const sdk = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const sdkUrl = (file: string) => pathToFileURL(path.join(sdk, file)).href;
  await fs.writeFile(
    path.join(root, "pager.mjs"),
    `import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { ListToolsRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};
const mode = ${JSON.stringify(mode)};
let page = 0;
const server = new Server({name:"pager",version:"1"},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  page += 1;
  const tool = {name: "tool-" + page, inputSchema: {type: "object"}};
  if (mode === "repeat") {
    return {tools: [tool], nextCursor: "same"};
  }
  if (mode === "increment" || mode === "slow-increment" || mode === "fifty-page") {
    if (mode === "slow-increment") {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return {tools: [tool], ...(mode === "fifty-page" && page === 50 ? {} : {nextCursor: "page-" + page})};
  }
  const cursor = request.params?.cursor;
  if (!cursor) {
    return {tools: [{name: "alpha", inputSchema: {type: "object"}}], nextCursor: "p2"};
  }
  return {tools: [{name: "beta", inputSchema: {type: "object"}}]};
});
await server.connect(new StdioServerTransport());
`,
  );
  return {
    name: "pager",
    config: { command: "node", args: ["pager.mjs"] },
    baseDir: root,
  };
}

describe("inspectBundleServer tools/list pagination", () => {
  const roots: string[] = [];
  async function pagerRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-pager-"));
    roots.push(root);
    return root;
  }
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("collects tools across a finite cursor page", async () => {
    const root = await pagerRoot();
    const server = await writePagerServer(root, "two-page");
    const inspection = await inspectBundleServer(bundlePlugin(root), server, 10_000);
    expect(inspection.tools.map((tool) => tool.name)).toEqual(["alpha", "beta"]);
  }, 15_000);

  it("accepts a listing ending on the fiftieth page", async () => {
    const root = await pagerRoot();
    const server = await writePagerServer(root, "fifty-page");
    const inspection = await inspectBundleServer(bundlePlugin(root), server, 10_000);
    expect(inspection.tools).toHaveLength(50);
    expect(inspection.tools.at(-1)?.name).toBe("tool-50");
  }, 15_000);

  it("rejects a repeated tools/list cursor", { timeout: 8_000 }, async () => {
    const root = await pagerRoot();
    const server = await writePagerServer(root, "repeat");
    await expect(inspectBundleServer(bundlePlugin(root), server, 10_000)).rejects.toThrow(
      /repeated cursor/i,
    );
  });

  it("caps tools/list pagination before a unique-cursor loop can grow", { timeout: 8_000 }, async () => {
    const root = await pagerRoot();
    const server = await writePagerServer(root, "increment");
    await expect(inspectBundleServer(bundlePlugin(root), server, 10_000)).rejects.toThrow(
      /50 pages/i,
    );
  });

  it("shares one deadline across tools/list pages", { timeout: 8_000 }, async () => {
    const root = await pagerRoot();
    const server = await writePagerServer(root, "slow-increment");
    await expect(inspectBundleServer(bundlePlugin(root), server, 1_000)).rejects.toThrow(
      /timed out/i,
    );
  });
});
