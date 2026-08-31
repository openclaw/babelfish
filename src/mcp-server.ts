import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { HermesBridgeConfig } from "./config.js";
import {
  callHermesTool,
  callHermesCommand,
  listHermesPlugins,
  type HermesListResult,
  type HermesToolSummary,
} from "./hermes-python.js";
import { syncHermesSkills } from "./skill-sync.js";

export type HermesMcpRoute = {
  plugin: string;
  name: string;
};

export type HermesMcpToolIndex = {
  tools: Tool[];
  toolRoutes: Map<string, HermesMcpRoute>;
  commandRoutes: Map<string, HermesMcpRoute>;
};

type JsonObject = Record<string, unknown>;
const BRIDGE_TOOL_NAMES = new Set([
  "babelfish_plugins_list",
  "babelfish_task_start",
  "babelfish_task_status",
  "babelfish_task_stop",
]);

type TaskState =
  | { id: string; status: "running"; startedAt: number; controller: AbortController }
  | { id: string; status: "completed"; startedAt: number; finishedAt: number; result: unknown }
  | { id: string; status: "failed"; startedAt: number; finishedAt: number; error: string }
  | { id: string; status: "stopped"; startedAt: number; finishedAt: number; error?: string };

const tasks = new Map<string, TaskState>();
const MAX_FINISHED_TASKS = 100;
export const MAX_RUNNING_TASKS = 8;
let nextTaskId = 1;

function runningTaskCount(): number {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.status === "running") {
      count += 1;
    }
  }
  return count;
}

function trimFinishedTasks(): void {
  const finished = [...tasks.values()]
    .filter((task) => task.status !== "running")
    .sort((left, right) => left.finishedAt - right.finishedAt);
  for (const task of finished.slice(0, -MAX_FINISHED_TASKS)) {
    tasks.delete(task.id);
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "plugin";
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) {
    name = `${base}_${suffix}`;
  }
  used.add(name);
  return name;
}

function inputSchemaFor(tool: HermesToolSummary): Tool["inputSchema"] {
  const schema = asObject(tool.schema);
  const parameters = asObject(schema?.parameters) ?? asObject(asObject(schema?.function)?.parameters);
  if (parameters?.type === "object") {
    return parameters as Tool["inputSchema"];
  }
  if (schema?.type === "object") {
    return schema as Tool["inputSchema"];
  }
  return { type: "object", additionalProperties: true };
}

function stringifyResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function mcpToolName(params: {
  plugin: string;
  tool: string;
  duplicates: Set<string>;
}): string {
  if (!params.duplicates.has(params.tool) && !BRIDGE_TOOL_NAMES.has(params.tool)) {
    return params.tool;
  }
  return `${sanitizeName(params.plugin)}__${sanitizeName(params.tool)}`;
}

function commandToolName(plugin: string, command: string): string {
  return `babelfish_command__hermes__${sanitizeName(plugin)}__${sanitizeName(command)}`;
}

function bridgeTools(): Tool[] {
  return [
    {
      name: "babelfish_plugins_list",
      description: "List installed app plugins and their registered surfaces.",
      inputSchema: { type: "object", additionalProperties: false },
    },
    {
      name: "babelfish_task_start",
      description: `Run an imported tool or command in the background for later polling. At most ${MAX_RUNNING_TASKS} tasks may run at once.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["tool", "command"] },
          plugin: { type: "string" },
          name: { type: "string" },
          args: { description: "Arguments passed to the Hermes tool or command." },
        },
        required: ["kind", "name"],
      },
    },
    {
      name: "babelfish_task_status",
      description: "Return the status and result for a Babelfish background task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
    {
      name: "babelfish_task_stop",
      description: "Stop a running Babelfish background task.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  ];
}

function commandTools(
  list: HermesListResult,
  usedNames: Set<string>,
): { tools: Tool[]; routes: Map<string, HermesMcpRoute> } {
  const routes = new Map<string, HermesMcpRoute>();
  const tools: Tool[] = [];
  for (const plugin of list.plugins) {
    for (const command of plugin.commands) {
      if (!command.available) {
        continue;
      }
      const name = uniqueName(commandToolName(plugin.key, command.name), usedNames);
      routes.set(name, { plugin: plugin.key, name: command.name });
      tools.push({
        name,
        description: [
          command.description || `Run imported command ${plugin.key}/${command.name}`,
          command.argsHint ? `Args: ${command.argsHint}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            args: {
              type: "string",
              description: command.argsHint || "Arguments passed to the imported command handler.",
            },
          },
        },
        _meta: {
          "babelfish/app": "hermes",
          "babelfish/plugin": plugin.key,
          "babelfish/command": command.name,
          "babelfish/argsHint": command.argsHint,
        },
      });
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { tools, routes };
}

export function buildHermesMcpToolIndex(list: HermesListResult): HermesMcpToolIndex {
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
  const toolRoutes = new Map<string, HermesMcpRoute>();
  const tools: Tool[] = [];
  const usedNames = new Set(BRIDGE_TOOL_NAMES);

  for (const plugin of list.plugins) {
    for (const hermesTool of plugin.tools) {
      if (!hermesTool.available) {
        continue;
      }
      const name = uniqueName(
        mcpToolName({ plugin: plugin.key, tool: hermesTool.name, duplicates }),
        usedNames,
      );
      toolRoutes.set(name, { plugin: plugin.key, name: hermesTool.name });
      tools.push({
        name,
        description: hermesTool.description || `Imported tool ${plugin.key}/${hermesTool.name}`,
        inputSchema: inputSchemaFor(hermesTool),
        _meta: {
          "babelfish/app": "hermes",
          "babelfish/plugin": plugin.key,
          "babelfish/tool": hermesTool.name,
          "babelfish/toolset": hermesTool.toolset,
          "babelfish/available": hermesTool.available,
          "babelfish/requiresEnv": hermesTool.requiresEnv,
        },
      });
    }
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  const commands = commandTools(list, usedNames);
  return { tools: [...commands.tools, ...tools], toolRoutes, commandRoutes: commands.routes };
}

export function createHermesMcpServer(config: HermesBridgeConfig): Server {
  const server = new Server(
    { name: "babelfish", version: "0.1.0" },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const index = buildHermesMcpToolIndex(await listHermesPlugins(config));
    return { tools: [...bridgeTools(), ...index.tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === "babelfish_plugins_list") {
      return {
        content: [
          {
            type: "text",
            text: stringifyResult({ apps: [{ app: "hermes", ...(await listHermesPlugins(config)) }] }),
          },
        ],
      };
    }

    if (request.params.name === "babelfish_task_start") {
      const args = asObject(request.params.arguments) ?? {};
      const kind = args.kind === "command" ? "command" : "tool";
      if (args.kind !== "tool" && args.kind !== "command") {
        return { isError: true, content: [{ type: "text", text: "kind must be tool or command" }] };
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return { isError: true, content: [{ type: "text", text: "name is required" }] };
      }
      if (runningTaskCount() >= MAX_RUNNING_TASKS) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Too many running Babelfish tasks (max ${MAX_RUNNING_TASKS})`,
            },
          ],
        };
      }
      const id = `hermes-task-${nextTaskId++}`;
      const startedAt = Date.now();
      const controller = new AbortController();
      tasks.set(id, { id, status: "running", startedAt, controller });
      const run =
        kind === "command"
          ? callHermesCommand(
              config,
              {
                plugin: typeof args.plugin === "string" ? args.plugin : undefined,
                command: name,
                args: args.args ?? "",
              },
              { signal: controller.signal, isolated: true },
            )
          : callHermesTool(
              config,
              {
                plugin: typeof args.plugin === "string" ? args.plugin : undefined,
                tool: name,
                args: args.args ?? {},
              },
              { signal: controller.signal, isolated: true },
            );
      void run.then(
        (result) => {
          if (tasks.get(id)?.status === "running") {
            tasks.set(id, { id, status: "completed", startedAt, finishedAt: Date.now(), result });
            trimFinishedTasks();
          }
        },
        (error: unknown) => {
          if (tasks.get(id)?.status === "running") {
            tasks.set(id, {
              id,
              status: "failed",
              startedAt,
              finishedAt: Date.now(),
              error: (error as Error).message,
            });
            trimFinishedTasks();
          }
        },
      );
      return {
        content: [{ type: "text", text: stringifyResult({ id, status: "running" }) }],
        structuredContent: { id, status: "running" },
      };
    }

    if (request.params.name === "babelfish_task_status") {
      const id = String(asObject(request.params.arguments)?.id ?? "");
      const task = tasks.get(id);
      if (!task) {
        return { isError: true, content: [{ type: "text", text: `Unknown Babelfish task: ${id}` }] };
      }
      const { controller: _controller, ...safeTask } =
        task.status === "running" ? task : { ...task, controller: undefined };
      if (task.status !== "running") {
        tasks.delete(id);
      }
      return {
        content: [{ type: "text", text: stringifyResult(safeTask) }],
        structuredContent: asObject(safeTask),
      };
    }

    if (request.params.name === "babelfish_task_stop") {
      const id = String(asObject(request.params.arguments)?.id ?? "");
      const task = tasks.get(id);
      if (!task) {
        return { isError: true, content: [{ type: "text", text: `Unknown Babelfish task: ${id}` }] };
      }
      if (task.status === "running") {
        task.controller.abort();
        tasks.set(id, { id, status: "stopped", startedAt: task.startedAt, finishedAt: Date.now() });
        trimFinishedTasks();
      }
      return {
        content: [{ type: "text", text: stringifyResult(tasks.get(id)) }],
        structuredContent: asObject(tasks.get(id)),
      };
    }

    const list = await listHermesPlugins(config);
    const index = buildHermesMcpToolIndex(list);
    const commandRoute = index.commandRoutes.get(request.params.name);
    if (commandRoute) {
      const result = await callHermesCommand(
        config,
        {
          plugin: commandRoute.plugin,
          command: commandRoute.name,
          args: asObject(request.params.arguments)?.args ?? request.params.arguments ?? "",
        },
        { isolated: true },
      );
      return {
        content: [{ type: "text", text: stringifyResult(result.result) }],
        structuredContent: asObject(result.result),
        _meta: {
          "babelfish/app": "hermes",
          "babelfish/plugin": result.plugin,
          "babelfish/command": result.command,
        },
      };
    }

    const route = index.toolRoutes.get(request.params.name);
    if (!route) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown Babelfish MCP tool: ${request.params.name}` }],
      };
    }

    try {
      const result = await callHermesTool(
        config,
        {
          plugin: route.plugin,
          tool: route.name,
          args: request.params.arguments ?? {},
        },
        { isolated: true },
      );
      return {
        content: [
          {
            type: "text",
            text: stringifyResult(result.parsedResult ?? result.result),
          },
        ],
        structuredContent: asObject(result.parsedResult ?? result.result),
        _meta: {
          "babelfish/app": "hermes",
          "babelfish/plugin": result.plugin,
          "babelfish/tool": result.tool,
        },
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: (error as Error).message }],
      };
    }
  });

  return server;
}

export async function startHermesMcpServer(config: HermesBridgeConfig): Promise<void> {
  await syncHermesSkills(config);
  const server = createHermesMcpServer(config);
  await server.connect(new StdioServerTransport());
}
