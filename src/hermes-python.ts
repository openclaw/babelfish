import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { HermesBridgeConfig } from "./config.js";

const helperPath = fileURLToPath(new URL("../python/hermes_openclaw_bridge.py", import.meta.url));

export type HermesToolSummary = {
  name: string;
  toolset: string;
  description: string;
  schema: unknown;
  isAsync: boolean;
  requiresEnv: string[];
  available: boolean;
};

export type HermesCommandSummary = {
  name: string;
  description: string;
  argsHint: string;
  available: boolean;
};

export type HermesSkillSummary = {
  name: string;
  description: string;
  path: string;
  available: boolean;
};

export type HermesAuxiliaryTaskSummary = {
  key: string;
  displayName: string;
  description: string;
  defaults: unknown;
};

export type HermesPluginSummary = {
  key: string;
  name: string;
  version: string;
  description: string;
  path: string;
  tools: HermesToolSummary[];
  hooks: string[];
  middleware: string[];
  commands: HermesCommandSummary[];
  cliCommands: HermesCommandSummary[];
  skills: HermesSkillSummary[];
  auxiliaryTasks: HermesAuxiliaryTaskSummary[];
  unsupported: string[];
  error?: string;
};

export type HermesListResult = {
  installDir: string;
  plugins: HermesPluginSummary[];
};

export type HermesCallResult = {
  plugin: string;
  tool: string;
  result: unknown;
  parsedResult?: unknown;
};

export type HermesCommandResult = {
  plugin: string;
  command: string;
  result: unknown;
  stdout?: string;
  stderr?: string;
};

export type HermesSkillResult = {
  plugin: string;
  skill: string;
  description: string;
  text: string;
};

export type HermesHookResult = {
  hook: string;
  invoked: Array<{ plugin: string; hook: string }>;
  results: unknown[];
};

export type HermesMiddlewareResult = {
  middleware: string;
  invoked: Array<{ plugin: string; middleware: string }>;
  results: unknown[];
};

export type HermesRuntimeContext = {
  workspace?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  model?: string;
  provider?: string;
  env?: Record<string, string>;
};

type BridgeRequest =
  | { op: "list"; installDir: string }
  | {
      op: "call";
      installDir: string;
      plugin?: string;
      tool: string;
      args: unknown;
      context?: HermesRuntimeContext;
    }
  | {
      op: "command";
      installDir: string;
      plugin?: string;
      command: string;
      args: unknown;
      context?: HermesRuntimeContext;
    }
  | {
      op: "cliCommand";
      installDir: string;
      plugin?: string;
      command: string;
      args: string[];
      context?: HermesRuntimeContext;
    }
  | { op: "skill"; installDir: string; plugin?: string; skill: string }
  | {
      op: "hook";
      installDir: string;
      hook: string;
      kwargs: Record<string, unknown>;
      context?: HermesRuntimeContext;
    }
  | {
      op: "middleware";
      installDir: string;
      kind: string;
      kwargs: Record<string, unknown>;
      context?: HermesRuntimeContext;
    };

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

type BridgeResponse = { requestId: number; result?: unknown; error?: string };
type UnrefHandle = { unref(): void };

class BridgeProcess {
  private child?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private queue: Promise<void> = Promise.resolve();
  private childExit: Promise<void> = Promise.resolve();

  constructor(private readonly config: HermesBridgeConfig) {}

  waitForExit(): Promise<void> {
    return this.childExit;
  }

  request<T>(request: BridgeRequest, options: { signal?: AbortSignal }): Promise<T> {
    const result = this.queue.then(
      () => this.execute<T>(request, options),
      () => this.execute<T>(request, options),
    );
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  reset(): void {
    this.stop(new Error("Babelfish adapter reset"));
  }

  private execute<T>(request: BridgeRequest, options: { signal?: AbortSignal }): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error("Babelfish adapter call cancelled"));
    }
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stop(new Error(`Babelfish adapter timed out after ${this.config.timeoutMs}ms`));
      }, this.config.timeoutMs);
      const pending: PendingRequest = { resolve, reject, timer, signal: options.signal };
      if (options.signal) {
        pending.abort = () => this.stop(new Error("Babelfish adapter call cancelled"));
        options.signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(requestId, pending);
      child.stdin.write(`${JSON.stringify({ requestId, ...request })}\n`);
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const child = spawn(this.config.python, [helperPath], {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let exitSettled = false;
    let settleExit!: () => void;
    this.childExit = new Promise<void>((resolve) => {
      settleExit = () => {
        if (exitSettled) {
          return;
        }
        exitSettled = true;
        resolve();
      };
    });
    child.unref();
    (child.stdin as unknown as UnrefHandle).unref();
    (child.stdout as unknown as UnrefHandle).unref();
    (child.stderr as unknown as UnrefHandle).unref();
    this.child = child;
    child.stdin.on("error", () => undefined);
    child.stderr.pipe(process.stderr);
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.on("error", (error) => {
      if (child.pid === undefined) {
        settleExit();
      }
      this.stop(error);
    });
    child.on("exit", () => settleExit());
    child.on("close", (code) => {
      settleExit();
      if (this.child === child) {
        this.stop(new Error(`Babelfish adapter exited with ${code}`));
      }
    });
    return child;
  }

  private handleLine(line: string): void {
    let response: BridgeResponse;
    try {
      response = JSON.parse(line) as BridgeResponse;
    } catch (error) {
      this.stop(new Error(`Babelfish adapter returned invalid JSON: ${(error as Error).message}`));
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(response.requestId);
    this.cleanupPending(pending);
    if (response.error) {
      pending.reject(new Error(response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }

  private stop(error: Error): void {
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const bridgeProcesses = new Map<string, BridgeProcess>();

function bridgeKey(config: HermesBridgeConfig): string {
  return JSON.stringify([config.python, config.installDir, config.timeoutMs, config.env]);
}

function requestLane(request: BridgeRequest): string {
  if (!("context" in request) || !request.context) {
    return "global";
  }
  return request.context.sessionKey ?? request.context.sessionId ?? request.context.agentId ?? "global";
}

function contextLane(context: HermesRuntimeContext): string | undefined {
  return context.sessionKey ?? context.sessionId ?? context.agentId;
}

export type HermesHelperOptions = {
  signal?: AbortSignal;
  isolated?: boolean;
  waitForExit?: boolean;
  onOccupancy?: (occupancy: Promise<void>) => void;
};

function runHelper<T>(
  config: HermesBridgeConfig,
  request: BridgeRequest,
  options: HermesHelperOptions = {},
): Promise<T> {
  if (options.isolated) {
    const bridge = new BridgeProcess(config);
    if (options.waitForExit) {
      const result = bridge.request<T>(request, options);
      const occupancy = result
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(async () => {
          bridge.reset();
          await bridge.waitForExit();
        })
        .then(
          () => undefined,
          () => undefined,
        );
      options.onOccupancy?.(occupancy);
      return result;
    }
    return bridge.request<T>(request, options).finally(() => bridge.reset());
  }
  const key = `${bridgeKey(config)}:${requestLane(request)}`;
  let bridge = bridgeProcesses.get(key);
  if (!bridge) {
    bridge = new BridgeProcess(config);
    bridgeProcesses.set(key, bridge);
  }
  return bridge.request<T>(request, options);
}

export function listHermesPlugins(config: HermesBridgeConfig): Promise<HermesListResult> {
  return runHelper(config, { op: "list", installDir: config.installDir }, { isolated: true });
}

export function releaseHermesBridge(
  config: HermesBridgeConfig,
  context: HermesRuntimeContext,
): void {
  const lane = contextLane(context);
  if (!lane) {
    return;
  }
  const key = `${bridgeKey(config)}:${lane}`;
  bridgeProcesses.get(key)?.reset();
  bridgeProcesses.delete(key);
}

export function callHermesTool(
  config: HermesBridgeConfig,
  params: { plugin?: string; tool: string; args: unknown; context?: HermesRuntimeContext },
  options?: HermesHelperOptions,
): Promise<HermesCallResult> {
  return runHelper(config, {
    op: "call",
    installDir: config.installDir,
    plugin: params.plugin,
    tool: params.tool,
    args: params.args,
    context: params.context,
  }, options);
}

export function callHermesCommand(
  config: HermesBridgeConfig,
  params: { plugin?: string; command: string; args: unknown; context?: HermesRuntimeContext },
  options?: HermesHelperOptions,
): Promise<HermesCommandResult> {
  return runHelper(config, {
    op: "command",
    installDir: config.installDir,
    plugin: params.plugin,
    command: params.command,
    args: params.args,
    context: params.context,
  }, options);
}

export function callHermesCliCommand(
  config: HermesBridgeConfig,
  params: { plugin?: string; command: string; args: string[]; context?: HermesRuntimeContext },
  options?: { signal?: AbortSignal },
): Promise<HermesCommandResult> {
  return runHelper(config, {
    op: "cliCommand",
    installDir: config.installDir,
    plugin: params.plugin,
    command: params.command,
    args: params.args,
    context: params.context,
  }, options);
}

export function readHermesSkill(
  config: HermesBridgeConfig,
  params: { plugin?: string; skill: string },
): Promise<HermesSkillResult> {
  return runHelper(config, {
    op: "skill",
    installDir: config.installDir,
    plugin: params.plugin,
    skill: params.skill,
  });
}

export function invokeHermesHook(
  config: HermesBridgeConfig,
  params: { hook: string; kwargs: Record<string, unknown>; context?: HermesRuntimeContext },
): Promise<HermesHookResult> {
  return runHelper(config, {
    op: "hook",
    installDir: config.installDir,
    hook: params.hook,
    kwargs: params.kwargs,
    context: params.context,
  });
}

export function invokeHermesMiddleware(
  config: HermesBridgeConfig,
  params: { kind: string; kwargs: Record<string, unknown>; context?: HermesRuntimeContext },
): Promise<HermesMiddlewareResult> {
  return runHelper(config, {
    op: "middleware",
    installDir: config.installDir,
    kind: params.kind,
    kwargs: params.kwargs,
    context: params.context,
  });
}
