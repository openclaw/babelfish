import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_APPS, type BabelfishConfig, type SupportedApp } from "./config.js";
import {
  callBundleMcp,
  callBundleTool,
  inspectBundleServer,
  listBundlePlugins,
  summarizeBundlePlugin,
  type BundlePlugin,
} from "./bundle-plugins.js";
import {
  callHermesTool,
  listHermesPlugins,
  type HermesCommandSummary,
  type HermesListResult,
  type HermesRuntimeContext,
  type HermesToolSummary,
} from "./hermes-python.js";
import { syncHermesSkills } from "./skill-sync.js";
import { splitFrontmatter } from "./markdown.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const generatedRegistryFile = "babelfish.generated.json";

export const NATIVE_BRIDGE_TOOL_NAMES = ["babelfish_plugins_list"] as const;

const OPENCLAW_RESERVED_COMMANDS = [
  "help", "commands", "status", "diagnostics", "codex", "whoami", "context", "btw",
  "stop", "restart", "reset", "new", "compact", "config", "debug", "allowlist",
  "activation", "skill", "subagents", "kill", "steer", "tell", "model", "models",
  "queue", "send", "bash", "exec", "think", "verbose", "reasoning", "elevated", "usage",
];

const OPENCLAW_CLI_ROOTS = [
  "crestodian", "setup", "onboard", "configure", "config", "backup", "migrate", "doctor",
  "dashboard", "reset", "uninstall", "message", "mcp", "transcripts", "agent", "agents",
  "status", "health", "sessions", "commitments", "tasks", "acp", "gateway", "daemon", "logs",
  "system", "models", "infer", "capability", "approvals", "exec-policy", "nodes", "devices",
  "node", "sandbox", "tui", "terminal", "chat", "cron", "dns", "docs", "qa", "proxy",
  "hooks", "webhooks", "qr", "clawbot", "pairing", "plugins", "channels", "directory",
  "security", "secrets", "skills", "update", "completion", "babelfish",
];

type JsonObject = Record<string, unknown>;

export type NativeToolContext = {
  workspaceDir?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  modelId?: string;
  modelProviderId?: string;
  activeModel?: {
    provider?: string;
    modelId?: string;
    modelRef?: string;
  };
};

export type NativeTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ content: unknown[]; details?: unknown }>;
};

export type NativeToolEntry = {
  kind: "tool";
  app: SupportedApp;
  name: string;
  plugin: string;
  originalName: string;
  description: string;
  inputSchema: JsonObject;
  server?: string;
  mcpOperation?: "listResources" | "readResource" | "listPrompts" | "getPrompt";
};

export type GeneratedCommandEntry = {
  app: SupportedApp;
  name: string;
  plugin: string;
  originalName: string;
  description: string;
  argsHint: string;
};

export type GeneratedOutputStyleEntry = {
  name: string;
  plugin: string;
  description: string;
  instructions: string;
  keepCodingInstructions: boolean;
};

export type GeneratedNativeToolRegistry = {
  generatedAt: string;
  installDir: string;
  skillDirs: string[];
  unsupported: Array<{ app: SupportedApp; plugin: string; surface: string }>;
  tools: NativeToolEntry[];
  commands: GeneratedCommandEntry[];
  cliCommands: GeneratedCommandEntry[];
  outputStyles: GeneratedOutputStyleEntry[];
};

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "plugin";
}

function skillSlug(value: string): string {
  return sanitizeName(value).replaceAll("_", "-").toLowerCase();
}

function stringifyResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function supportedApp(value: unknown): SupportedApp {
  if (value === "hermes" || value === "claude-code" || value === "codex") {
    return value;
  }
  throw new Error(`Unsupported app: ${String(value || "(missing)")}`);
}

function isSupportedApp(value: unknown): value is SupportedApp {
  return SUPPORTED_APPS.includes(value as SupportedApp);
}

function result(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: stringifyResult(value) }], details: value };
}

function inputSchemaFor(tool: HermesToolSummary): JsonObject {
  const schema = asObject(tool.schema);
  const parameters = asObject(schema?.parameters) ?? asObject(asObject(schema?.function)?.parameters);
  if (parameters?.type === "object") {
    return parameters;
  }
  if (schema?.type === "object") {
    return schema;
  }
  return { type: "object", additionalProperties: true };
}

function generatedToolName(params: {
  plugin: string;
  tool: string;
  duplicates: Set<string>;
}): string {
  if (
    !params.duplicates.has(params.tool) &&
    !NATIVE_BRIDGE_TOOL_NAMES.includes(params.tool as (typeof NATIVE_BRIDGE_TOOL_NAMES)[number])
  ) {
    return params.tool;
  }
  return `${sanitizeName(params.plugin)}__${sanitizeName(params.tool)}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function uniqueSkillName(base: string, used: Set<string>): string {
  let candidate = base.replaceAll("_", "-");
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.replaceAll("_", "-")}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function commandBaseName(command: string): string {
  return sanitizeName(command).replace(/^[^A-Za-z]+/, "").toLowerCase();
}

function commandName(params: { plugin: string; command: string; duplicates: Set<string> }): string {
  const cleaned = commandBaseName(params.command);
  const fallback = `babelfish_${sanitizeName(params.plugin)}_${sanitizeName(params.command)}`.toLowerCase();
  const base = cleaned || fallback;
  if (!params.duplicates.has(base)) {
    return base;
  }
  return fallback;
}

export function buildNativeToolEntries(list: HermesListResult): NativeToolEntry[] {
  const counts = new Map<string, number>();
  for (const plugin of list.plugins) {
    for (const tool of plugin.tools) {
      if (tool.available) {
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
      }
    }
  }
  const duplicates = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );
  const entries: NativeToolEntry[] = [];
  const usedNames = new Set<string>(NATIVE_BRIDGE_TOOL_NAMES);

  for (const plugin of list.plugins) {
    for (const tool of plugin.tools) {
      if (!tool.available) {
        continue;
      }
      entries.push({
        kind: "tool",
        app: "hermes",
        name: uniqueName(
          generatedToolName({ plugin: plugin.key, tool: tool.name, duplicates }),
          usedNames,
        ),
        plugin: plugin.key,
        originalName: tool.name,
        description: tool.description || `Plugin tool ${plugin.key}/${tool.name}`,
        inputSchema: inputSchemaFor(tool),
      });
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function buildCommandEntries(
  list: HermesListResult,
  select: (plugin: HermesListResult["plugins"][number]) => HermesCommandSummary[],
  reservedNames: string[] = [],
): GeneratedCommandEntry[] {
  const counts = new Map<string, number>();
  for (const plugin of list.plugins) {
    for (const command of select(plugin)) {
      if (command.available) {
        const key = commandBaseName(command.name) || `${plugin.key}/${command.name}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const duplicates = new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );
  for (const name of reservedNames) {
    duplicates.add(name);
  }
  const usedNames = new Set(reservedNames);
  return list.plugins.flatMap((plugin) =>
    select(plugin)
      .filter((entry) => entry.available)
      .map((entry) => ({
        app: "hermes" as const,
        name: uniqueName(
          commandName({ plugin: plugin.key, command: entry.name, duplicates }),
          usedNames,
        ),
        plugin: plugin.key,
        originalName: entry.name,
        description: entry.description || `Run plugin command ${plugin.key}/${entry.name}`,
        argsHint: entry.argsHint,
      })),
  ).sort((a, b) => a.name.localeCompare(b.name));
}

function registryPath(root = packageRoot): string {
  return path.join(root, generatedRegistryFile);
}

function manifestPath(root = packageRoot): string {
  return path.join(root, "openclaw.plugin.json");
}

export function readGeneratedNativeToolRegistry(root = packageRoot): GeneratedNativeToolRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(root), "utf8")) as Partial<GeneratedNativeToolRegistry>;
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
      installDir: typeof parsed.installDir === "string" ? parsed.installDir : "",
      skillDirs: Array.isArray(parsed.skillDirs)
        ? parsed.skillDirs.filter((entry): entry is string => typeof entry === "string")
        : [],
      unsupported: Array.isArray(parsed.unsupported)
        ? parsed.unsupported.filter(isUnsupportedEntry)
        : [],
      tools: Array.isArray(parsed.tools) ? parsed.tools.filter(isNativeToolEntry) : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter(isCommandEntry) : [],
      cliCommands: Array.isArray(parsed.cliCommands)
        ? parsed.cliCommands.filter(isCommandEntry)
        : [],
      outputStyles: Array.isArray(parsed.outputStyles)
        ? parsed.outputStyles.filter(isOutputStyleEntry)
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {
      generatedAt: "",
      installDir: "",
      skillDirs: [],
      unsupported: [],
      tools: [],
      commands: [],
      cliCommands: [],
      outputStyles: [],
    };
  }
}

function isOutputStyleEntry(value: unknown): value is GeneratedOutputStyleEntry {
  const item = asObject(value);
  return typeof item?.name === "string" && typeof item.plugin === "string"
    && typeof item.description === "string" && typeof item.instructions === "string"
    && typeof item.keepCodingInstructions === "boolean";
}

function isNativeToolEntry(value: unknown): value is NativeToolEntry {
  const item = asObject(value);
  return (
    item?.kind === "tool" &&
    isSupportedApp(item.app) &&
    typeof item.name === "string" &&
    typeof item.plugin === "string" &&
    typeof item.originalName === "string" &&
    typeof item.description === "string" &&
    asObject(item.inputSchema) !== undefined
  );
}

function isUnsupportedEntry(
  value: unknown,
): value is GeneratedNativeToolRegistry["unsupported"][number] {
  const item = asObject(value);
  return Boolean(
    item && isSupportedApp(item.app) && typeof item.plugin === "string" && typeof item.surface === "string",
  );
}

function isCommandEntry(value: unknown): value is GeneratedCommandEntry {
  const item = asObject(value);
  return (
    typeof item?.name === "string" &&
    isSupportedApp(item.app) &&
    typeof item.plugin === "string" &&
    typeof item.originalName === "string" &&
    typeof item.description === "string" &&
    typeof item.argsHint === "string"
  );
}

async function writeManifest(names: string[], skillDirs: string[], root: string): Promise<void> {
  const target = manifestPath(root);
  const manifest = JSON.parse(await fsp.readFile(target, "utf8")) as JsonObject;
  const contracts = asObject(manifest.contracts) ?? {};
  contracts.tools = names;
  manifest.contracts = contracts;
  manifest.skills = ["skills", ...skillDirs];
  await fsp.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readOptionalFile(target: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function restoreFile(target: string, contents: string | undefined): Promise<void> {
  if (contents === undefined) {
    await fsp.rm(target, { force: true });
  } else {
    await fsp.writeFile(target, contents);
  }
}

function convertedSkillMarkdown(name: string, source: string): string {
  let body = source;
  let description = `Imported plugin command ${name}`;
  let preserved: string[] = [];
  const parsed = splitFrontmatter(source);
  if (parsed) {
    const { frontmatter } = parsed;
    const match = frontmatter.match(/^description:\s*(.+)$/m);
    if (match?.[1]) {
      description = match[1].trim().replace(/^['"]|['"]$/g, "");
    }
    preserved = frontmatter
      .split("\n")
      .filter((line) => !/^(name|description|disable-model-invocation):/i.test(line));
    body = parsed.body;
  }
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    ...preserved,
    "disable-model-invocation: true",
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function renamedSkillMarkdown(name: string, source: string): string {
  const parsed = splitFrontmatter(source);
  if (!parsed) {
    return convertedSkillMarkdown(name, source);
  }
  const { frontmatter } = parsed;
  const renamed = /^name:/m.test(frontmatter)
    ? frontmatter.replace(/^name:.*$/m, `name: ${name}`)
    : `name: ${name}\n${frontmatter}`;
  return `---\n${renamed}\n---\n${parsed.body}`;
}

async function copySkillDirectory(source: string, target: string, name: string): Promise<void> {
  await assertNoSymlinks(source);
  await fsp.cp(source, target, { recursive: true });
  const skillFile = path.join(target, "SKILL.md");
  await fsp.writeFile(
    skillFile,
    renamedSkillMarkdown(name, await fsp.readFile(skillFile, "utf8")),
  );
}

async function assertNoSymlinks(root: string): Promise<void> {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Imported skill tree contains a symlink: ${target}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(target);
    }
  }
}

async function importSkillEntries(
  sourceRoot: string,
  relative: string,
  targetRoot: string,
  prefix: string,
  usedNames: Set<string>,
): Promise<void> {
  for (const entry of await fsp.readdir(path.join(sourceRoot, relative), { withFileTypes: true })) {
    const nextRelative = path.join(relative, entry.name);
    const source = path.join(sourceRoot, nextRelative);
    const name = uniqueSkillName(
      `${prefix}-${skillSlug(nextRelative.replace(/\.md$/i, ""))}`,
      usedNames,
    );
    if (entry.isSymbolicLink()) {
      throw new Error(`Imported skill tree contains a symlink: ${source}`);
    }
    if (entry.isDirectory() && fs.existsSync(path.join(source, "SKILL.md"))) {
      await copySkillDirectory(source, path.join(targetRoot, name), name);
    } else if (entry.isDirectory()) {
      await importSkillEntries(sourceRoot, nextRelative, targetRoot, prefix, usedNames);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const target = path.join(targetRoot, name);
      await fsp.mkdir(target, { recursive: true });
      await fsp.writeFile(
        path.join(target, "SKILL.md"),
        convertedSkillMarkdown(name, await fsp.readFile(source, "utf8")),
      );
    }
  }
}

async function syncBundleSkills(plugins: BundlePlugin[], root: string): Promise<string[]> {
  const targetRoot = path.join(root, "skills", "babelfish-bundles");
  await fsp.rm(targetRoot, { recursive: true, force: true });
  await fsp.mkdir(targetRoot, { recursive: true });
  const usedNames = new Set<string>();
  for (const plugin of plugins) {
    for (const sourceRoot of plugin.skillDirs) {
      const directSkill = path.join(sourceRoot, "SKILL.md");
      if (fs.existsSync(directSkill)) {
        const name = uniqueSkillName(
          `${skillSlug(plugin.app)}-${skillSlug(plugin.key)}-${skillSlug(path.basename(sourceRoot))}`,
          usedNames,
        );
        await copySkillDirectory(sourceRoot, path.join(targetRoot, name), name);
        continue;
      }
      await importSkillEntries(
        sourceRoot,
        "",
        targetRoot,
        `${skillSlug(plugin.app)}-${skillSlug(plugin.key)}`,
        usedNames,
      );
    }
  }
  return ["skills/babelfish-bundles"];
}

async function buildBundleToolEntries(
  plugins: BundlePlugin[],
  reservedNames: string[],
  timeoutMs: number,
): Promise<NativeToolEntry[]> {
  const entries: NativeToolEntry[] = [];
  for (const plugin of plugins) {
    for (const server of plugin.servers) {
      const inspection = await inspectBundleServer(plugin, server, timeoutMs);
      for (const tool of inspection.tools) {
        entries.push({
          kind: "tool",
          app: plugin.app,
          name: tool.name,
          plugin: plugin.key,
          server: server.name,
          originalName: tool.name,
          description: tool.description || `MCP tool ${plugin.key}/${server.name}/${tool.name}`,
          inputSchema: tool.inputSchema,
        });
      }
      const prefix = `${sanitizeName(plugin.key)}__${sanitizeName(server.name)}`;
      if (inspection.capabilities.resources) {
        entries.push({
          kind: "tool", app: plugin.app, name: `${prefix}__resources_list`, plugin: plugin.key,
          server: server.name, originalName: "resources/list", mcpOperation: "listResources",
          description: `List MCP resources from ${plugin.key}/${server.name}`,
          inputSchema: { type: "object", additionalProperties: false, properties: { cursor: { type: "string" } } },
        }, {
          kind: "tool", app: plugin.app, name: `${prefix}__resource_read`, plugin: plugin.key,
          server: server.name, originalName: "resources/read", mcpOperation: "readResource",
          description: `Read an MCP resource from ${plugin.key}/${server.name}`,
          inputSchema: { type: "object", additionalProperties: false, properties: { uri: { type: "string" } }, required: ["uri"] },
        });
      }
      if (inspection.capabilities.prompts) {
        entries.push({
          kind: "tool", app: plugin.app, name: `${prefix}__prompts_list`, plugin: plugin.key,
          server: server.name, originalName: "prompts/list", mcpOperation: "listPrompts",
          description: `List MCP prompts from ${plugin.key}/${server.name}`,
          inputSchema: { type: "object", additionalProperties: false, properties: { cursor: { type: "string" } } },
        }, {
          kind: "tool", app: plugin.app, name: `${prefix}__prompt_get`, plugin: plugin.key,
          server: server.name, originalName: "prompts/get", mcpOperation: "getPrompt",
          description: `Get an MCP prompt from ${plugin.key}/${server.name}`,
          inputSchema: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: { type: "string" } } }, required: ["name"] },
        });
      }
    }
  }
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  const used = new Set<string>([...NATIVE_BRIDGE_TOOL_NAMES, ...reservedNames]);
  return entries.map((entry) => ({
    ...entry,
    name: uniqueName(
      counts.get(entry.name) === 1 && !used.has(entry.name)
        ? entry.name
        : `${sanitizeName(entry.plugin)}__${sanitizeName(entry.name)}`,
      used,
    ),
  }));
}

export async function regenerateNativeTools(
  config: BabelfishConfig,
  options: { root?: string } = {},
): Promise<{ generatedTools: string[]; restartRequired: true }> {
  const root = options.root ?? packageRoot;
  const list = await listHermesPlugins(config);
  const failures = list.plugins.filter((plugin) => plugin.error);
  if (failures.length > 0) {
    throw new Error(
      `Could not load installed plugins: ${failures
        .map((plugin) => `${plugin.key}: ${plugin.error}`)
        .join("; ")}`,
    );
  }
  const tools = buildNativeToolEntries(list);
  const bundlePlugins = await listBundlePlugins(config);
  tools.push(...await buildBundleToolEntries(bundlePlugins, tools.map((tool) => tool.name), config.timeoutMs));
  const commands = buildCommandEntries(list, (plugin) => plugin.commands, OPENCLAW_RESERVED_COMMANDS);
  const cliCommands = buildCommandEntries(list, (plugin) => plugin.cliCommands ?? [], OPENCLAW_CLI_ROOTS);
  const outputStyles = bundlePlugins.flatMap((plugin) => plugin.outputStyles.map((style) => ({
    ...style,
    plugin: plugin.key,
    name: `babelfish-style-${skillSlug(plugin.key)}-${skillSlug(style.name)}`,
  })));
  const registry: GeneratedNativeToolRegistry = {
    generatedAt: new Date().toISOString(),
    installDir: list.installDir,
    skillDirs: bundlePlugins.flatMap((plugin) => plugin.skillDirs),
    unsupported: bundlePlugins.flatMap((plugin) =>
      plugin.unsupported.map((surface) => ({ app: plugin.app, plugin: plugin.key, surface })),
    ),
    tools,
    commands,
    cliCommands,
    outputStyles,
  };
  const registryTarget = registryPath(root);
  const manifestTarget = manifestPath(root);
  const skillsTarget = path.join(root, "skills", "babelfish-generated");
  const bundleSkillsTarget = path.join(root, "skills", "babelfish-bundles");
  const backupRoot = path.join(root, `.babelfish-regenerate-${process.pid}-${Date.now()}`);
  const previousRegistry = await readOptionalFile(registryTarget);
  const previousManifest = await readOptionalFile(manifestTarget);
  const hadSkills = fs.existsSync(skillsTarget);
  if (hadSkills) {
    await fsp.mkdir(backupRoot, { recursive: true });
    await fsp.cp(skillsTarget, path.join(backupRoot, "skills"), { recursive: true });
  }
  const hadBundleSkills = fs.existsSync(bundleSkillsTarget);
  if (hadBundleSkills) {
    await fsp.mkdir(backupRoot, { recursive: true });
    await fsp.cp(bundleSkillsTarget, path.join(backupRoot, "bundle-skills"), { recursive: true });
  }
  try {
    const manifestSkillDirs = await syncBundleSkills(bundlePlugins, root);
    await fsp.writeFile(registryTarget, `${JSON.stringify(registry, null, 2)}\n`);
    await writeManifest(
      [...NATIVE_BRIDGE_TOOL_NAMES, ...tools.map((tool) => tool.name)],
      manifestSkillDirs,
      root,
    );
    await syncHermesSkills(config, root);
  } catch (error) {
    await restoreFile(registryTarget, previousRegistry);
    await restoreFile(manifestTarget, previousManifest);
    await fsp.rm(skillsTarget, { recursive: true, force: true });
    await fsp.rm(bundleSkillsTarget, { recursive: true, force: true });
    if (hadSkills) {
      await fsp.cp(path.join(backupRoot, "skills"), skillsTarget, { recursive: true });
    }
    if (hadBundleSkills) {
      await fsp.cp(path.join(backupRoot, "bundle-skills"), bundleSkillsTarget, { recursive: true });
    }
    throw error;
  } finally {
    await fsp.rm(backupRoot, { recursive: true, force: true });
  }
  return { generatedTools: tools.map((tool) => tool.name), restartRequired: true };
}

function runtimeContext(ctx: NativeToolContext): HermesRuntimeContext {
  return {
    workspace: ctx.workspaceDir ?? process.cwd(),
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    model: ctx.modelId ?? ctx.activeModel?.modelId ?? ctx.activeModel?.modelRef,
    provider: ctx.modelProviderId ?? ctx.activeModel?.provider,
    env: {},
  };
}

function bridgeTools(config: BabelfishConfig): NativeTool[] {
  return [
    {
      name: "babelfish_plugins_list",
      description: "List installed app plugins and their registered OpenClaw surfaces.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          app: { type: "string", enum: SUPPORTED_APPS, description: "Optional app filter." },
        },
      },
      execute: async (_toolCallId, params) => {
        const rawApp = asObject(params)?.app;
        if (rawApp !== undefined) {
          const app = supportedApp(rawApp);
          return result(
            app === "hermes"
              ? { app, ...(await listHermesPlugins(config)) }
              : { app, plugins: (await listBundlePlugins(config, app)).map(summarizeBundlePlugin) },
          );
        }
        return result({
          apps: [
            { app: "hermes", ...(await listHermesPlugins(config)) },
            { app: "claude-code", plugins: (await listBundlePlugins(config, "claude-code")).map(summarizeBundlePlugin) },
            { app: "codex", plugins: (await listBundlePlugins(config, "codex")).map(summarizeBundlePlugin) },
          ],
        });
      },
    },
  ];
}

function generatedTools(
  config: BabelfishConfig,
  entries: NativeToolEntry[],
  ctx: NativeToolContext,
): NativeTool[] {
  return entries.map((entry) => ({
    name: entry.name,
    description: entry.description,
    parameters: entry.inputSchema,
    execute: async (_toolCallId, params, signal) => {
      const app = entry.app ?? "hermes";
      if (app !== "hermes") {
        const plugin = (await listBundlePlugins(config, app)).find(
          (candidate) => candidate.key === entry.plugin,
        );
        const server = plugin?.servers.find((candidate) => candidate.name === entry.server);
        if (!plugin || !server) {
          throw new Error(`Imported MCP tool source is no longer installed: ${entry.name}`);
        }
        if (entry.mcpOperation) {
          const value = await callBundleMcp(
            plugin, server, entry.mcpOperation, asObject(params) ?? {}, signal, config.timeoutMs,
          );
          return result(value);
        }
        const toolResult = await callBundleTool(
          plugin, server, entry.originalName, asObject(params) ?? {}, signal, config.timeoutMs,
        );
        const content = Array.isArray(toolResult.content)
          ? normalizeMcpContent(toolResult.content)
          : [{ type: "text", text: stringifyResult(toolResult) }];
        if (toolResult.isError) {
          const message = content
            .filter((item): item is { type: "text"; text: string } =>
              asObject(item)?.type === "text" && typeof asObject(item)?.text === "string"
            )
            .map((item) => item.text)
            .join("\n") || `Imported MCP tool failed: ${entry.name}`;
          throw new Error(message);
        }
        return { content, details: toolResult };
      }
      const openclawContext = runtimeContext(ctx);
      const tool = await callHermesTool(
        config,
        {
          plugin: entry.plugin,
          tool: entry.originalName,
          args: params ?? {},
          context: openclawContext,
        },
        { signal },
      );
      return result(tool.parsedResult ?? tool.result);
    },
  }));
}

export function normalizeMcpContent(content: unknown[]): Array<Record<string, unknown>> {
  return content.map((item) => {
    const block = asObject(item);
    if (block?.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    const resource = asObject(block?.resource);
    if (block?.type === "resource" && typeof resource?.text === "string") {
      return { type: "text", text: resource.text };
    }
    return { type: "text", text: stringifyResult(item) };
  });
}

export function createNativeTools(
  config: BabelfishConfig,
  entries: NativeToolEntry[],
  ctx: NativeToolContext,
): NativeTool[] {
  return [...bridgeTools(config), ...generatedTools(config, entries, ctx)];
}
