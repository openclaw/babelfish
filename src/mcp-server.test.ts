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
});
