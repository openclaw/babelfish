import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const failureSources = {
  import: "raise RuntimeError('import failed')\n",
  register: "def register(ctx):\n    raise RuntimeError('register failed')\n",
  callback: "def register(ctx):\n    def guard(**kwargs):\n        raise RuntimeError('callback failed')\n    ctx.register_hook('pre_tool_call', guard)\n",
  middleware: "def register(ctx):\n    def guard(**kwargs):\n        raise RuntimeError('middleware failed')\n    ctx.register_middleware('tool_request', guard)\n",
  exit: "import os\nos._exit(7)\n",
  timeout: "import time\ntime.sleep(5)\n",
  malformed: "import os, time\nos.write(1, b'not-json\\n')\ntime.sleep(5)\n",
  envelope: "import os, time\nos.write(1, b'null\\n')\ntime.sleep(5)\n",
};

describe("Hermes decision-provider availability", () => {
  it.each(["empty", "missing", "installed", "incomplete", ...Object.keys(failureSources)])(
    "handles %s without treating a failed guard as permission",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-bridge-"));
      const installDir = path.join(root, "hermes");
      const usesPython = kind in failureSources;
      vi.stubEnv("OPENCLAW_BABELFISH_ROOT", root);
      vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", installDir);
      vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PYTHON", usesPython ? "python3" : path.join(root, "missing-python"));
      vi.stubEnv("OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS", "1000");
      let release: (() => void) | undefined;
      try {
        if (kind !== "missing") await fs.mkdir(installDir);
        if (kind === "incomplete") {
          await fs.mkdir(path.join(installDir, "incomplete"));
          await fs.writeFile(path.join(installDir, "incomplete", "plugin.yaml"), "name: incomplete\n");
        } else if (kind === "installed" || usesPython) {
          await writePlugin(installDir, "guard", usesPython
            ? failureSources[kind as keyof typeof failureSources]
            : "def register(ctx):\n    ctx.register_hook('pre_tool_call', lambda **kwargs: {'action':'block'})\n");
        }
        vi.resetModules();
        const entry = (await import("./index.js")).default;
        const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
        entry.register({
          logger: { warn: () => undefined },
          on: (name, handler) => { hooks.set(name, handler); },
          registerTool: () => undefined, registerCommand: () => undefined,
          registerCli: () => undefined, registerAgentToolResultMiddleware: () => undefined,
        });
        const session = { sessionId: `session-${kind}` };
        const { releaseHermesBridge } = await import("./hermes-python.js");
        const { resolveConfig } = await import("./config.js");
        release = () => releaseHermesBridge(resolveConfig(undefined), session);
        const result = hooks.get("before_tool_call")!({ toolName: "fixture", params: {} }, session);
        if (kind === "empty" || kind === "missing") {
          await expect(result).resolves.toBeUndefined();
        } else {
          await expect(result).rejects.toThrow();
        }
      } finally {
        release?.();
        vi.unstubAllEnvs();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("still reports observer callback failures without discarding later observer results", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-observer-"));
    // This checks observer results, not Python's cold-start latency.
    const config = { rootDir: root, installDir: root, python: "python3", timeoutMs: 10000, env: {} };
    const session = { sessionId: "observer" };
    const { invokeHermesHook, invokeHermesMiddleware, releaseHermesBridge } = await import("./hermes-python.js");
    try {
      await writePlugin(root, "observer", [
        "def register(ctx):",
        "    def fail(**kwargs):",
        "        raise RuntimeError('observer failed')",
        "    ctx.register_hook('post_tool_call', fail)",
        "    ctx.register_hook('post_tool_call', lambda **kwargs: 'later hook')",
        "    ctx.register_middleware('tool_result', fail)",
        "    ctx.register_middleware('tool_result', lambda **kwargs: 'later middleware')",
        "",
      ].join("\n"));
      await expect(invokeHermesHook(config, { hook: "post_tool_call", kwargs: {}, context: session }))
        .resolves.toMatchObject({ results: ["later hook"] });
      await expect(invokeHermesMiddleware(config, { kind: "tool_result", kwargs: {}, context: session }))
        .resolves.toMatchObject({ results: ["later middleware"] });
    } finally {
      releaseHermesBridge(config, session);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

async function writePlugin(installDir: string, name: string, source: string): Promise<void> {
  const pluginDir = path.join(installDir, name);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.yaml"), `name: ${name}\nversion: 1.0.0\ndescription: ${name}\n`);
  await fs.writeFile(path.join(pluginDir, "__init__.py"), source);
}
