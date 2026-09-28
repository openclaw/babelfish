import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bundle = vi.hoisted(() => ({
  list: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./bundle-plugins.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bundle-plugins.js")>();
  return {
    ...original,
    listBundlePlugins: bundle.list,
    invokeBundleHooks: bundle.invoke,
  };
});
vi.mock("./hermes-python.js", () => ({
  invokeHermesHook: vi.fn(async () => ({ results: [] })),
  invokeHermesMiddleware: vi.fn(async () => ({ results: [] })),
  listHermesPlugins: vi.fn(async () => ({ plugins: [] })),
  releaseHermesBridge: vi.fn(),
  callHermesCliCommand: vi.fn(),
  callHermesCommand: vi.fn(),
}));

const skillBody = "# using-superpowers\nRead this skill before answering.";
const pluginPath = path.join(process.cwd(), "test", "fixtures", "superpowers-first-prompt");
const plugin = {
  app: "claude-code",
  key: "superpowers",
  path: pluginPath,
  monitors: [],
};

async function registerHooks() {
  vi.resetModules();
  const { default: entry } = await import("./index.js");
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  entry.register({
    on: (name, handler) => hooks.set(name, handler),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerCli: vi.fn(),
    registerAgentToolResultMiddleware: vi.fn(),
  });
  return async (name: string, event: unknown, ctx: unknown) => {
    const hook = hooks.get(name);
    if (!hook) throw new Error(`Missing ${name} hook`);
    return hook(event, ctx);
  };
}

beforeEach(() => {
  bundle.list.mockReset().mockResolvedValue([plugin]);
  bundle.invoke.mockReset().mockImplementation(async (_config, eventName) =>
    eventName === "SessionStart"
      ? [{ hookSpecificOutput: { additionalContext: `${skillBody}\nSessionStart guidance` } }]
      : [],
  );
});

describe("imported Superpowers first prompt", () => {
  it("does not block a raw run that intentionally skips prompt building", async () => {
    const call = await registerHooks();
    await expect(call("before_agent_run", { prompt: "exact raw prompt" }, {
      sessionId: "raw-model-run",
      runId: "raw-1",
    })).resolves.toEqual({ outcome: "pass" });
  });

  it("blocks when plugin discovery failed during a normal prompt build", async () => {
    bundle.list.mockRejectedValueOnce(new Error("temporary scan failure"));
    const call = await registerHooks();
    const ctx = { sessionId: "failed-prompt-build", runId: "run-1" };
    await expect(call("before_prompt_build", {}, ctx)).rejects.toThrow("temporary scan failure");
    await expect(call("before_agent_run", { prompt: "hello" }, ctx)).resolves.toMatchObject({
      outcome: "block",
    });
  });

  it("injects complete SessionStart guidance on the first turn and gates the final prompt", async () => {
    const call = await registerHooks();
    const ctx = { sessionId: "first-prompt", runId: "run-1" };
    const prepared = await call("before_prompt_build", {}, ctx);
    expect(prepared).toEqual({ prependContext: `${skillBody}\nSessionStart guidance` });
    await expect(call("before_agent_run", { prompt: "hello" }, ctx)).resolves.toMatchObject({
      outcome: "block",
    });
    const retry = await call("before_prompt_build", {}, { ...ctx, runId: "run-2" });
    expect(retry).toEqual({ prependContext: `${skillBody}\nSessionStart guidance` });
    await expect(call("before_agent_run", {
      prompt: `hello\n${skillBody}\nSessionStart guidance`,
    }, { ...ctx, runId: "run-2" })).resolves.toEqual({ outcome: "pass" });
  });

  it("commits delivery only after a successful agent_end", async () => {
    const call = await registerHooks();
    const ctx = { sessionId: "successful-first-prompt", runId: "run-1" };
    const prepared = await call("before_prompt_build", {}, ctx);
    await expect(call("before_agent_run", {
      prompt: `hello\n${(prepared as { prependContext: string }).prependContext}`,
    }, ctx)).resolves.toEqual({ outcome: "pass" });
    await call("agent_end", { success: true }, ctx);
    expect(await call("before_prompt_build", {}, { ...ctx, runId: "run-2" })).toBeUndefined();
    await expect(call("before_agent_run", { prompt: "follow up" }, {
      ...ctx, runId: "run-2",
    })).resolves.toEqual({ outcome: "pass" });
  });

  it("reinjects after a failed agent_end even when its gate passed", async () => {
    const call = await registerHooks();
    const ctx = { sessionId: "failed-first-prompt", runId: "run-1" };
    const prepared = await call("before_prompt_build", {}, ctx);
    await call("before_agent_run", {
      prompt: (prepared as { prependContext: string }).prependContext,
    }, ctx);
    await call("agent_end", { success: false }, ctx);
    expect(await call("before_prompt_build", {}, { ...ctx, runId: "run-2" })).toEqual({
      prependContext: `${skillBody}\nSessionStart guidance`,
    });
  });

  it("retries when a CLI run fails after prompt build but before the gate", async () => {
    const call = await registerHooks();
    const first = { sessionId: "cli-preparation-failed", runId: "run-1" };
    const guidance = (await call("before_prompt_build", {}, first) as {
      prependContext: string;
    }).prependContext;
    const next = { ...first, runId: "run-2" };
    expect(await call("before_prompt_build", {}, next)).toEqual({ prependContext: guidance });
    await expect(call("before_agent_run", { prompt: guidance }, first)).resolves.toMatchObject({
      outcome: "block",
    });
    await expect(call("before_agent_run", { prompt: guidance }, next)).resolves.toEqual({
      outcome: "pass",
    });
  });

  it("keeps an active gate's first-prompt ownership", async () => {
    let finishGate: ((value: object[]) => void) | undefined;
    bundle.invoke.mockImplementation(async (_config, eventName) => {
      if (eventName === "SessionStart") {
        return [{ hookSpecificOutput: { additionalContext: `${skillBody}\nSessionStart guidance` } }];
      }
      if (eventName === "UserPromptSubmit") {
        return new Promise<object[]>((resolve) => { finishGate = resolve; });
      }
      return [];
    });
    const call = await registerHooks();
    const first = { sessionId: "active-gate", runId: "run-1" };
    const guidance = (await call("before_prompt_build", {}, first) as {
      prependContext: string;
    }).prependContext;
    const gate = call("before_agent_run", { prompt: guidance }, first);
    await vi.waitFor(() => expect(finishGate).toBeTypeOf("function"));
    expect(await call("before_prompt_build", {}, { ...first, runId: "run-2" })).toBeUndefined();
    finishGate?.([]);
    await expect(gate).resolves.toEqual({ outcome: "pass" });
  });

  it("retries when a CLI run passes the gate but never emits agent_end", async () => {
    const call = await registerHooks();
    const first = { sessionId: "cli-post-gate-failed", runId: "run-1" };
    const guidance = (await call("before_prompt_build", {}, first) as {
      prependContext: string;
    }).prependContext;
    await expect(call("before_agent_run", { prompt: guidance }, first)).resolves.toEqual({
      outcome: "pass",
    });
    const next = { ...first, runId: "run-2" };
    expect(await call("before_prompt_build", {}, next)).toEqual({ prependContext: guidance });
    await expect(call("before_agent_run", { prompt: guidance }, next)).resolves.toEqual({
      outcome: "pass",
    });
  });

  it("does not cache a failed or empty plugin discovery", async () => {
    bundle.list.mockRejectedValueOnce(new Error("temporary scan failure"))
      .mockResolvedValueOnce([]);
    const call = await registerHooks();
    const ctx = { sessionId: "scan-retry", runId: "run-1" };
    await expect(call("before_prompt_build", {}, ctx)).rejects.toThrow("temporary scan failure");
    expect(await call("before_prompt_build", {}, ctx)).toBeUndefined();
    expect(await call("before_prompt_build", {}, ctx)).toEqual({
      prependContext: `${skillBody}\nSessionStart guidance`,
    });
  });

  it("retries when the first SessionStart hook fails", async () => {
    bundle.invoke.mockRejectedValueOnce(new Error("temporary hook failure"));
    const call = await registerHooks();
    const ctx = { sessionId: "hook-retry", runId: "run-1" };
    await expect(call("before_prompt_build", {}, ctx)).rejects.toThrow("temporary hook failure");
    expect(await call("before_prompt_build", {}, { ...ctx, runId: "run-2" })).toEqual({
      prependContext: `${skillBody}\nSessionStart guidance`,
    });
  });

  it("does not let a stale gate delete a newer first-prompt entry", async () => {
    let finishOldHook: ((value: object[]) => void) | undefined;
    bundle.invoke.mockImplementation(async (_config, eventName) => {
      if (eventName === "SessionStart") {
        return [{ hookSpecificOutput: { additionalContext: `${skillBody}\nSessionStart guidance` } }];
      }
      if (eventName === "UserPromptSubmit") {
        if (!finishOldHook) {
          return new Promise<object[]>((resolve) => { finishOldHook = resolve; });
        }
      }
      return [];
    });
    const call = await registerHooks();
    const ctx = { sessionId: "stale-gate", runId: "run-1" };
    const guidance = (await call("before_prompt_build", {}, ctx) as { prependContext: string }).prependContext;
    const oldGate = call("before_agent_run", { prompt: guidance }, ctx);
    await vi.waitFor(() => expect(finishOldHook).toBeTypeOf("function"));
    await call("agent_end", { success: false }, ctx);
    const newer = { ...ctx, runId: "run-2" };
    expect(await call("before_prompt_build", {}, newer)).toEqual({ prependContext: guidance });
    finishOldHook?.([]);
    await expect(oldGate).resolves.toMatchObject({ outcome: "block" });
    await expect(call("before_agent_run", { prompt: guidance }, newer)).resolves.toEqual({
      outcome: "pass",
    });
  });
});
