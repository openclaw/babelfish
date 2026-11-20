import type { HermesPluginSummary, HermesToolSummary } from "../src/hermes-python.js";

export function hermesTool(name: string, fields: Partial<HermesToolSummary> = {}): HermesToolSummary {
  return {
    name,
    toolset: "",
    description: name,
    schema: { parameters: { type: "object", properties: {} } },
    isAsync: false,
    requiresEnv: [],
    available: true,
    ...fields,
  };
}

export function hermesPlugin(key: string, tools: HermesToolSummary[]): HermesPluginSummary {
  return {
    key,
    name: key,
    version: "",
    description: "",
    path: `/tmp/hermes/${key}`,
    tools,
    hooks: [],
    middleware: [],
    commands: [],
    cliCommands: [],
    skills: [],
    auxiliaryTasks: [],
    unsupported: [],
  };
}
