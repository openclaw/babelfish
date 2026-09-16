import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildNativeToolEntries, createNativeTools, normalizeMcpContent, regenerateNativeTools } from "./native-tools.js";

const fixtureTimeoutMs = 15_000;

async function copyFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
  await fs.cp(fixture, path.join(target, "simple"), { recursive: true });
}

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

async function writeNamedCliFixture(root: string, plugin: string, command: string): Promise<void> {
  const target = path.join(root, plugin);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "plugin.yaml"), `name: ${plugin}\nversion: 0.0.0\n`);
  await fs.writeFile(
    path.join(target, "__init__.py"),
    `def register(ctx):\n    ctx.register_cli_command('${command}', '${command}', lambda parser: None, lambda args: None, '${command}')\n`,
  );
}

async function writeNamedCommandFixture(root: string, plugin: string, command: string): Promise<void> {
  const target = path.join(root, plugin);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "plugin.yaml"), `name: ${plugin}\nversion: 0.0.0\n`);
  await fs.writeFile(
    path.join(target, "__init__.py"),
    `def register(ctx):\n    ctx.register_command('${command}', lambda raw: raw, '${command}')\n`,
  );
}

describe("native generated tools", () => {
  it("generates live MCP resource and prompt tools", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-mcp-state-"));
    const plugin = path.join(stateRoot, "codex", "fixture");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-package-"));
    const sdk = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    const sdkUrl = (file: string) => pathToFileURL(path.join(sdk, file)).href;
    await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { data: { command: "node", args: ["server.mjs"] } } }));
    await fs.writeFile(path.join(plugin, "server.mjs"), `
import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};
const server = new Server({name:"fixture",version:"1"},{capabilities:{tools:{},resources:{},prompts:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[]}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[{uri:"memo://one",name:"one"}]}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({contents:[{uri:"memo://one",text:"resource body"}]}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({prompts:[{name:"brief",description:"Brief prompt"}]}));
server.setRequestHandler(GetPromptRequestSchema, async () => ({messages:[{role:"user",content:{type:"text",text:"prompt body"}}]}));
await server.connect(new StdioServerTransport());
`);
    await fs.mkdir(path.join(root, "skills"));
    await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish", contracts: {} }));
    await regenerateNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: fixtureTimeoutMs, env: {} },
      { root },
    );
    const registry = JSON.parse(await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"));
    const tools = createNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: fixtureTimeoutMs, env: {} },
      registry.tools,
      {},
    );
    await expect(tools.find((tool) => tool.name.endsWith("resources_list"))?.execute("1", {}))
      .resolves.toMatchObject({ details: { resources: [{ uri: "memo://one" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("resource_read"))?.execute("2", { uri: "memo://one" }))
      .resolves.toMatchObject({ details: { contents: [{ text: "resource body" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("prompts_list"))?.execute("3", {}))
      .resolves.toMatchObject({ details: { prompts: [{ name: "brief" }] } });
    await expect(tools.find((tool) => tool.name.endsWith("prompt_get"))?.execute("4", { name: "brief" }))
      .resolves.toMatchObject({ details: { messages: [{ role: "user" }] } });
  }, 30_000);

  it("generates only operations advertised by each MCP server", async () => {
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-mcp-state-"));
    const plugin = path.join(stateRoot, "codex", "fixture");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-package-"));
    const sdk = path.join(process.cwd(), "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
    const sdkUrl = (file: string) => pathToFileURL(path.join(sdk, file)).href;
    await fs.mkdir(path.join(plugin, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));
    await fs.writeFile(
      path.join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tools: { command: "node", args: ["server.mjs", "tools"] },
          resources: { command: "node", args: ["server.mjs", "resources"] },
        },
      }),
    );
    await fs.writeFile(path.join(plugin, "server.mjs"), `
import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};
const mode = process.argv[2];
const capabilities = mode === "tools" ? {tools:{}} : {resources:{}};
const server = new Server({name:mode,version:"1"},{capabilities});
if (mode === "tools") {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:"echo",inputSchema:{type:"object"}}]}));
} else {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[{uri:"memo://one",name:"one"}]}));
  server.setRequestHandler(ReadResourceRequestSchema, async () => ({contents:[{uri:"memo://one",text:"resource body"}]}));
}
await server.connect(new StdioServerTransport());
`);
    await fs.mkdir(path.join(root, "skills"));
    await fs.writeFile(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: "babelfish", contracts: {} }));

    await regenerateNativeTools(
      { installDir: path.join(stateRoot, "hermes"), rootDir: stateRoot, python: "python3", timeoutMs: fixtureTimeoutMs, env: {} },
      { root },
    );

    const registry = JSON.parse(await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"));
    expect(
      registry.tools
        .map((tool: { server?: string; originalName: string }) => `${tool.server}:${tool.originalName}`)
        .sort(),
    ).toEqual([
      "resources:resources/list",
      "resources:resources/read",
      "tools:echo",
    ]);
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
        {
          key: "a.b",
          name: "A",
          version: "",
          description: "",
          path: "/tmp/hermes/a.b",
          tools: [
            {
              name: "shared",
              toolset: "a",
              description: "",
              schema: {},
              isAsync: false,
              requiresEnv: [],
              available: true,
            },
          ],
          hooks: [],
          middleware: [],
          commands: [],
          cliCommands: [],
          skills: [],
          auxiliaryTasks: [],
          unsupported: [],
        },
        {
          key: "a_b",
          name: "B",
          version: "",
          description: "",
          path: "/tmp/hermes/a_b",
          tools: [
            {
              name: "shared",
              toolset: "b",
              description: "",
              schema: {},
              isAsync: false,
              requiresEnv: [],
              available: true,
            },
            {
              name: "a_b__shared",
              toolset: "b",
              description: "",
              schema: {},
              isAsync: false,
              requiresEnv: [],
              available: true,
            },
          ],
          hooks: [],
          middleware: [],
          commands: [],
          cliCommands: [],
          skills: [],
          auxiliaryTasks: [],
          unsupported: [],
        },
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "a_b__shared",
      "a_b__shared_2",
      "a_b__shared_3",
    ]);
  });

  it("suffixes generated slash and CLI command names after sanitizing plugin slugs", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-commands-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
    await Promise.all([writeCommandFixture(installDir, "a.b"), writeCommandFixture(installDir, "a_b")]);
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: "hermes-plugin", contracts: {} }, null, 2),
    );

    await regenerateNativeTools(
      { installDir, python: "python3", timeoutMs: 10000, env: {} },
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

  it("reserves the Babelfish management CLI root", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-commands-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
    await writeNamedCliFixture(installDir, "client", "babelfish");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: "babelfish", contracts: {} }, null, 2),
    );

    await regenerateNativeTools(
      { installDir, python: "python3", timeoutMs: 10000, env: {} },
      { root },
    );
    const registry = JSON.parse(
      await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"),
    );
    expect(registry.cliCommands[0]?.name).toBe("babelfish_client_babelfish");
  });

  it("namespaces OpenClaw CLI roots", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-commands-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
    await writeNamedCliFixture(installDir, "client", "status");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: "babelfish", contracts: {} }, null, 2),
    );

    await regenerateNativeTools(
      { installDir, python: "python3", timeoutMs: 10000, env: {} },
      { root },
    );
    const registry = JSON.parse(
      await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"),
    );
    expect(registry.cliCommands[0]?.name).toBe("babelfish_client_status");
  });

  it("namespaces OpenClaw reserved slash commands", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-commands-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
    await writeNamedCommandFixture(installDir, "client", "status");
    await fs.mkdir(path.join(root, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({ id: "babelfish", contracts: {} }, null, 2),
    );

    await regenerateNativeTools(
      { installDir, python: "python3", timeoutMs: 10000, env: {} },
      { root },
    );
    const registry = JSON.parse(
      await fs.readFile(path.join(root, "babelfish.generated.json"), "utf8"),
    );
    expect(registry.commands[0]?.name).toBe("babelfish_client_status");
  });

  it("writes generated registry and OpenClaw manifest tool contracts", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-native-tools-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
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

    await expect(
      regenerateNativeTools(
        { installDir, python: "python3", timeoutMs: 10000, env: {} },
        { root },
      ),
    ).resolves.toEqual({
      generatedTools: ["simple_echo", "simple_optional", "simple_state"],
      restartRequired: true,
    });

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
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-native-tools-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-babelfish-package-"));
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
        { installDir, python: "python3", timeoutMs: 10000, env: {} },
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
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-bundle-state-"));
    const plugin = path.join(stateRoot, "claude-code", "fixture");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-package-"));
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
});
