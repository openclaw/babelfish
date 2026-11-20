import type { HermesListResult, HermesToolSummary } from "./hermes-python.js";
import { asObject, type JsonObject } from "./json.js";
import { duplicateNames, sanitizeName, uniqueName } from "./tool-names.js";

function inputSchemaFor(tool: HermesToolSummary): JsonObject {
  const schema = asObject(tool.schema);
  const parameters = asObject(schema?.parameters) ?? asObject(asObject(schema?.function)?.parameters);
  if (parameters?.type === "object") {
    return parameters;
  }
  if (schema?.type === "object") {
    return schema;
  }
  return { type: "object", additionalProperties: true };
}

export function* namedHermesTools(list: HermesListResult, usedNames: Set<string>) {
  const available = list.plugins.flatMap((plugin) => plugin.tools
    .filter((tool) => tool.available)
    .map((tool) => ({ plugin: plugin.key, tool })));
  const qualified = duplicateNames(available, ({ tool }) => tool.name);
  for (const reserved of usedNames) qualified.add(reserved);

  for (const { plugin, tool } of available) {
    const base = qualified.has(tool.name)
      ? `${sanitizeName(plugin)}__${sanitizeName(tool.name)}`
      : tool.name;
    yield { plugin, tool, name: uniqueName(base, usedNames), inputSchema: inputSchemaFor(tool) };
  }
}
