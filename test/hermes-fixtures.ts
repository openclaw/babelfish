import fs from "node:fs/promises";
import path from "node:path";
import type { HermesPluginSummary, HermesToolSummary } from "../src/hermes-python.js";

export function toolSummary(name: string, overrides: Partial<HermesToolSummary> = {}): HermesToolSummary {
  return {
    name, toolset: "", description: "", schema: {}, isAsync: false,
    requiresEnv: [], available: true, ...overrides,
  };
}

export function pluginSummary(key: string, tools: HermesToolSummary[]): HermesPluginSummary {
  return {
    key, name: key, version: "", description: "", path: key, tools,
    hooks: [], middleware: [], commands: [], cliCommands: [], skills: [], auxiliaryTasks: [], unsupported: [],
  };
}

export async function copyFixture(
  target: string,
  fixtureName = "simple-hermes-plugin",
  installedName = "simple",
): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures", fixtureName);
  await fs.cp(fixture, path.join(target, installedName), { recursive: true });
}
