import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveConfig } from "./config.js";
import {
  hookAdditionalContext,
  hookBlock,
  hookUpdatedInput,
  invokeBundleHooks,
  listBundlePlugins,
  MAX_HOOK_OUTPUT_BYTES,
} from "./bundle-plugins.js";
import { runBabelfishCli } from "./cli.js";
import {
  callHermesCliCommand,
  callHermesCommand,
  invokeHermesHook,
  invokeHermesMiddleware,
  listHermesPlugins,
  releaseHermesBridge,
  type HermesRuntimeContext,
} from "./hermes-python.js";
import {
  createNativeTools,
  NATIVE_BRIDGE_TOOL_NAMES,
  readGeneratedNativeToolRegistry,
  type GeneratedCommandEntry,
  type GeneratedOutputStyleEntry,
  type NativeTool,
  type NativeToolContext,
  type NativeToolEntry,
} from "./native-tools.js";
import {
  spawnMonitorShellCommand,
  terminateShellProcessTree,
} from "./shell-command.js";

type Logger = { warn(message: string): void };
type OpenClawCommandContext = {
  args?: string;
  workspaceDir?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
};
type OpenClawCliCommand = {
  description(text: string): OpenClawCliCommand;
  argument(flags: string, description?: string): OpenClawCliCommand;
  allowUnknownOption(value?: boolean): OpenClawCliCommand;
  action(handler: (args?: string[]) => unknown): OpenClawCliCommand;
};
type OpenClawCliProgram = {
  command(name: string): OpenClawCliCommand;
};
type OpenClawApi = {
  config?: {
    plugins?: {
      entries?: Record<string, {
        llm?: {
          allowAgentIdOverride?: boolean;
          allowModelOverride?: boolean;
        };
      }>;
    };
  };
  runtime?: {
    llm?: {
      complete(params: {
        messages: Array<{ role: "user"; content: string }>;
        maxTokens?: number;
        temperature?: number;
        systemPrompt?: string;
        purpose?: string;
        signal?: AbortSignal;
        model?: string;
        agentId?: string;
      }): Promise<{ text: string }>;
    };
  };
  logger?: Logger;
  on(hook: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  registerTool(
    tool: (ctx: NativeToolContext) => NativeTool[],
    options: { names: string[] },
  ): void;
  registerAgentToolResultMiddleware(
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    options?: { runtimes?: string[] },
  ): void;
  registerCommand(command: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler(ctx: OpenClawCommandContext): unknown;
  }): void;
  registerCli(
    registrar: (ctx: { program: OpenClawCliProgram }) => void,
    options: {
      commands: string[];
      descriptors: Array<{ name: string; description: string; hasSubcommands: boolean }>;
    },
  ): void;
};

const UNSUPPORTED_WARNING_HOOKS = new Set([
  "pre_approval_request",
  "post_approval_response",
  "kanban_task_claimed",
  "kanban_task_completed",
  "kanban_task_blocked",
  "transform_llm_output",
]);

const UNSUPPORTED_WARNING_MIDDLEWARE = new Set([
  "llm_execution",
  "tool_execution",
]);

const config = resolveConfig(undefined);
const sessionStartContext = new Map<string, string[]>();
const sessionStartPending = new Map<string, Promise<void>>();
const sessionStartOwners = new Map<string, symbol>();
const sessionStartSources = new Map<string, string>();
const promptContextByRun = new Map<string, string[]>();
const outputStyleBySession = new Map<string, GeneratedOutputStyleEntry>();
const monitorProcesses = new Map<string, ChildProcess[]>();
const monitorContext = new Map<string, string[]>();

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function hermesKwargs(value: unknown): Record<string, unknown> {
  const raw = record(value);
  const out = { ...raw };
  for (const [key, entry] of Object.entries(raw)) {
    const snake = snakeCase(key);
    if (!(snake in out)) {
      out[snake] = entry;
    }
  }
  if (!("args" in out) && "params" in raw) {
    out.args = raw.params;
  }
  return out;
}

function context(ctx: unknown): HermesRuntimeContext {
  const raw = record(ctx);
  return {
    workspace: typeof raw.workspaceDir === "string" ? raw.workspaceDir : process.cwd(),
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    sessionKey: typeof raw.sessionKey === "string" ? raw.sessionKey : undefined,
    agentId: typeof raw.agentId === "string" ? raw.agentId : undefined,
    model: typeof raw.modelId === "string" ? raw.modelId : undefined,
    provider: typeof raw.modelProviderId === "string" ? raw.modelProviderId : undefined,
    env: {},
  };
}

function sessionKey(event: unknown, ctx: unknown): string | undefined {
  const rawEvent = record(event);
  const rawContext = record(ctx);
  const value = rawContext.sessionKey ?? rawContext.sessionId ?? rawEvent.sessionKey ?? rawEvent.sessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runKey(event: unknown, ctx: unknown): string | undefined {
  const rawEvent = record(event);
  const rawContext = record(ctx);
  const value = rawContext.runId ?? rawContext.turnId ?? rawEvent.runId ?? rawEvent.turnId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stopMonitors(key: string): void {
  const children = monitorProcesses.get(key) ?? [];
  monitorProcesses.delete(key);
  monitorContext.delete(key);
  for (const child of children) {
    terminateShellProcessTree(child);
  }
}

async function startMonitors(
  key: string,
  workspace: string,
  warn: (message: string) => void,
): Promise<void> {
  stopMonitors(key);
  const children: ChildProcess[] = [];
  monitorProcesses.set(key, children);
  const plugins = await listBundlePlugins(config, "claude-code");
  if (monitorProcesses.get(key) !== children) return;
  for (const plugin of plugins) {
    for (const monitor of plugin.monitors) {
      const command = monitor.command.replaceAll("${CLAUDE_PROJECT_DIR}", workspace);
      const child = spawnMonitorShellCommand(command, {
        cwd: workspace,
        detached: true,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin.path, PLUGIN_ROOT: plugin.path },
        stdio: ["ignore", "pipe", "inherit"],
        windowsHide: true,
      });
      child.once("error", (error) => {
        warn(`Babelfish monitor ${plugin.key}/${monitor.name} failed to start: ${error.message}`);
      });
      children.push(child);
      child.once("close", () => {
        if (process.platform !== "win32") return;
        const active = monitorProcesses.get(key);
        if (active !== children) return;
        const index = active.indexOf(child);
        if (index >= 0) active.splice(index, 1);
        if (active.length === 0) monitorProcesses.delete(key);
      });
      if (!child.stdout) {
        warn(`Babelfish monitor ${plugin.key}/${monitor.name} has no stdout stream.`);
        child.kill();
        continue;
      }
      let received = 0;
      let capped = false;
      let pendingLine = "";
      const decoder = new StringDecoder("utf8");
      const recordLine = (line: string) => {
        const text = line.trim();
        if (!text) return;
        if (!monitorProcesses.get(key)?.includes(child)) return;
        const pending = monitorContext.get(key) ?? [];
        pending.push(`${monitor.description}: ${text}`);
        monitorContext.set(key, pending.slice(-50));
      };
      const takeText = (text: string) => {
        pendingLine += text;
        const parts = pendingLine.split(/\r\n|\n|\r/);
        pendingLine = parts.pop() ?? "";
        for (const part of parts) recordLine(part);
      };
      const stopForCap = () => {
        if (capped) return;
        capped = true;
        warn(
          `Babelfish monitor ${plugin.key}/${monitor.name} exceeded the ${MAX_HOOK_OUTPUT_BYTES}-byte output limit`,
        );
        terminateShellProcessTree(child);
        setTimeout(() => {
          terminateShellProcessTree(child, process.platform, "SIGKILL");
        }, 250).unref();
      };
      let tailFlushed = false;
      const flushTail = () => {
        if (capped || tailFlushed) return;
        tailFlushed = true;
        takeText(decoder.end());
        if (pendingLine.length > 0) recordLine(pendingLine);
        pendingLine = "";
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (capped) return;
        const room = MAX_HOOK_OUTPUT_BYTES - received;
        const accepted = chunk.length > room ? chunk.subarray(0, Math.max(0, room)) : chunk;
        if (accepted.length > 0) {
          received += accepted.length;
          takeText(decoder.write(accepted));
        }
        if (chunk.length > room) stopForCap();
      });
      child.stdout.on("end", flushTail);
      child.stdout.on("close", flushTail);
    }
  }
  if (children.length === 0) {
    monitorProcesses.delete(key);
  }
}

async function invokeHook(hook: string, event: unknown, ctx: unknown) {
  return invokeHermesHook(config, { hook, kwargs: hermesKwargs(event), context: context(ctx) });
}

async function invokeMiddleware(kind: string, event: unknown, ctx: unknown) {
  return invokeHermesMiddleware(config, { kind, kwargs: hermesKwargs(event), context: context(ctx) });
}

function firstRecord(results: unknown[]): Record<string, unknown> | undefined {
  return results.map(record).find((item) => Object.keys(item).length > 0);
}

function firstString(results: unknown[]): string | undefined {
  return results.find((item): item is string => typeof item === "string" && item.length > 0);
}

function promptMutation(value: unknown): Record<string, string> | undefined {
  const request = record(record(value).request);
  const fields = {
    systemPrompt: request.systemPrompt ?? request.system_prompt,
    prependContext: request.prependContext ?? request.prepend_context,
    appendContext: request.appendContext ?? request.append_context,
    prependSystemContext: request.prependSystemContext ?? request.prepend_system_context,
    appendSystemContext: request.appendSystemContext ?? request.append_system_context,
  };
  const mutation = Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return Object.keys(mutation).length > 0 ? mutation : undefined;
}

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function bundlePayload(eventName: string, event: unknown, ctx: unknown): Record<string, unknown> {
  const raw = record(event);
  const runtime = context(ctx);
  const transcriptPath = raw.transcript_path ?? raw.transcriptPath;
  const model = runtime.provider && runtime.model
    ? `${runtime.provider}/${runtime.model}`
    : runtime.model ?? "";
  return {
    ...hermesKwargs(raw),
    hook_event_name: eventName,
    cwd: runtime.workspace,
    session_id: runtime.sessionId ?? runtime.sessionKey ?? "",
    model,
    agent_id: runtime.agentId ?? "",
    permission_mode: "default",
    transcript_path: typeof transcriptPath === "string" ? transcriptPath : null,
    turn_id: typeof raw.turnId === "string" ? raw.turnId : "",
  };
}

let promptHookEvaluator: Parameters<typeof invokeBundleHooks>[4];

async function bundleHooks(eventName: string, event: unknown, ctx: unknown, match = "") {
  return invokeBundleHooks(config, eventName, bundlePayload(eventName, event, ctx), match, promptHookEvaluator);
}

function configurePromptHooks(api: OpenClawApi): void {
  promptHookEvaluator = undefined;
  if (!api.runtime?.llm) return;
  const policy = api.config?.plugins?.entries?.babelfish?.llm;
  if (policy?.allowAgentIdOverride !== true || policy.allowModelOverride !== true) {
    api.logger?.warn(
      "Babelfish prompt hook handlers require plugins.entries.babelfish.llm agent and model override permissions",
    );
    return;
  }
  promptHookEvaluator = async (template, payload, timeoutMs) => {
    const argumentsJson = JSON.stringify(payload);
    const prompt = template.includes("$ARGUMENTS")
      ? template.replaceAll("$ARGUMENTS", argumentsJson)
      : `${template}\n\n${argumentsJson}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const model = typeof payload.model === "string" && payload.model ? payload.model : undefined;
    const agentId = typeof payload.agent_id === "string" && payload.agent_id
      ? payload.agent_id
      : undefined;
    if (!model || !agentId) {
      throw new Error("Prompt hook requires active OpenClaw agent and model context");
    }
    const response = await api.runtime!.llm!.complete({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 300,
      temperature: 0,
      systemPrompt: 'Evaluate the hook instructions. Return only JSON: {"ok":true} to allow, or {"ok":false,"reason":"..."} to block.',
      purpose: "babelfish-hook-evaluation",
      signal: controller.signal,
      model,
      agentId,
    }).finally(() => clearTimeout(timer));
    const match = response.text.match(/\{[\s\S]*\}/);
    const decision = match ? record(JSON.parse(match[0])) : {};
    if (decision.ok === true) return undefined;
    if (decision.ok === false) {
      return { decision: "block", reason: typeof decision.reason === "string" ? decision.reason : "Prompt hook blocked" };
    }
    throw new Error("Prompt hook returned no boolean ok decision");
  };
}

function registerWarnings(api: OpenClawApi): void {
  for (const warning of readGeneratedNativeToolRegistry().unsupported) {
    api.logger?.warn(
      `Babelfish plugin ${warning.plugin} (${warning.app}) has unsupported surface ${warning.surface}`,
    );
  }
  void listHermesPlugins(config).then(
    (list) => {
      for (const plugin of list.plugins) {
        for (const hook of plugin.hooks) {
          if (UNSUPPORTED_WARNING_HOOKS.has(hook)) {
            api.logger?.warn(`Babelfish plugin ${plugin.key} registered unsupported hook ${hook}`);
          }
        }
        for (const middleware of plugin.middleware) {
          if (UNSUPPORTED_WARNING_MIDDLEWARE.has(middleware)) {
            api.logger?.warn(`Babelfish plugin ${plugin.key} registered unsupported middleware ${middleware}`);
          }
        }
      }
    },
    (error: unknown) => {
      api.logger?.warn(`Babelfish could not inspect installed app plugins: ${(error as Error).message}`);
    },
  );
}

function registerToolHooks(api: OpenClawApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    const middlewareResult = await invokeMiddleware("tool_request", event, ctx);
    const rewrite = middlewareResult.results.map(record).find(
      (decision) => decision.args !== null && typeof decision.args === "object" && !Array.isArray(decision.args),
    );
    const hookEvent = rewrite ? { ...record(event), args: rewrite.args, params: rewrite.args } : event;
    const hookResult = await invokeHook("pre_tool_call", hookEvent, ctx);
    // Hermes pre_tool_call is block-only; payload rewrites belong to tool_request middleware.
    const block = hookResult.results
      .map(record)
      .find(
        (decision) => decision.action === "block" && typeof decision.message === "string" && decision.message.length > 0,
      );
    const rawEvent = record(event);
    const currentParams = rewrite?.args ?? record(rawEvent.params);
    const imported = await bundleHooks(
      "PreToolUse",
      {
        ...rawEvent,
        tool_name: rawEvent.toolName,
        tool_input: currentParams,
        tool_use_id: rawEvent.toolCallId ?? "",
      },
      ctx,
      typeof rawEvent.toolName === "string" ? rawEvent.toolName : "",
    );
    const importedDecisions = imported;
    const importedBlock = importedDecisions.map(hookBlock).find((decision) => decision.block);
    if (block || importedBlock) {
      return {
        block: true,
        blockReason: block?.message ?? importedBlock?.reason ?? "Blocked by imported plugin hook",
      };
    }
    const importedRewrite = importedDecisions.map(hookUpdatedInput).filter(Boolean).at(-1);
    return rewrite || importedRewrite ? { params: importedRewrite ?? rewrite?.args } : undefined;
  });

  api.on("after_tool_call", async (event, ctx) => {
    await invokeHook("post_tool_call", event, ctx);
    const raw = record(event);
    await bundleHooks(
      typeof raw.error === "string" && raw.error ? "PostToolUseFailure" : "PostToolUse",
      { ...raw, tool_name: raw.toolName, tool_input: raw.params ?? {}, tool_response: raw.result },
      ctx,
      typeof raw.toolName === "string" ? raw.toolName : "",
    );
  });

  api.registerAgentToolResultMiddleware(
    async (event, ctx) => {
      const [toolResult, terminalResult] = await Promise.all([
        invokeHook("transform_tool_result", event, ctx),
        invokeHook("transform_terminal_output", event, ctx),
      ]);
      const transformed = firstString([
        ...toolResult.results,
        ...terminalResult.results,
      ]);
      return transformed ? { result: textResult(transformed) } : undefined;
    },
    { runtimes: ["openclaw", "codex"] },
  );
}

export function registerNativeTools(api: OpenClawApi, generated?: NativeToolEntry[]): void {
  const entries = generated ?? readGeneratedNativeToolRegistry().tools;
  api.registerTool((toolContext) => createNativeTools(config, entries, toolContext), {
    names: [...NATIVE_BRIDGE_TOOL_NAMES, ...entries.map((entry) => entry.name)],
  });
}

export function registerHermesCommands(api: OpenClawApi, generated?: GeneratedCommandEntry[]): void {
  const entries = generated ?? readGeneratedNativeToolRegistry().commands;
  for (const entry of entries) {
    api.registerCommand({
      name: entry.name,
      description: entry.description,
      acceptsArgs: true,
      handler: async (ctx) => {
        const result = await callHermesCommand(config, {
          plugin: entry.plugin,
          command: entry.originalName,
          args: ctx.args ?? "",
          context: context(ctx),
        });
        return { text: text(result.result) };
      },
    });
  }
}

export function registerOutputStyles(api: OpenClawApi, generated?: GeneratedOutputStyleEntry[]): void {
  const entries = generated ?? readGeneratedNativeToolRegistry().outputStyles;
  for (const entry of entries) {
    api.registerCommand({
      name: entry.name,
      description: entry.description,
      handler: (ctx) => {
        const key = ctx.sessionKey ?? ctx.sessionId;
        if (!key) {
          return { text: "Output styles require an active session." };
        }
        outputStyleBySession.set(key, entry);
        return { text: `Output style selected: ${entry.description}` };
      },
    });
  }
}

export function registerHermesCliCommands(
  api: OpenClawApi,
  generated?: GeneratedCommandEntry[],
): void {
  const entries = generated ?? readGeneratedNativeToolRegistry().cliCommands;
  if (entries.length === 0) {
    return;
  }
  for (const entry of entries) {
    api.registerCli(
      ({ program }) => {
        program
          .command(entry.name)
          .description(entry.description)
          .argument("[args...]", entry.argsHint || "Arguments passed to the imported CLI command.")
          .allowUnknownOption(true)
          .action(async (args = []) => {
            const result = await callHermesCliCommand(config, {
              plugin: entry.plugin,
              command: entry.originalName,
              args,
              context: { workspace: process.cwd(), env: {} },
            });
            if (result.stdout) {
              process.stdout.write(result.stdout);
            }
            if (result.stderr) {
              process.stderr.write(result.stderr);
            }
            if (result.result !== null && result.result !== undefined) {
              const output = text(result.result);
              console.log(output);
            }
          });
      },
      {
        commands: [entry.name],
        descriptors: [{
        name: entry.name,
        description: entry.description,
        hasSubcommands: false,
        }],
      },
    );
  }
}

function registerRunHooks(api: OpenClawApi): void {
  api.on("before_prompt_build", async (event, ctx) => {
    const rawEvent = record(event);
    const result = await invokeHermesMiddleware(
      config,
      {
        kind: "llm_request",
        kwargs: { ...hermesKwargs(rawEvent), request: rawEvent },
        context: context(ctx),
      },
    );
    return result.results.map(promptMutation).filter(Boolean).at(-1);
  });

  api.on("before_agent_run", async (event, ctx) => {
    const imported = await bundleHooks("UserPromptSubmit", event, ctx);
    const block = imported.map(hookBlock).find((decision) => decision.block);
    if (block) {
      return {
        outcome: "block",
        reason: block.reason ?? "Blocked by imported plugin hook",
        message: block.reason,
      };
    }
    const key = runKey(event, ctx);
    const additional = imported
      .map(hookAdditionalContext)
      .filter((value): value is string => Boolean(value));
    if (key && additional.length > 0) {
      promptContextByRun.set(key, additional);
    }
    return { outcome: "pass" };
  });

  api.on("agent_turn_prepare", async (event, ctx) => {
    const hookResult = await invokeHook("pre_llm_call", event, ctx);
    const contextParts = hookResult.results
      .map((result) => typeof result === "string" ? result : record(result).context)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const key = sessionKey(event, ctx);
    if (key) {
      for (;;) {
        const pendingStart = sessionStartPending.get(key);
        if (!pendingStart) break;
        try {
          await pendingStart;
        } catch (error) {
          if (sessionStartPending.get(key) === pendingStart) {
            const detail = error instanceof Error ? error.message : String(error);
            api.logger?.warn(`Babelfish session start failed: ${detail}`);
          }
        } finally {
          // Keep concurrent prepares waiting, and never remove a newer start.
          if (sessionStartPending.get(key) === pendingStart) sessionStartPending.delete(key);
        }
      }
    }
    const promptRunKey = runKey(event, ctx);
    if (promptRunKey) {
      contextParts.push(...(promptContextByRun.get(promptRunKey) ?? []));
      promptContextByRun.delete(promptRunKey);
    }
    if (key) {
      contextParts.unshift(...(sessionStartContext.get(key) ?? []));
      sessionStartContext.delete(key);
      const style = outputStyleBySession.get(key);
      if (style) {
        contextParts.push(style.keepCodingInstructions
          ? style.instructions
          : `Use the following response style instead of the default coding-oriented response style:\n\n${style.instructions}`);
      }
      contextParts.push(...(monitorContext.get(key) ?? []));
      monitorContext.delete(key);
    }
    return contextParts.length > 0 ? { prependContext: contextParts.join("\n\n") } : undefined;
  });

  api.on("model_call_started", async (event, ctx) => {
    await invokeHook("pre_api_request", event, ctx);
  });
  api.on("model_call_ended", async (event, ctx) => {
    await invokeHook(
      record(event).outcome === "error" ? "api_request_error" : "post_api_request",
      event,
      ctx,
    );
  });
  api.on("llm_output", async (event, ctx) => {
    await invokeHook("post_llm_call", event, ctx);
  });
  api.on("agent_end", async (event, ctx) => {
    await invokeHook("on_session_end", event, ctx);
    const key = runKey(event, ctx);
    if (key) {
      promptContextByRun.delete(key);
    }
  });
  api.on("before_agent_finalize", async (event, ctx) => {
    const imported = await bundleHooks("Stop", event, ctx);
    // Claude Code: continue false stops the turn and outranks a Stop decision.
    const revise = imported
      .filter((result) => result.continue !== false)
      .map(hookBlock)
      .find((decision) => decision.block);
    return revise
      ? { action: "revise", reason: revise.reason, retry: { instruction: revise.reason ?? "Continue." } }
      : undefined;
  });
  api.on("before_compaction", async (event, ctx) => {
    const trigger = record(event).trigger;
    await bundleHooks("PreCompact", event, ctx, typeof trigger === "string" ? trigger : "");
  });
  api.on("after_compaction", async (event, ctx) => {
    const trigger = record(event).trigger;
    await bundleHooks("PostCompact", event, ctx, typeof trigger === "string" ? trigger : "");
  });
}

export function registerBabelfishCli(api: OpenClawApi): void {
  api.registerCli(
    ({ program }) => {
      program
        .command("babelfish")
        .description("Manage imported app plugins.")
        .argument("[args...]", "Babelfish command and arguments.")
        .allowUnknownOption(true)
        .action(async (args = []) => runBabelfishCli(args));
    },
    {
      commands: ["babelfish"],
      descriptors: [
        { name: "babelfish", description: "Manage imported app plugins.", hasSubcommands: true },
      ],
    },
  );
}

function registerSessionHooks(api: OpenClawApi): void {
  api.on("session_start", async (event, ctx) => {
    const key = sessionKey(event, ctx);
    const owner = Symbol();
    if (key) {
      sessionStartOwners.set(key, owner);
      sessionStartContext.delete(key);
    }
    // Enqueue Hermes start synchronously, before a concurrent turn callback.
    const pending = (async () => {
      await invokeHook("on_session_start", event, ctx);
      if (key && sessionStartOwners.get(key) !== owner) return;
      const rawEvent = record(event);
      const sessionId = typeof rawEvent.sessionId === "string" ? rawEvent.sessionId : undefined;
      const transitionSource = sessionId ? sessionStartSources.get(sessionId) : undefined;
      const source = typeof rawEvent.source === "string"
        ? rawEvent.source
        : transitionSource ?? (rawEvent.resumedFrom ? "resume" : "startup");
      if (sessionId) {
        sessionStartSources.delete(sessionId);
      }
      const imported = await bundleHooks("SessionStart", event, ctx, source);
      if (key && sessionStartOwners.get(key) !== owner) return;
      const additional = imported
        .map(hookAdditionalContext)
        .filter((value): value is string => Boolean(value));
      if (key && additional.length > 0) {
        sessionStartContext.set(key, additional);
      }
      if (key) {
        await startMonitors(
          key,
          context(ctx).workspace ?? process.cwd(),
          (message) => api.logger?.warn(message),
        );
      }
    })();
    if (key) {
      sessionStartPending.set(key, pending);
    }
    await pending;
  });
  api.on("session_end", async (event, ctx) => {
    const runtimeContext = context(ctx);
    const key = sessionKey(event, ctx);
    const owner = key ? sessionStartOwners.get(key) : undefined;
    try {
      await invokeHermesHook(config, {
        hook: "on_session_finalize",
        kwargs: hermesKwargs(event),
        context: runtimeContext,
      });
    } finally {
      try {
        const rawEvent = record(event);
        const reason = rawEvent.reason;
        const nextSessionId = rawEvent.nextSessionId;
        if (typeof nextSessionId === "string") {
          if (reason === "compaction") {
            sessionStartSources.set(nextSessionId, "compact");
          } else if (reason === "reset" || reason === "new") {
            sessionStartSources.set(nextSessionId, "clear");
          }
        }
        await bundleHooks("SessionEnd", event, ctx, typeof reason === "string" ? reason : "");
      } finally {
        if (!key || sessionStartOwners.get(key) === owner) {
          if (key) {
            sessionStartOwners.delete(key);
            sessionStartContext.delete(key);
            sessionStartPending.delete(key);
            outputStyleBySession.delete(key);
            stopMonitors(key);
          }
          releaseHermesBridge(config, runtimeContext);
        }
      }
    }
  });
  api.on("before_reset", async (event, ctx) => {
    const runtimeContext = context(ctx);
    const key = sessionKey(event, ctx);
    const owner = key ? sessionStartOwners.get(key) : undefined;
    try {
      await invokeHermesHook(config, {
        hook: "on_session_reset",
        kwargs: hermesKwargs(event),
        context: runtimeContext,
      });
    } finally {
      if (!key || sessionStartOwners.get(key) === owner) {
        releaseHermesBridge(config, runtimeContext);
      }
    }
  });
}

function registerMessageHooks(api: OpenClawApi): void {
  api.on("before_dispatch", async (event, ctx) => {
    const result = firstRecord((await invokeHook("pre_gateway_dispatch", event, ctx)).results);
    if (result?.action === "skip") {
      return { handled: true };
    }
    return undefined;
  });
}

function registerSubagentHooks(api: OpenClawApi): void {
  api.on("subagent_spawned", async (event, ctx) => {
    await invokeHook("subagent_start", event, ctx);
    await bundleHooks("SubagentStart", event, ctx);
  });
  api.on("subagent_ended", async (event, ctx) => {
    await invokeHook("subagent_stop", event, ctx);
    await bundleHooks("SubagentStop", event, ctx);
  });
}

export default {
  id: "babelfish",
  name: "Babelfish",
  description: "Use plugins from supported coding and agent apps in OpenClaw.",
  register(api: OpenClawApi): void {
    configurePromptHooks(api);
    registerNativeTools(api);
    registerBabelfishCli(api);
    registerHermesCommands(api);
    registerOutputStyles(api);
    registerHermesCliCommands(api);
    registerWarnings(api);
    registerToolHooks(api);
    registerRunHooks(api);
    registerSessionHooks(api);
    registerMessageHooks(api);
    registerSubagentHooks(api);
  },
};
