import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyFixture, pluginSummary, toolSummary } from "../test/hermes-fixtures.js";
import * as hermes from "./hermes-python.js";
import { tempDir } from "../test/temp-dir.js";
import { buildNativeToolEntries, createNativeTools, normalizeMcpContent, readGeneratedNativeToolRegistry, regenerateNativeTools } from "./native-tools.js";

function sdkUrl(file: string): string {
  return import.meta.resolve(`@modelcontextprotocol/sdk/${file}`);
}

const fixtureTimeoutMs = 15_000;

async function writeCommandFixture(root: string, name: string): Promise<void> {
  const target = path.join(root, name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "plugin.yaml"), `name: ${name}\nversion: 0.0.0\n`);
  await fs.writeFile(
    path.join(target, "__init__.py"),
    [
      "def _handler(raw):",
      "    return raw",
      "",
      "def _setup(parser):",
      "    pass",
      "",
      "def register(ctx):",
      "    ctx.register_command('meet', _handler, 'Meet command')",
      "    ctx.register_cli_command('meet', 'Meet CLI', _setup, _handler, 'Meet CLI')",
      "",
    ].join("\n"),
  );
}

async function generateMcpFixture(servers: ("data" | "tools" | "resources")[]) {
  const stateRoot = await tempDir("babelfish-mcp-state-");
  const plugin = path.join(stateRoot, "codex", "fixture");
  const root = await tempDir("babelfish-package-");
  const config = { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: fixtureTimeoutMs, env: {} };
  await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
  await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
  const mcpServers = Object.fromEntries(servers.map((name) => [name, { command: "node", args: ["server.mjs", name] }]));
  await fs.writeFile(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers }));
  await fs.writeFile(path.join(plugin, "server.mjs"), `
import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};
const mode = process.argv[2];
const capabilities = mode === "data" ? { tools: {}, resources: {}, prompts: {} } : { [mode]: {} };
const server = new Server({name:mode,version:"1"},{capabilities});
if (capabilities.tools) {
  const tools = mode === "tools" ? [{name:"echo",inputSchema:{type:"object"}}] : [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools}));
  server.setRequestHandler(CallToolRequestSchema, async ({params}) => ({content:[{type:"text",text:params.arguments.text}]}));
}
if (capabilities.resources) {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[{uri:"memo://one",name:"one"}]}));
  server.setRequestHandler(ReadResourceRequestSchema, async ({params}) => ({contents:[{uri:params.uri,text:"resource body"}]}));
}
if (capabilities.prompts) {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({prompts:[{name:"brief",description:"Brief prompt"}]}));
  server.setRequestHandler(GetPromptRequestSchema, async ({params}) => ({messages:[{role:"user",content:{type:"text",text:params.name + ": " + params.arguments.topic}}]}));
}
await server.connect(new StdioServerTransport());
`);
  await fs.mkdir(path.join(root, "skills"));
  await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish", contracts: {} }));
  await regenerateNativeTools(config, { root });
  const registry = JSON.parse(await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"));
  return { config, registry };
}

describe("native generated tools", () => {
  it("generates live MCP resource and prompt tools", async () => {
    const { config, registry } = await generateMcpFixture(["data"]);
    const tools = createNativeTools(config, registry.tools, {});
    await expect(tools.find((tool) => tool.name.endsWith("resources_list"))?.execute("1", {}))
      .resolves.toMatchObject({ details: { resources: [{ uri: "memo://one" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("resource_read"))?.execute("2", { uri: "memo://two" }))
      .resolves.toMatchObject({ details: { contents: [{ uri: "memo://two", text: "resource body" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("prompts_list"))?.execute("3", {}))
      .resolves.toMatchObject({ details: { prompts: [{ name: "brief" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("prompt_get"))?.execute("4", { name: "brief", arguments: { topic: "release" } }))
      .resolves.toMatchObject({ details: { messages: [{ role: "user" }] } });
  }, 30_000);

  it("generates only operations advertised by each MCP server", async () => {
    const { config, registry } = await generateMcpFixture(["tools", "resources"]);
    expect(
      registry.tools
        .map((tool: { server?: string; originalName: string }) => `${tool.server}:${tool.originalName}`)
        .sort(),
    ).toEqual([
      "resources:resources/list",
      "resources:resources/read",
      "tools:echo",
    ]);
    const echo = createNativeTools(config, registry.tools, {}).find((tool) => tool.name === "echo");
    await expect(echo?.execute("1", { text: "hello" })).resolves.toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
  }, 30_000);

  it("maps MCP result blocks to OpenClaw text and image content", () => {
    expect(normalizeMcpContent([
      { type: "text", text: "ok" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "resource", resource: { text: "embedded" } },
      { type: "audio", data: "sound", mimeType: "audio/wav" },
    ])).toEqual([
      { type: "text", text: "ok" },
      { type: "image", data: "abc", mimeType: "image/png" },
      { type: "text", text: "embedded" },
      { type: "text", text: expect.stringContaining('"type": "audio"') },
    ]);
  });

  it("suffixes generated tool names that collide after sanitizing", () => {
    const tools = buildNativeToolEntries({
      installDir: "/tmp/hermes",
      plugins: [
        { ...pluginSummary("a.b", [toolSummary("shared")]), name: "A" },
        { ...pluginSummary("a_b", [toolSummary("shared"), toolSummary("a_b__shared")]), name: "B" },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "a_b__shared",
      "a_b__shared_2",
      "a_b__shared_3",
    ]);
  });

  it("suffixes generated slash and CLI command names after sanitizing plugin slugs", async () => {
    const installDir = await tempDir("openclaw-hermes-commands-");
    const root = await tempDir("openclaw-babelfish-package-");
    await Promise.all([writeCommandFixture(installDir, "a.b"), writeCommandFixture(installDir, "a_b")]);
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: "hermes-plugin", contracts: {} }, null, 2),
    );

    await regenerateNativeTools(
      { rootDir: root, installDir, python: "python3", timeoutMs: 10000, env: {} },
      { root },
    );

    const registry = JSON.parse(
      await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"),
    );
    expect(registry.commands.map((entry: { name: string }) => entry.name)).toEqual([
      "babelfish_a_b_meet",
      "babelfish_a_b_meet_2",
    ]);
    expect(registry.cliCommands.map((entry: { name: string }) => entry.name)).toEqual([
      "babelfish_a_b_meet",
      "babelfish_a_b_meet_2",
    ]);
  });

  it("namespaces reserved slash commands and CLI roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-reserved-commands-"));
    const installDir = path.join(root, "hermes");
    const plugin = path.join(installDir, "client");
    try {
      await fs.mkdir(plugin, { recursive: true });
      await fs.writeFile(path.join(plugin, "plugin.yaml"), "name: client\n");
      await fs.writeFile(path.join(plugin, "__init__.py"), [
        "def register(ctx):",
        "    ctx.register_command('status', lambda raw: raw, 'Status')",
        "    for name in ('babelfish', 'status'):",
        "        ctx.register_cli_command(name, name, lambda parser: None, lambda args: None, name)",
      ].join("\n"));
      await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish" }));
      await regenerateNativeTools({ rootDir: root, installDir, python: "python3", timeoutMs: fixtureTimeoutMs, env: {} }, { root });
      const registry = JSON.parse(await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"));
      expect(registry.commands.map((entry: { name: string }) => entry.name)).toEqual(["babelfish_client_status"]);
      expect(registry.cliCommands.map((entry: { name: string }) => entry.name)).toEqual([
        "babelfish_client_babelfish", "babelfish_client_status",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies the same defaults to missing and partial registries", async () => {
    const root = await tempDir("babelfish-registry-");
    const target = path.join(root, "babelfish.generated.json");
    const empty = readGeneratedNativeToolRegistry(root);
    expect(empty).toEqual({
      generatedAt: "", installDir: "", skillDirs: [], unsupported: [],
      tools: [], commands: [], cliCommands: [], outputStyles: [],
    });
    await fs.writeFile(target, JSON.stringify({ skillDirs: ["skills", false], tools: {}, commands: [null] }));
    expect(readGeneratedNativeToolRegistry(root)).toEqual({ ...empty, skillDirs: ["skills"] });
    const source = { app: "hermes", plugin: "sample", name: "echo", originalName: "echo", description: "" };
    const tool = { ...source, kind: "tool", inputSchema: {} };
    const command = { ...source, argsHint: "" };
    await fs.writeFile(target, JSON.stringify({
      tools: [tool, { ...tool, app: "invalid" }, { ...tool, inputSchema: [] }],
      commands: [command, { ...command, originalName: null }, { ...command, argsHint: false }],
      cliCommands: [command, { ...command, description: null }],
    }));
    expect(readGeneratedNativeToolRegistry(root)).toEqual({
      ...empty, tools: [tool], commands: [command], cliCommands: [command],
    });
    await fs.writeFile(target, "{");
    expect(() => readGeneratedNativeToolRegistry(root)).toThrow(SyntaxError);
  });

  it("writes generated registry and OpenClaw manifest tool contracts", async ({ onTestFinished }) => {
    const installDir = await tempDir("openclaw-babelfish-native-tools-");
    const root = await tempDir("openclaw-babelfish-package-");
    await copyFixture(installDir);
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "hermes-plugin",
          contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
        },
        null,
        2,
      ),
    );

    const discovery = vi.spyOn(hermes, "listHermesPlugins");
    onTestFinished(() => discovery.mockRestore());
    await expect(
      regenerateNativeTools(
        { rootDir: root, installDir, python: "python3", timeoutMs: 10000, env: {} },
        { root },
      ),
    ).resolves.toEqual({
      generatedTools: ["simple_echo", "simple_optional", "simple_state"],
      restartRequired: true,
    });
    expect(discovery).toHaveBeenCalledTimes(1);

    const manifest = JSON.parse(await fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
    expect(manifest.contracts).toEqual({
      agentToolResultMiddleware: ["openclaw", "codex"],
      tools: ["babelfish_plugins_list", "simple_echo", "simple_optional", "simple_state"],
    });
    const registry = JSON.parse(
      await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"),
    );
    expect(registry.tools.map((entry: { name: string }) => entry.name)).toEqual([
      "simple_echo",
      "simple_optional",
      "simple_state",
    ]);
    expect(registry.commands).toEqual([
      {
        app: "hermes",
        name: "simple",
        plugin: "simple",
        originalName: "simple",
        description: "Simple command",
        argsHint: "<raw text>",
      },
    ]);
    expect(registry.cliCommands).toEqual([
      {
        app: "hermes",
        name: "simplecli",
        plugin: "simple",
        originalName: "simplecli",
        description: "Simple CLI command",
        argsHint: "",
      },
    ]);
    await expect(
      fs.readFile(
        path.join(root, "skills", "babelfish-generated", "babelfish-simple-simple_skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("Simple Skill");
  });

  it("keeps generated contracts when an installed plugin fails to load", async () => {
    const installDir = await tempDir("openclaw-babelfish-native-tools-");
    const root = await tempDir("openclaw-babelfish-package-");
    const broken = path.join(installDir, "broken");
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, "plugin.yaml"), "name: broken\n");
    await fs.writeFile(path.join(broken, "__init__.py"), "raise RuntimeError('broken')\n");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    const manifest = '{"id":"babelfish","contracts":{"tools":["existing"]}}\n';
    const registry = '{"generatedAt":"old","installDir":"old","tools":[],"commands":[],"cliCommands":[]}\n';
    await fs.writeFile(path.join(root, "openclaw.plugin.json"), manifest);
    await fs.writeFile(path.join(root, "babelfish.generated.json"), registry);

    await expect(
      regenerateNativeTools(
        { rootDir: root, installDir, python: "python3", timeoutMs: 10000, env: {} },
        { root },
      ),
    ).rejects.toThrow("broken");
    await expect(fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8")).resolves.toBe(
      manifest,
    );
    await expect(fs.readFile(path.join(root, "babelfish.generated.json"), "utf8")).resolves.toBe(
      registry,
    );
  });

  it.each(["\n", "\r\n"])("preserves skill and command frontmatter with %j line endings", async (eol) => {
    const stateRoot = await tempDir("babelfish-bundle-state-");
    const plugin = path.join(stateRoot, "claude-code", "fixture");
    const root = await tempDir("babelfish-package-");
    await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
    await fs.mkdir(path.join(plugin, "skills", "review"), { recursive: true });
    await fs.writeFile(path.join(plugin, "skills", "review", "SKILL.md"), ["---", "name: review", "description: review", "allowed-tools: Read", "---"].join(eol));
    await fs.mkdir(path.join(plugin, "commands", "git"), { recursive: true });
    await fs.writeFile(
      path.join(plugin, "commands", "git", "commit.md"),
      ["---", "description: Commit selected files", "argument-hint: '[files]'", "allowed-tools: Bash(git status *)", "---", "Commit $ARGUMENTS."].join(eol),
    );
    await fs.mkdir(path.join(root, "skills"));
    await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish", contracts: {} }));
    await regenerateNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: 1000, env: {} },
      { root },
    );
    await expect(fs.readFile(path.join(root, "skills", "babelfish-bundles", "claude-code-fixture-review", "SKILL.md"), "utf8"))
      .resolves.toBe("---\nname: claude-code-fixture-review\ndescription: review\nallowed-tools: Read\n---\n");
    await expect(fs.readFile(path.join(root, "skills", "babelfish-bundles", "claude-code-fixture-git-commit", "SKILL.md"), "utf8"))
      .resolves.toMatch(/description: "Commit selected files"[\s\S]*argument-hint: '\[files\]'[\s\S]*allowed-tools: Bash\(git status \*\)[\s\S]*disable-model-invocation: true[\s\S]*Commit \$ARGUMENTS\./);
  });

  it.each(["\n", "\r\n"])("reads block descriptions from commands, agents and output styles with %j", async (eol) => {
    const stateRoot = await tempDir("babelfish-bundle-state-");
    const plugin = path.join(stateRoot, "claude-code", "fixture");
    const root = await tempDir("babelfish-package-");
    await fs.mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
    await fs.mkdir(path.join(plugin, "commands"), { recursive: true });
    await fs.writeFile(path.join(plugin, "commands", "commit.md"), [
      "---",
      "description: |2+ # literal",
      "  Commit the selected files",
      "  after reviewing the diff.",
      "",
      "argument-hint: '[files]'",
      "---",
      "Commit $ARGUMENTS.",
      "",
    ].join(eol));
    await fs.mkdir(path.join(plugin, "agents"), { recursive: true });
    await fs.writeFile(path.join(plugin, "agents", "reviewer.md"), [
      "---",
      "name: Reviewer",
      "description: >- # folded",
      "  Review the change",
      "  for regressions.",
      "    Keep code indented.",
      "",
      "",
      "  Final paragraph.",
      "---",
      "Look carefully.",
      "",
    ].join(eol));
    await fs.mkdir(path.join(plugin, "output-styles"));
    await fs.writeFile(path.join(plugin, "output-styles", "brief.md"), [
      "---", "name: Brief", "description: > # clipped", "  Keep replies", "  short.",
      "keep-coding-instructions: true", "---", "Answer briefly.", "",
    ].join(eol));
    await fs.mkdir(path.join(plugin, "skills", "copied"), { recursive: true });
    const copied = ["---", "name: copied", "description: |+", "  Keep this scalar.", "", "---", "  Body.", ""].join(eol);
    await fs.writeFile(path.join(plugin, "skills", "copied", "SKILL.md"), copied);
    await fs.writeFile(path.join(plugin, "skills", "copied", "asset.txt"), "support bytes");
    await fs.mkdir(path.join(root, "skills"));
    await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish", contracts: {} }));
    await regenerateNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: 1000, env: {} },
      { root },
    );
    const command = await fs.readFile(
      path.join(root, "skills", "babelfish-bundles", "claude-code-fixture-commit", "SKILL.md"),
      "utf8",
    );
    expect(command).toContain('description: "Commit the selected files\\nafter reviewing the diff.\\n\\n"');
    expect(command).toContain("argument-hint: '[files]'");
    expect(command).not.toContain("description: \"|\"");
    expect(command).not.toMatch(/^ {2}Commit the selected files$/m);
    expect(command).toContain("Commit $ARGUMENTS.");
    const agent = await fs.readFile(
      path.join(root, "skills", "babelfish-bundles", "claude-code-fixture-reviewer", "SKILL.md"),
      "utf8",
    );
    expect(agent).toContain('description: "Review the change for regressions.\\n  Keep code indented.\\n\\n\\nFinal paragraph."');
    expect(agent).not.toMatch(/^ {2}Review the change$/m);
    expect(agent).toContain("Look carefully.");
    const generated = JSON.parse(await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"));
    expect(generated.outputStyles).toMatchObject([{
      description: "Keep replies short.\n", keepCodingInstructions: true, instructions: "Answer briefly.",
    }]);
    const skills = path.join(root, "skills", "babelfish-bundles");
    await expect(fs.readFile(path.join(skills, "claude-code-fixture-brief", "SKILL.md"), "utf8"))
      .resolves.toContain('description: "Keep replies short.\\n"');
    const copiedSkill = await fs.readFile(path.join(skills, "claude-code-fixture-copied", "SKILL.md"), "utf8");
    expect(copiedSkill).toContain("description: |+\n  Keep this scalar.\n\n---\n");
    expect(copiedSkill).toContain(`  Body.${eol}`);
    await expect(fs.readFile(path.join(skills, "claude-code-fixture-copied", "asset.txt"), "utf8"))
      .resolves.toBe("support bytes");
    const beforeManifest = await fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8");
    const beforeRegistry = await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8");
    await fs.writeFile(path.join(plugin, "commands", "commit.md"), "---\ndescription: |12\n  invalid\n---\n");
    await expect(regenerateNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: 1000, env: {} },
      { root },
    )).rejects.toThrow("Invalid block scalar header");
    await expect(fs.readFile(path.join(root, "openclaw.plugin.json"), "utf8")).resolves.toBe(beforeManifest);
    await expect(fs.readFile(path.join(root, "babelfish.generated.json"), "utf8")).resolves.toBe(beforeRegistry);
    await expect(fs.readFile(path.join(skills, "claude-code-fixture-copied", "SKILL.md"), "utf8")).resolves.toBe(copiedSkill);
  });
});
