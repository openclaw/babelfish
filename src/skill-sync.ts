import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueName } from "./tool-names.js";
import type { HermesBridgeConfig } from "./config.js";
import { listHermesPlugins, readHermesSkill } from "./hermes-python.js";

function packageRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "plugin"
  );
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function skillMarkdown(params: {
  name: string;
  description: string;
  plugin: string;
  skill: string;
  text: string;
}): string {
  return [
    "---",
    `name: ${params.name}`,
    `description: ${yamlString(params.description || `Imported skill ${params.plugin}/${params.skill}`)}`,
    "---",
    "",
    params.text,
    "",
  ].join("\n");
}

export async function syncHermesSkills(
  config: HermesBridgeConfig,
  rootDir = packageRoot(),
): Promise<string[]> {
  const list = await listHermesPlugins(config);
  const generatedRoot = path.join(rootDir, "skills", "babelfish-generated");
  const desired = new Set<string>();
  const written: string[] = [];
  for (const plugin of list.plugins) {
    for (const skill of plugin.skills) {
      if (!skill.available) {
        continue;
      }
      const baseName = `babelfish-${slug(plugin.key)}-${slug(skill.name)}`;
      const name = uniqueName(baseName, desired, "-");
      const loaded = await readHermesSkill(config, { plugin: plugin.key, skill: skill.name });
      const dir = path.join(generatedRoot, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        skillMarkdown({
          name,
          description: loaded.description || skill.description,
          plugin: plugin.key,
          skill: skill.name,
          text: loaded.text,
        }),
        "utf-8",
      );
      written.push(name);
    }
  }
  await fs.mkdir(generatedRoot, { recursive: true });
  for (const entry of await fs.readdir(generatedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !desired.has(entry.name)) {
      await fs.rm(path.join(generatedRoot, entry.name), { recursive: true, force: true });
    }
  }
  return written;
}
