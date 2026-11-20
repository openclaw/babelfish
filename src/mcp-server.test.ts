import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyFixture, pluginSummary, toolSummary } from "../test/hermes-fixtures.js";
import { buildHermesMcpToolIndex, createHermesMcpServer, MAX_RUNNING_TASKS } from "./mcp-server.js";
import { buildNativeToolEntries } from "./native-tools.js";
import * as hermesPython from "./hermes-python.js";

async function connectTestClient(server: ReturnType<typeof createHermesMcpServer>): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function writeHoldPlugin(installDir: string): Promise<void> {
  const pluginDir = path.join(installDir, "hold");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "plugin.yaml"), "name: hold\nversion: 0.0.0\n");
  await fs.writeFile(
    path.join(pluginDir, "__init__.py"),
    [
      "import os",
      "import signal",
      "import time",
      "from pathlib import Path",
      "",
      "def _install_term_hold(args):",
      "    marker = Path(str(args['marker']))",
      "    hold_sec = float(args.get('hold_sec', 2))",
      "    def _term(_signum, _frame):",
      "        time.sleep(hold_sec)",
      "        marker.with_suffix('.exited').write_text('1', encoding='utf-8')",
      "        os._exit(0)",
      "    signal.signal(signal.SIGTERM, _term)",
      "    marker.with_suffix('.pid').write_text(str(os.getpid()), encoding='utf-8')",
      "",
      "def _hold(args):",
      "    _install_term_hold(args)",
      "    while True:",
      "        time.sleep(30)",
      "",
      "def _return_then_hold(args):",
      "    _install_term_hold(args)",
      "    return {'held': True}",
      "",
      "def register(ctx):",
      "    schema = {",
      "        'type': 'object',",
      "        'properties': {",
      "            'marker': {'type': 'string'},",
      "            'hold_sec': {'type': 'number'},",
      "        },",
      "        'required': ['marker'],",
      "    }",
      "    ctx.register_tool(name='hold_until_term', toolset='hold', schema=schema, handler=_hold)",
      "    ctx.register_tool(name='return_then_hold', toolset='hold', schema=schema, handler=_return_then_hold)",
      "",
    ].join("\n"),
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(marker: string, timeoutMs = 15_000): Promise<number> {
  const pidPath = `${marker}.pid`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await fs.readFile(pidPath, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        return pid;
      }
    } catch {
      // plugin has not written the pid yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for pid file ${pidPath}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function overflowError(result: { isError?: boolean; content?: Array<{ text?: string }> }): string {
  return String(result.content?.[0]?.text ?? "");
}

async function stopTasksAndKill(
  client: Client,
  ids: string[],
  pids: number[],
): Promise<void> {
  for (const id of ids) {
    await client.callTool({ name: "babelfish_task_stop", arguments: { id } }).catch(() => undefined);
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.all(pids.map((pid) => waitForProcessExit(pid, 5_000).catch(() => undefined)));
}

describe("Hermes MCP server", () => {
  it("runs commands and background tasks through built stdio", { timeout: 30_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-command-stdio-"));
    const installDir = path.join(root, "plugins");
    const runtime = path.join(root, "runtime");
    const client = new Client({ name: "command-stdio-test", version: "0.0.0" });
    try {
      await copyFixture(installDir);
      for (const file of ["python", "package.json"]) {
        await fs.cp(path.join(process.cwd(), file), path.join(runtime, file), { recursive: true });
      }
      await build({
        entryPoints: ["src/bin.ts"],
        outfile: path.join(runtime, "dist", "bin.js"),
        bundle: true,
        external: ["@modelcontextprotocol/sdk/*"],
        format: "esm",
        packages: "bundle",
        platform: "node",
        banner: { js: "#!/usr/bin/env node" },
      });
      await fs.symlink(await fs.realpath("node_modules"), path.join(runtime, "node_modules"), "junction");
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(runtime, "dist", "bin.js"), "mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_BABELFISH_ROOT: root,
          OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR: installDir,
          OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS: "10000",
        },
        stderr: "pipe",
      });
      await client.connect(transport);
      const name = "babelfish_command__hermes__simple__simple";
      for (const args of [undefined, {}, { args: "" }, { args: "explicit text" }]) {
        const result = await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(String(result.content?.[0]?.text))).toEqual({ command: args?.args ?? "" });
      }
      // Real background tasks hold process-wide slots until their Python children exit.
      for (const [args, expected] of [
        [{ kind: "command", plugin: "simple", name: "simple" }, { command: "simple", result: { command: "" } }],
        [{ kind: "tool", name: "simple_echo", args: { value: "task-ok" } }, { tool: "simple_echo", parsedResult: { echo: "task-ok" } }],
      ] as const) {
        const started = await client.callTool({ name: "babelfish_task_start", arguments: args });
        expect(started.isError).toBeFalsy();
        const task = JSON.parse(String(started.content?.[0]?.text));
        expect(task.status).toBe("running");
        const final = await vi.waitUntil(async () => {
          const result = await client.callTool({ name: "babelfish_task_status", arguments: { id: task.id } });
          const status = JSON.parse(String(result.content?.[0]?.text));
          return status.status === "running" ? undefined : status;
        }, { timeout: 5_000, interval: 50 });
        expect(final).toMatchObject({ status: "completed", result: { plugin: "simple", ...expected } });
      }
    } finally {
      await client.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps unique tool names and prefixes collisions", () => {
    const index = buildHermesMcpToolIndex({
      installDir: "/tmp/hermes",
      plugins: [
        pluginSummary("one", [toolSummary("shared"), toolSummary("unique"),
          toolSummary("unavailable", { available: false, requiresEnv: ["MISSING"] })]),
        pluginSummary("two", [toolSummary("shared")]),
      ],
    });

    expect(index.tools.map((tool) => tool.name)).toEqual(["one__shared", "two__shared", "unique"]);
  });

  it("keeps adapter-specific reservations and Hermes input schemas", () => {
    const parameters = { type: "object", required: ["value"] };
    const list = {
      installDir: "plugins",
      plugins: [pluginSummary("demo", [
        toolSummary("babelfish_task_stop", { schema: { function: { parameters } } }),
        toolSummary("direct", { schema: parameters }),
        toolSummary("malformed", { schema: [] }),
      ])],
    };
    const mcp = buildHermesMcpToolIndex(list);
    const native = buildNativeToolEntries(list);
    expect(mcp.toolRoutes.get("demo__babelfish_task_stop")).toEqual({ plugin: "demo", name: "babelfish_task_stop" });
    expect(native[0].name).toBe("babelfish_task_stop");
    for (const tools of [mcp.tools, native]) {
      expect(tools.map((tool) => tool.inputSchema)).toEqual([
        parameters, parameters, { type: "object", additionalProperties: true },
      ]);
    }
  });

  it("suffixes collisions after plugin names are sanitized", () => {
    const index = buildHermesMcpToolIndex({
      installDir: "/tmp/plugins",
      plugins: ["a.b", "a_b"].map((key) => pluginSummary(key, [toolSummary("shared")])),
    });

    expect(index.tools.map((tool) => tool.name)).toEqual(["a_b__shared", "a_b__shared_2"]);
    expect(index.toolRoutes.get("a_b__shared")?.plugin).toBe("a.b");
    expect(index.toolRoutes.get("a_b__shared_2")?.plugin).toBe("a_b");
  });

  it("serves installed Hermes tools over MCP", { timeout: 15_000 }, async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-"));
    await copyFixture(installDir);

    const server = createHermesMcpServer({
      installDir,
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });

    const client = await connectTestClient(server);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "babelfish_plugins_list",
        "babelfish_task_start",
        "babelfish_task_status",
        "babelfish_task_stop",
        "babelfish_command__hermes__simple__simple",
        "simple_echo",
        "simple_optional",
        "simple_state",
      ]);
      expect(
        tools.tools.find((tool) => tool.name === "babelfish_command__hermes__simple__simple")?.description,
      ).toContain("Args: <raw text>");

      const result = await client.callTool({
        name: "simple_echo",
        arguments: { value: "mcp-ok" },
      });
      expect(result.content).toEqual([{ type: "text", text: '{\n  "echo": "mcp-ok"\n}' }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a ninth concurrent babelfish_task_start", async () => {
    const spy = vi.spyOn(hermesPython, "callHermesTool").mockImplementation((_config, _params, options) => {
      return untilAborted(options?.signal);
    });

    const server = createHermesMcpServer({
      installDir: await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-cap-")),
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });
    const startedIds: string[] = [];

    const client = await connectTestClient(server);
    try {
      for (let index = 0; index < MAX_RUNNING_TASKS; index += 1) {
        const started = await client.callTool({
          name: "babelfish_task_start",
          arguments: { kind: "tool", name: "simple_echo", args: { value: `hold-${index}` } },
        });
        expect(started.isError).toBeFalsy();
        const task = JSON.parse(String(started.content?.[0]?.text));
        expect(task.status).toBe("running");
        startedIds.push(task.id);
      }

      const held = await client.callTool({
        name: "babelfish_task_status",
        arguments: { id: startedIds[0] },
      });
      expect(JSON.parse(String(held.content?.[0]?.text)).status).toBe("running");

      const overflow = await client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name: "simple_echo", args: { value: "overflow" } },
      });
      expect(overflow.isError).toBe(true);
      expect(String(overflow.content?.[0]?.text)).toBe(
        `Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`,
      );

      const released = startedIds.pop();
      await client.callTool({ name: "babelfish_task_stop", arguments: { id: released } });
      const afterStop = await client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name: "simple_echo", args: { value: "after-stop" } },
      });
      expect(afterStop.isError).toBeFalsy();
      const resumed = JSON.parse(String(afterStop.content?.[0]?.text));
      expect(resumed.status).toBe("running");
      startedIds.push(resumed.id);
    } finally {
      for (const id of startedIds) {
        await client.callTool({ name: "babelfish_task_stop", arguments: { id } });
      }
      spy.mockRestore();
      await client.close();
      await server.close();
    }
  });

  it("publishes a completed status while occupancy still holds the slot", async () => {
    let releaseOccupancy: (() => void) | undefined;
    const spy = vi.spyOn(hermesPython, "callHermesTool").mockImplementation((_config, params, options) => {
      const name = params.tool;
      if (name === "complete_now") {
        const occupancy = new Promise<void>((resolve) => {
          releaseOccupancy = resolve;
        });
        options?.onOccupancy?.(occupancy);
        return Promise.resolve({
          plugin: "hold",
          tool: name,
          result: { held: true },
        });
      }
      return untilAborted(options?.signal);
    });

    const server = createHermesMcpServer({
      installDir: await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-publish-")),
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });
    const startedIds: string[] = [];

    const client = await connectTestClient(server);
    try {
      for (let index = 0; index < MAX_RUNNING_TASKS - 1; index += 1) {
        const started = await client.callTool({
          name: "babelfish_task_start",
          arguments: { kind: "tool", name: "hold_until_term", args: { value: `hold-${index}` } },
        });
        expect(started.isError).toBeFalsy();
        startedIds.push(JSON.parse(String(started.content?.[0]?.text)).id);
      }

      const completing = await client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name: "complete_now", args: {} },
      });
      expect(completing.isError).toBeFalsy();
      const completingId = JSON.parse(String(completing.content?.[0]?.text)).id;
      startedIds.push(completingId);

      const deadline = Date.now() + 2_000;
      let snapshot: { status?: string; result?: { result?: { held?: boolean } } } = {};
      while (Date.now() < deadline) {
        const status = await client.callTool({
          name: "babelfish_task_status",
          arguments: { id: completingId },
        });
        snapshot = JSON.parse(String(status.content?.[0]?.text));
        if (snapshot.status === "completed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(snapshot.status).toBe("completed");
      expect(snapshot.result?.result).toEqual({ held: true });

      const overflow = await client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name: "hold_until_term", args: { value: "overflow" } },
      });
      expect(overflow.isError).toBe(true);
      expect(overflowError(overflow)).toBe(`Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`);

      releaseOccupancy?.();
      const resumeDeadline = Date.now() + 2_000;
      let resumedOk = false;
      while (Date.now() < resumeDeadline) {
        const resumed = await client.callTool({
          name: "babelfish_task_start",
          arguments: { kind: "tool", name: "hold_until_term", args: { value: "after-exit" } },
        });
        if (!resumed.isError) {
          startedIds.push(JSON.parse(String(resumed.content?.[0]?.text)).id);
          resumedOk = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(resumedOk).toBe(true);
    } finally {
      releaseOccupancy?.();
      for (const id of startedIds) {
        await client.callTool({ name: "babelfish_task_stop", arguments: { id } }).catch(() => undefined);
      }
      spy.mockRestore();
      await client.close();
      await server.close();
    }
  });

  async function createCapacityFixture(timeoutMs: number) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-task-capacity-"));
    const installDir = path.join(root, "plugins");
    await writeHoldPlugin(installDir);
    const server = createHermesMcpServer({ installDir, rootDir: root, python: "python3", timeoutMs, env: {} });
    const client = await connectTestClient(server);
    const ids: string[] = [];
    const pids: number[] = [];
    let nextMarker = 0;

    function start(name: string, marker: string) {
      return client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name, args: { marker, hold_sec: 2 } },
      });
    }

    return {
      client, ids, pids,
      async startTasks(count: number, name = "hold_until_term") {
        const markers: string[] = [];
        for (let i = 0; i < count; i++) {
          const marker = path.join(root, String(nextMarker++));
          const started = await start(name, marker);
          expect(started.isError).toBeFalsy();
          const task = JSON.parse(String(started.content?.[0]?.text));
          expect(task.status).toBe("running");
          ids.push(task.id);
          markers.push(marker);
        }
        for (const marker of markers) pids.push(await waitForPidFile(marker));
      },
      async expectFull() {
        const overflow = await start("hold_until_term", path.join(root, "overflow"));
        expect(overflow.isError).toBe(true);
        expect(overflowError(overflow)).toBe(`Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`);
      },
      async close() {
        await stopTasksAndKill(client, ids, pids);
        await client.close();
        await server.close();
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  }

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a stopped child is still exiting",
    { timeout: 45_000 },
    async () => {
      const fixture = await createCapacityFixture(30_000);
      try {
        await fixture.startTasks(MAX_RUNNING_TASKS);
        const dyingId = fixture.ids.pop()!;
        const dyingPid = fixture.pids.pop()!;
        expect(dyingId).toBeTruthy();
        expect(dyingPid).toBeTruthy();
        const stopped = await fixture.client.callTool({
          name: "babelfish_task_stop",
          arguments: { id: dyingId },
        });
        expect(JSON.parse(String(stopped.content?.[0]?.text)).status).toBe("stopped");
        expect(pidAlive(dyingPid)).toBe(true);

        await fixture.expectFull();

        await waitForProcessExit(dyingPid);
        await fixture.startTasks(1);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a completed helper is still exiting",
    { timeout: 45_000 },
    async () => {
      const fixture = await createCapacityFixture(30_000);
      try {
        await fixture.startTasks(MAX_RUNNING_TASKS - 1);
        await fixture.startTasks(1, "return_then_hold");
        const completingId = fixture.ids.at(-1)!;
        const completingPid = fixture.pids.at(-1)!;
        expect(pidAlive(completingPid)).toBe(true);

        const doneDeadline = Date.now() + 5_000;
        let completingSnap: { status?: string } = {};
        while (Date.now() < doneDeadline && pidAlive(completingPid)) {
          const status = await fixture.client.callTool({
            name: "babelfish_task_status",
            arguments: { id: completingId },
          });
          completingSnap = JSON.parse(String(status.content?.[0]?.text));
          if (completingSnap.status === "completed") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(completingSnap.status).toBe("completed");
        expect(pidAlive(completingPid)).toBe(true);

        await fixture.expectFull();

        await waitForProcessExit(completingPid);
        await fixture.startTasks(1);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a timed-out helper is still exiting",
    { timeout: 60_000 },
    async () => {
      const fixture = await createCapacityFixture(4_000);
      try {
        const launchedAt = Date.now();
        await fixture.startTasks(MAX_RUNNING_TASKS);
        const timedOutPid = fixture.pids[0];
        while (Date.now() < launchedAt + 4_200) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(pidAlive(timedOutPid)).toBe(true);

        await fixture.expectFull();

        await waitForProcessExit(timedOutPid);
        const remaining = fixture.pids.slice(1);
        await Promise.all(remaining.map((pid) => waitForProcessExit(pid)));
        await fixture.startTasks(1);
      } finally {
        await fixture.close();
      }
    },
  );
});
