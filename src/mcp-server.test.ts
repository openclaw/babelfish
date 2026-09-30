import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildHermesMcpToolIndex, createHermesMcpServer, MAX_RUNNING_TASKS } from "./mcp-server.js";
import * as hermesPython from "./hermes-python.js";

async function copyFixture(target: string, fixtureName: string, installedName: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures", fixtureName);
  await fs.cp(fixture, path.join(target, installedName), { recursive: true });
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
  it("keeps unique tool names and prefixes collisions", () => {
    const index = buildHermesMcpToolIndex({
      installDir: "/tmp/hermes",
      plugins: [
        {
          key: "one",
          name: "one",
          version: "",
          description: "",
          path: "/tmp/hermes/one",
          tools: [
            {
              name: "shared",
              toolset: "one",
              description: "one shared",
              schema: { parameters: { type: "object", properties: {} } },
              isAsync: false,
              requiresEnv: [],
              available: true,
            },
            {
              name: "unique",
              toolset: "one",
              description: "unique",
              schema: { parameters: { type: "object", properties: {} } },
              isAsync: false,
              requiresEnv: [],
              available: true,
            },
            {
              name: "unavailable",
              toolset: "one",
              description: "unavailable",
              schema: { parameters: { type: "object", properties: {} } },
              isAsync: false,
              requiresEnv: ["MISSING"],
              available: false,
            },
          ],
          hooks: [],
          middleware: [],
          commands: [],
          cliCommands: [],
          skills: [],
          unsupported: [],
        },
        {
          key: "two",
          name: "two",
          version: "",
          description: "",
          path: "/tmp/hermes/two",
          tools: [
            {
              name: "shared",
              toolset: "two",
              description: "two shared",
              schema: { parameters: { type: "object", properties: {} } },
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
          unsupported: [],
        },
      ],
    });

    expect(index.tools.map((tool) => tool.name)).toEqual(["one__shared", "two__shared", "unique"]);
  });

  it("suffixes collisions after plugin names are sanitized", () => {
    const plugin = (key: string) => ({
      key,
      name: key,
      version: "",
      description: "",
      path: `/tmp/${key}`,
      tools: [
        {
          name: "shared",
          toolset: key,
          description: "shared",
          schema: { parameters: { type: "object", properties: {} } },
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
    });
    const index = buildHermesMcpToolIndex({
      installDir: "/tmp/plugins",
      plugins: [plugin("a.b"), plugin("a_b")],
    });

    expect(index.tools.map((tool) => tool.name)).toEqual(["a_b__shared", "a_b__shared_2"]);
    expect(index.toolRoutes.get("a_b__shared")?.plugin).toBe("a.b");
    expect(index.toolRoutes.get("a_b__shared_2")?.plugin).toBe("a_b");
  });

  it("serves installed Hermes tools over MCP", { timeout: 15_000 }, async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-"));
    await copyFixture(installDir, "simple-hermes-plugin", "simple");

    const server = createHermesMcpServer({
      installDir,
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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

      await expect(
        client.callTool({
          name: "babelfish_command__hermes__simple__simple",
          arguments: { args: "from-command" },
        }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: '{\n  "command": "from-command"\n}' }],
      });

      const started = await client.callTool({
        name: "babelfish_task_start",
        arguments: { kind: "tool", name: "simple_echo", args: { value: "task-ok" } },
      });
      const task = JSON.parse(String(started.content?.[0]?.text));
      expect(task.status).toBe("running");

      let finalStatus = "running";
      for (let attempt = 0; attempt < 100 && finalStatus === "running"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const status = await client.callTool({
          name: "babelfish_task_status",
          arguments: { id: task.id },
        });
        finalStatus = JSON.parse(String(status.content?.[0]?.text)).status;
      }
      expect(finalStatus).toBe("completed");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a ninth concurrent babelfish_task_start", async () => {
    const spy = vi.spyOn(hermesPython, "callHermesTool").mockImplementation((_config, _params, options) => {
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (options?.signal?.aborted) {
          abort();
          return;
        }
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const server = createHermesMcpServer({
      installDir: await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-cap-")),
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const startedIds: string[] = [];

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (options?.signal?.aborted) {
          abort();
          return;
        }
        options?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const server = createHermesMcpServer({
      installDir: await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-publish-")),
      python: "python3",
      timeoutMs: 10000,
      env: {},
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const startedIds: string[] = [];

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
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

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a stopped child is still exiting",
    { timeout: 45_000 },
    async () => {
      const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-hold-"));
      const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-hold-markers-"));
      await writeHoldPlugin(installDir);
      const server = createHermesMcpServer({
        installDir,
        python: "python3",
        timeoutMs: 30_000,
        env: {},
      });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const startedIds: string[] = [];
      const pids: number[] = [];

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const markers: string[] = [];
        for (let index = 0; index < MAX_RUNNING_TASKS; index += 1) {
          const marker = path.join(markerRoot, `stop-${index}`);
          markers.push(marker);
          const started = await client.callTool({
            name: "babelfish_task_start",
            arguments: {
              kind: "tool",
              name: "hold_until_term",
              args: { marker, hold_sec: 2 },
            },
          });
          expect(started.isError).toBeFalsy();
          const task = JSON.parse(String(started.content?.[0]?.text));
          expect(task.status).toBe("running");
          startedIds.push(task.id);
        }
        for (const marker of markers) {
          pids.push(await waitForPidFile(marker));
        }

        const dyingId = startedIds.pop();
        const dyingPid = pids.pop();
        expect(dyingId).toBeTruthy();
        expect(dyingPid).toBeTruthy();
        const stopped = await client.callTool({
          name: "babelfish_task_stop",
          arguments: { id: dyingId },
        });
        expect(JSON.parse(String(stopped.content?.[0]?.text)).status).toBe("stopped");
        expect(pidAlive(dyingPid as number)).toBe(true);

        const overflow = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "stop-overflow"), hold_sec: 2 },
          },
        });
        expect(overflow.isError).toBe(true);
        expect(overflowError(overflow)).toBe(`Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`);

        await waitForProcessExit(dyingPid as number);
        const resumed = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "stop-resumed"), hold_sec: 2 },
          },
        });
        expect(resumed.isError).toBeFalsy();
        const resumedTask = JSON.parse(String(resumed.content?.[0]?.text));
        expect(resumedTask.status).toBe("running");
        startedIds.push(resumedTask.id);
        pids.push(await waitForPidFile(path.join(markerRoot, "stop-resumed")));
      } finally {
        await stopTasksAndKill(client, startedIds, pids);
        await client.close();
        await server.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a completed helper is still exiting",
    { timeout: 45_000 },
    async () => {
      const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-done-"));
      const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-done-markers-"));
      await writeHoldPlugin(installDir);
      const server = createHermesMcpServer({
        installDir,
        python: "python3",
        timeoutMs: 30_000,
        env: {},
      });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const startedIds: string[] = [];
      const pids: number[] = [];

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const holdMarkers: string[] = [];
        for (let index = 0; index < MAX_RUNNING_TASKS - 1; index += 1) {
          const marker = path.join(markerRoot, `done-hold-${index}`);
          holdMarkers.push(marker);
          const started = await client.callTool({
            name: "babelfish_task_start",
            arguments: {
              kind: "tool",
              name: "hold_until_term",
              args: { marker, hold_sec: 2 },
            },
          });
          expect(started.isError).toBeFalsy();
          const task = JSON.parse(String(started.content?.[0]?.text));
          expect(task.status).toBe("running");
          startedIds.push(task.id);
        }
        for (const marker of holdMarkers) {
          pids.push(await waitForPidFile(marker));
        }

        const completingMarker = path.join(markerRoot, "done-complete");
        const completing = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "return_then_hold",
            args: { marker: completingMarker, hold_sec: 2 },
          },
        });
        expect(completing.isError).toBeFalsy();
        const completingTask = JSON.parse(String(completing.content?.[0]?.text));
        startedIds.push(completingTask.id);
        const completingPid = await waitForPidFile(completingMarker);
        pids.push(completingPid);
        expect(pidAlive(completingPid)).toBe(true);

        const doneDeadline = Date.now() + 5_000;
        let completingSnap: { status?: string } = {};
        while (Date.now() < doneDeadline && pidAlive(completingPid)) {
          const status = await client.callTool({
            name: "babelfish_task_status",
            arguments: { id: completingTask.id },
          });
          completingSnap = JSON.parse(String(status.content?.[0]?.text));
          if (completingSnap.status === "completed") {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(completingSnap.status).toBe("completed");
        expect(pidAlive(completingPid)).toBe(true);

        const overflow = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "done-overflow"), hold_sec: 2 },
          },
        });
        expect(overflow.isError).toBe(true);
        expect(overflowError(overflow)).toBe(`Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`);

        await waitForProcessExit(completingPid);
        const resumed = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "done-resumed"), hold_sec: 2 },
          },
        });
        expect(resumed.isError).toBeFalsy();
        const resumedTask = JSON.parse(String(resumed.content?.[0]?.text));
        expect(resumedTask.status).toBe("running");
        startedIds.push(resumedTask.id);
        pids.push(await waitForPidFile(path.join(markerRoot, "done-resumed")));
      } finally {
        await stopTasksAndKill(client, startedIds, pids);
        await client.close();
        await server.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a replacement start while a timed-out helper is still exiting",
    { timeout: 60_000 },
    async () => {
      const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-mcp-timeout-"));
      const markerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-timeout-markers-"));
      await writeHoldPlugin(installDir);
      const server = createHermesMcpServer({
        installDir,
        python: "python3",
        timeoutMs: 4_000,
        env: {},
      });
      const client = new Client({ name: "test", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const startedIds: string[] = [];
      const pids: number[] = [];

      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const markers: string[] = [];
        const launchedAt = Date.now();
        for (let index = 0; index < MAX_RUNNING_TASKS; index += 1) {
          const marker = path.join(markerRoot, `timeout-${index}`);
          markers.push(marker);
          const started = await client.callTool({
            name: "babelfish_task_start",
            arguments: {
              kind: "tool",
              name: "hold_until_term",
              args: { marker, hold_sec: 2 },
            },
          });
          expect(started.isError).toBeFalsy();
          const task = JSON.parse(String(started.content?.[0]?.text));
          expect(task.status).toBe("running");
          startedIds.push(task.id);
        }
        for (const marker of markers) {
          pids.push(await waitForPidFile(marker));
        }

        const timedOutPid = pids[0];
        while (Date.now() < launchedAt + 4_200) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(pidAlive(timedOutPid as number)).toBe(true);

        const overflow = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "timeout-overflow"), hold_sec: 2 },
          },
        });
        expect(overflow.isError).toBe(true);
        expect(overflowError(overflow)).toBe(`Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`);

        await waitForProcessExit(timedOutPid as number);
        const remaining = pids.slice(1);
        await Promise.all(remaining.map((pid) => waitForProcessExit(pid)));
        const resumed = await client.callTool({
          name: "babelfish_task_start",
          arguments: {
            kind: "tool",
            name: "hold_until_term",
            args: { marker: path.join(markerRoot, "timeout-resumed"), hold_sec: 2 },
          },
        });
        expect(resumed.isError).toBeFalsy();
        const resumedTask = JSON.parse(String(resumed.content?.[0]?.text));
        expect(resumedTask.status).toBe("running");
        startedIds.push(resumedTask.id);
        pids.push(await waitForPidFile(path.join(markerRoot, "timeout-resumed")));
      } finally {
        await stopTasksAndKill(client, startedIds, pids);
        await client.close();
        await server.close();
      }
    },
  );
});
