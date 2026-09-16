import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BabelfishConfig, SupportedApp } from "./config.js";
import { appInstallDir } from "./config.js";
import {
  spawnShellCommand,
  terminateShellProcessTree,
} from "./shell-command.js";

type JsonObject = Record<string, unknown>;

const SUPPORTED_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
]);
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

export type BundleServer = {
  name: string;
  config: JsonObject;
  baseDir: string;
};

export type BundleHook = {
  event: string;
  matcher?: string;
  type: "command" | "prompt";
  command?: string;
  prompt?: string;
  timeoutMs: number;
};

export type BundleOutputStyle = {
  name: string;
  description: string;
  instructions: string;
  keepCodingInstructions: boolean;
};

export type BundleMonitor = {
  name: string;
  command: string;
  description: string;
};

export type BundlePlugin = {
  app: Exclude<SupportedApp, "hermes">;
  key: string;
  name: string;
  version: string;
  description: string;
  path: string;
  skillDirs: string[];
  servers: BundleServer[];
  hooks: BundleHook[];
  outputStyles: BundleOutputStyle[];
  monitors: BundleMonitor[];
  unsupported: string[];
};

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

async function readJson(target: string): Promise<JsonObject | undefined> {
  try {
    return object(JSON.parse(await fs.readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Could not parse ${target}: ${(error as Error).message}`);
  }
}

async function readJsonValue(target: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Could not parse ${target}: ${(error as Error).message}`);
  }
}

function manifestPath(app: BundlePlugin["app"], root: string): string {
  return path.join(root, app === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json");
}

function relativePaths(value: unknown, fallback: string[]): string[] {
  const declared = strings(value);
  return [...new Set(
    [...fallback, ...declared].map((entry) => path.normalize(entry).replace(/[\\/]+$/, "")),
  )];
}

async function readOutputStyles(root: string, candidates: string[]): Promise<BundleOutputStyle[]> {
  const styles: BundleOutputStyle[] = [];
  for (const directory of await existingPaths(root, candidates)) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const source = await fs.readFile(path.join(directory, entry.name), "utf8");
      const end = source.startsWith("---\n") ? source.indexOf("\n---\n", 4) : -1;
      const frontmatter = end >= 0 ? source.slice(4, end) : "";
      const field = (name: string) => frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
        ?.trim().replace(/^['"]|['"]$/g, "");
      styles.push({
        name: field("name") ?? path.basename(entry.name, path.extname(entry.name)),
        description: field("description") ?? "Imported output style",
        instructions: (end >= 0 ? source.slice(end + 5) : source).trim(),
        keepCodingInstructions: /^(true|yes|1)$/i.test(field("keep-coding-instructions") ?? ""),
      });
    }
  }
  return styles;
}

async function readMonitors(root: string, manifest: JsonObject): Promise<{ monitors: BundleMonitor[]; unsupported: string[] }> {
  const experimental = object(manifest.experimental);
  const declared = experimental?.monitors;
  let entries: unknown[] = Array.isArray(declared) ? declared : [];
  if (typeof declared === "string" || declared === undefined) {
    const file = typeof declared === "string" ? declared : "monitors/monitors.json";
    const raw = await readJsonValue(underRoot(root, file));
    entries = Array.isArray(raw) ? raw : Array.isArray(object(raw)?.monitors) ? object(raw)?.monitors as unknown[] : [];
  }
  const monitors: BundleMonitor[] = [];
  const unsupported: string[] = [];
  for (const value of entries) {
    const entry = object(value);
    if (!entry || typeof entry.name !== "string" || typeof entry.command !== "string") {
      unsupported.push("invalid monitor");
      continue;
    }
    if (typeof entry.when === "string" && entry.when !== "always") {
      unsupported.push(`monitor ${entry.name} trigger ${entry.when}`);
      continue;
    }
    monitors.push({
      name: entry.name,
      command: entry.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${PLUGIN_ROOT}", root),
      description: typeof entry.description === "string" ? entry.description : entry.name,
    });
  }
  return { monitors, unsupported };
}

function underRoot(root: string, value: string): string {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plugin path escapes its root: ${value}`);
  }
  return resolved;
}

async function existingPaths(root: string, paths: string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const realRoot = await fs.realpath(root);
  for (const candidate of paths) {
    const resolved = underRoot(root, candidate);
    try {
      const real = await fs.realpath(resolved);
      const relative = path.relative(realRoot, real);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Plugin path escapes its root through a symlink: ${candidate}`);
      }
      if (!seen.has(real)) {
        seen.add(real);
        found.push(real);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return found;
}

async function readServers(root: string, files: string[]): Promise<BundleServer[]> {
  const servers: BundleServer[] = [];
  for (const file of files) {
    const target = underRoot(root, file);
    const raw = await readJson(target);
    if (!raw) {
      continue;
    }
    const map = object(raw.mcpServers) ?? raw;
    for (const [name, config] of Object.entries(map)) {
      const normalized = object(config);
      if (normalized) {
        servers.push({ name, config: normalized, baseDir: path.dirname(target) });
      }
    }
  }
  return servers;
}

function inlineServers(value: unknown): BundleServer[] {
  const map = object(value);
  if (!map) {
    return [];
  }
  const servers: BundleServer[] = [];
  for (const [name, config] of Object.entries(object(map.mcpServers) ?? map)) {
    const normalized = object(config);
    if (normalized) {
      servers.push({ name, config: normalized, baseDir: "" });
    }
  }
  return servers;
}

function commandHook(app: BundlePlugin["app"], entry: JsonObject): BundleHook | undefined {
  const timeout = typeof entry.timeout === "number" ? entry.timeout : 60;
  if (entry.type === "command" && typeof entry.command === "string" && entry.command.trim()) {
    return { event: "", type: "command", command: entry.command, timeoutMs: Math.max(1000, timeout * 1000) };
  }
  if (
    app === "claude-code"
    && entry.type === "prompt"
    && typeof entry.prompt === "string"
    && entry.prompt.trim()
  ) {
    return { event: "", type: "prompt", prompt: entry.prompt, timeoutMs: Math.max(1000, timeout * 1000) };
  }
  return undefined;
}

function collectHooks(
  app: BundlePlugin["app"],
  events: JsonObject,
  hooks: BundleHook[],
  unsupported: string[],
): void {
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    for (const group of groups) {
      const matcherGroup = object(group);
      const handlers = Array.isArray(matcherGroup?.hooks) ? matcherGroup.hooks : [group];
      for (const handler of handlers) {
        const normalized = object(handler);
        const hook = normalized && commandHook(app, normalized);
        if (!hook) {
          unsupported.push(`hook ${event} handler ${String(normalized?.type ?? "unknown")}`);
          continue;
        }
        hook.event = event;
        hook.matcher = typeof matcherGroup?.matcher === "string" ? matcherGroup.matcher : undefined;
        hooks.push(hook);
        if (!SUPPORTED_HOOK_EVENTS.has(event)) {
          unsupported.push(`hook ${event}`);
        }
      }
    }
  }
}

async function readHooks(
  app: BundlePlugin["app"],
  root: string,
  paths: string[],
  inline?: JsonObject,
): Promise<{ hooks: BundleHook[]; unsupported: string[] }> {
  const hooks: BundleHook[] = [];
  const unsupported: string[] = [];
  if (inline) {
    collectHooks(app, object(inline.hooks) ?? inline, hooks, unsupported);
  }
  const seen = new Set<string>();
  for (const candidate of paths) {
    for (const file of await hookFiles(root, candidate)) {
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      const raw = await readJson(file);
      const events = object(raw?.hooks) ?? raw;
      if (events) {
        collectHooks(app, events, hooks, unsupported);
      }
    }
  }
  return { hooks, unsupported };
}

async function hookFiles(root: string, candidate: string): Promise<string[]> {
  const target = underRoot(root, candidate);
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Plugin hook path uses a symlink: ${candidate}`);
  }
  if (!stats.isDirectory()) {
    return [target];
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Plugin hook path uses a symlink: ${path.relative(root, child)}`);
      }
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(child);
      }
    }
  }
  await walk(target);
  return files.sort();
}

export async function validateBundlePluginDirectory(
  app: BundlePlugin["app"],
  root: string,
): Promise<void> {
  try {
    await fs.access(manifestPath(app, root));
  } catch {
    throw new Error(`Repository is not a supported ${app} plugin; missing plugin manifest.`);
  }
}

export async function inspectBundlePlugin(
  app: BundlePlugin["app"],
  root: string,
): Promise<BundlePlugin> {
  const manifest = await readJson(manifestPath(app, root));
  if (!manifest) {
    throw new Error(`Missing ${app} plugin manifest.`);
  }
  const skillCandidates = app === "claude-code"
    ? [
        ...relativePaths(manifest.skills, ["skills"]),
        ...relativePaths(manifest.commands, ["commands"]),
        ...relativePaths(manifest.agents, ["agents"]),
        ...relativePaths(manifest.outputStyles, ["output-styles"]),
      ]
    : relativePaths(manifest.skills, ["skills"]);
  const outputStyleCandidates = app === "claude-code"
    ? relativePaths(manifest.outputStyles, ["output-styles"])
    : [];
  const inlineMcp = inlineServers(manifest.mcpServers);
  for (const server of inlineMcp) {
    server.baseDir = root;
  }
  const declaredMcpFiles = strings(manifest.mcpServers);
  const mcpFiles = app === "codex" && declaredMcpFiles.length > 0
    ? declaredMcpFiles
    : [...new Set([".mcp.json", ...declaredMcpFiles])];
  const inlineHooks = object(manifest.hooks);
  const declaredHookPaths = strings(manifest.hooks);
  const hookPaths = app === "codex"
    ? declaredHookPaths.length > 0 || inlineHooks ? declaredHookPaths : ["hooks/hooks.json"]
    : [...new Set(["hooks/hooks.json", ...declaredHookPaths])];
  const hookResult = await readHooks(app, root, hookPaths, inlineHooks);
  const monitorResult = app === "claude-code"
    ? await readMonitors(root, manifest)
    : { monitors: [], unsupported: [] };
  const unsupported = [...hookResult.unsupported, ...monitorResult.unsupported];
  const unsupportedFields = app === "claude-code"
    ? ["lspServers", "settings"]
    : ["interface"];
  for (const field of unsupportedFields) {
    if (manifest[field] !== undefined) {
      unsupported.push(field);
    }
  }
  if (app === "codex" && (await readJson(path.join(root, ".app.json")))) {
    unsupported.push("app connector metadata");
  }
  const servers = [...new Map(
    [...await readServers(root, mcpFiles), ...inlineMcp].map((server) => [server.name, server]),
  ).values()];
  const supportedServers = servers.filter((server) => {
    if (server.config.oauth || server.config.auth) {
      unsupported.push(`MCP authentication for ${server.name}`);
      return false;
    }
    return true;
  });
  return {
    app,
    key: path.basename(root),
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : path.basename(root),
    version: typeof manifest.version === "string" ? manifest.version : "",
    description: typeof manifest.description === "string" ? manifest.description : "",
    path: root,
    skillDirs: await existingPaths(root, [...new Set(skillCandidates)]),
    servers: supportedServers,
    hooks: hookResult.hooks,
    outputStyles: await readOutputStyles(root, outputStyleCandidates),
    monitors: monitorResult.monitors,
    unsupported,
  };
}

export function summarizeBundlePlugin(plugin: BundlePlugin) {
  return {
    app: plugin.app,
    key: plugin.key,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    skills: plugin.skillDirs.length,
    servers: plugin.servers.map((server) => ({
      name: server.name,
      transport: typeof server.config.url === "string" ? (server.config.type ?? "http") : "stdio",
    })),
    hooks: plugin.hooks.map((hook) => ({ event: hook.event, matcher: hook.matcher })),
    outputStyles: plugin.outputStyles.map((style) => style.name),
    monitors: plugin.monitors.map((monitor) => monitor.name),
    unsupported: plugin.unsupported,
  };
}

export async function listBundlePlugins(
  config: BabelfishConfig,
  app?: BundlePlugin["app"],
): Promise<BundlePlugin[]> {
  const apps: BundlePlugin["app"][] = app ? [app] : ["claude-code", "codex"];
  const plugins: BundlePlugin[] = [];
  for (const current of apps) {
    const installDir = appInstallDir(config, current);
    let entries: string[];
    try {
      entries = await fs.readdir(installDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) {
        continue;
      }
      const root = path.join(installDir, entry);
      plugins.push(await inspectBundlePlugin(current, root));
    }
  }
  return plugins;
}

function expandRoot(value: string, pluginRoot: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (name === "CLAUDE_PLUGIN_ROOT" || name === "PLUGIN_ROOT") {
      return pluginRoot;
    }
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw new Error(`Missing environment variable ${name} required by imported MCP server.`);
    }
    return resolved;
  });
}

function serverEnv(config: JsonObject, pluginRoot: string): Record<string, string> {
  const env = object(config.env) ?? {};
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      merged[key] = expandRoot(value, pluginRoot);
    }
  }
  for (const key of strings(config.env_vars ?? config.envVars)) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key] as string;
    }
  }
  return merged;
}

function httpHeaders(config: JsonObject, pluginRoot: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    object(config.headers) ?? object(config.http_headers ?? config.httpHeaders) ?? {},
  )) {
    if (typeof value === "string") {
      headers[key] = expandRoot(value, pluginRoot);
    }
  }
  for (const [key, envName] of Object.entries(object(config.env_http_headers ?? config.envHttpHeaders) ?? {})) {
    if (typeof envName === "string" && process.env[envName]) {
      headers[key] = process.env[envName] as string;
    }
  }
  const bearer = config.bearer_token_env_var ?? config.bearerTokenEnvVar;
  if (typeof bearer === "string" && process.env[bearer]) {
    headers.Authorization = `Bearer ${process.env[bearer]}`;
  }
  return headers;
}

async function withTimeout<T>(run: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`MCP operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function clientFor(plugin: BundlePlugin, server: BundleServer, timeoutMs: number): Promise<Client> {
  const client = new Client({ name: "babelfish", version: "0.1.0" });
  const raw = server.config;
  const url = typeof raw.url === "string" ? expandRoot(raw.url, plugin.path) : undefined;
  if (url) {
    const headers = httpHeaders(raw, plugin.path);
    const requestInit = { headers };
    const eventSourceInit = {
      fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
      }),
    };
    const transport = raw.type === "sse"
      ? new SSEClientTransport(new URL(url), { eventSourceInit, requestInit })
      : new StreamableHTTPClientTransport(new URL(url), { requestInit });
    await withTimeout(client.connect(transport), timeoutMs, () => void client.close());
    return client;
  }
  if (typeof raw.command !== "string") {
    throw new Error(`MCP server ${server.name} has no command or URL.`);
  }
  const resolveProcessPath = (value: string) => {
    const expanded = expandRoot(value, plugin.path);
    return path.isAbsolute(expanded) || expanded.startsWith("./") || expanded.startsWith("../")
      ? path.resolve(server.baseDir, expanded)
      : expanded;
  };
  const resolveArgument = (value: string) => {
    const usesPluginRoot = value.includes("${PLUGIN_ROOT}") || value.includes("${CLAUDE_PLUGIN_ROOT}");
    return usesPluginRoot || value.startsWith("./") || value.startsWith("../")
      ? resolveProcessPath(value)
      : value;
  };
  const transport = new StdioClientTransport({
    command: resolveProcessPath(raw.command),
    args: strings(raw.args).map(resolveArgument),
    cwd: typeof (raw.cwd ?? raw.workingDirectory) === "string"
      ? underRoot(
          plugin.path,
          path.resolve(server.baseDir, expandRoot((raw.cwd ?? raw.workingDirectory) as string, plugin.path)),
        )
      : server.baseDir,
    env: {
      ...process.env,
      ...serverEnv(raw, plugin.path),
      CLAUDE_PLUGIN_ROOT: plugin.path,
      PLUGIN_ROOT: plugin.path,
    } as Record<string, string>,
    stderr: "inherit",
  });
  await withTimeout(client.connect(transport), timeoutMs, () => void client.close());
  return client;
}

export async function inspectBundleServer(
  plugin: BundlePlugin,
  server: BundleServer,
  timeoutMs: number,
) {
  const client = await clientFor(plugin, server, timeoutMs);
  try {
    const advertised = client.getServerCapabilities();
    const capabilities = {
      tools: Boolean(advertised?.tools),
      resources: Boolean(advertised?.resources),
      prompts: Boolean(advertised?.prompts),
    };
    const tools = [];
    if (capabilities.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
        tools.push(...page.tools);
        cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      } while (cursor);
    }
    return { capabilities, tools };
  } finally {
    await client.close();
  }
}

export async function listBundleServerTools(
  plugin: BundlePlugin,
  server: BundleServer,
  timeoutMs: number,
) {
  return (await inspectBundleServer(plugin, server, timeoutMs)).tools;
}

export async function callBundleTool(
  plugin: BundlePlugin,
  server: BundleServer,
  tool: string,
  args: JsonObject,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  const client = await clientFor(plugin, server, timeoutMs);
  try {
    return await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: timeoutMs });
  } finally {
    await client.close();
  }
}

export async function callBundleMcp(
  plugin: BundlePlugin,
  server: BundleServer,
  operation: "listResources" | "readResource" | "listPrompts" | "getPrompt",
  params: JsonObject,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  const client = await clientFor(plugin, server, timeoutMs);
  try {
    if (operation === "listResources") {
      return await client.listResources(params, { signal, timeout: timeoutMs });
    }
    if (operation === "readResource") {
      return await client.readResource(params as { uri: string }, { signal, timeout: timeoutMs });
    }
    if (operation === "listPrompts") {
      return await client.listPrompts(params, { signal, timeout: timeoutMs });
    }
    return await client.getPrompt(params as { name: string; arguments?: Record<string, string> }, { signal, timeout: timeoutMs });
  } finally {
    await client.close();
  }
}

function matcherMatches(matcher: string | undefined, value: string): boolean {
  if (!matcher || matcher === "*") {
    return true;
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return matcher === value;
  }
}

export async function invokeBundleHooks(
  config: BabelfishConfig,
  event: string,
  payload: JsonObject,
  matchValue = "",
  evaluatePrompt?: (prompt: string, payload: JsonObject, timeoutMs: number) => Promise<JsonObject | undefined>,
): Promise<JsonObject[]> {
  const results: JsonObject[] = [];
  let currentPayload = payload;
  for (const plugin of await listBundlePlugins(config)) {
    for (const hook of plugin.hooks) {
      if (hook.event !== event || !matcherMatches(hook.matcher, matchValue)) {
        continue;
      }
      if (hook.type === "prompt") {
        if (!evaluatePrompt || !hook.prompt) {
          continue;
        }
        try {
          const result = await evaluatePrompt(hook.prompt, currentPayload, hook.timeoutMs);
          if (result) results.push(result);
        } catch (error) {
          console.warn(`Babelfish prompt hook ${plugin.key}/${event} failed: ${(error as Error).message}`);
        }
        continue;
      }
      const command = expandRoot(hook.command!, plugin.path);
      let output: Awaited<ReturnType<typeof runHookCommand>>;
      try {
        output = await runHookCommand(command, plugin.path, currentPayload, hook.timeoutMs);
      } catch (error) {
        console.warn(`Babelfish hook ${plugin.key}/${event} failed: ${(error as Error).message}`);
        continue;
      }
      if (output.blocked) {
        results.push({
          decision: "block",
          reason: output.blockReason || `Blocked by ${plugin.key} ${event} hook`,
        });
        continue;
      }
      const trimmed = output.stdout.trim();
      if (trimmed) {
        try {
          const parsed = object(JSON.parse(trimmed));
          if (parsed) {
            results.push(parsed);
            const updatedInput = event === "PreToolUse" ? hookUpdatedInput(parsed) : undefined;
            if (updatedInput) {
              currentPayload = { ...currentPayload, tool_input: updatedInput };
            }
          }
        } catch {
          const lastLine = trimmed.split("\n").at(-1);
          try {
            const parsed = lastLine ? object(JSON.parse(lastLine)) : undefined;
            if (parsed) {
              results.push(parsed);
              const updatedInput = event === "PreToolUse" ? hookUpdatedInput(parsed) : undefined;
              if (updatedInput) {
                currentPayload = { ...currentPayload, tool_input: updatedInput };
              }
            }
          } catch {
            // Successful hook output may be diagnostic text rather than a decision.
          }
        }
      }
    }
  }
  return results;
}

export function hookAdditionalContext(result: JsonObject): string | undefined {
  const specific = object(result.hookSpecificOutput);
  const value = specific?.additionalContext ?? result.systemMessage;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function hookBlock(result: JsonObject): { block: boolean; reason?: string } {
  const specific = object(result.hookSpecificOutput);
  const permission = specific?.permissionDecision ?? object(specific?.decision)?.behavior;
  const blocked = result.continue === false || result.decision === "block" || permission === "deny";
  const reason = specific?.permissionDecisionReason ?? object(specific?.decision)?.message
    ?? result.stopReason ?? result.reason;
  return { block: blocked, reason: typeof reason === "string" ? reason : undefined };
}

export function hookUpdatedInput(result: JsonObject): JsonObject | undefined {
  const specific = object(result.hookSpecificOutput);
  return object(specific?.updatedInput) ?? object(specific?.updatedMCPToolInput);
}

function runHookCommand(
  command: string,
  cwd: string,
  payload: JsonObject,
  timeoutMs: number,
): Promise<{ stdout: string; blocked?: boolean; blockReason?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnShellCommand(command, {
      cwd,
      detached: true,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: cwd, PLUGIN_ROOT: cwd },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (
      error?: Error,
      result?: { stdout: string; blocked?: boolean; blockReason?: string },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result ?? { stdout: "" });
    };
    const terminate = () => {
      terminateShellProcessTree(child);
      setTimeout(() => {
        terminateShellProcessTree(child, process.platform, "SIGKILL");
      }, 250).unref();
    };
    const capture = (stream: "stdout" | "stderr", chunks: Buffer[], chunk: Buffer) => {
      if (settled) {
        return;
      }
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_HOOK_OUTPUT_BYTES) {
          chunks.push(chunk);
          return;
        }
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_HOOK_OUTPUT_BYTES) {
          chunks.push(chunk);
          return;
        }
      }
      terminate();
      finish(new Error(`Hook ${stream} exceeded the ${MAX_HOOK_OUTPUT_BYTES}-byte output limit`));
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error(`Hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => capture("stdout", stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => capture("stderr", stderr, chunk));
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
      // Hooks can return a decision without consuming all of their input.
      if (error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "EOF") return;
      terminate();
      finish(error);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish(undefined, { stdout: Buffer.concat(stdout).toString("utf8") });
      } else if (code === 2) {
        finish(undefined, {
          stdout: Buffer.concat(stdout).toString("utf8"),
          blocked: true,
          blockReason: Buffer.concat(stderr).toString("utf8").trim(),
        });
      } else {
        finish(new Error(Buffer.concat(stderr).toString("utf8") || `Hook exited with ${code}`));
      }
    });
    child.stdin!.end(JSON.stringify(payload));
  });
}
