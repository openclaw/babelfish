import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uniqueName } from "./tool-names.js";
import type { HermesBridgeConfig } from "./config.js";
import { listHermesPlugins, readHermesSkill, type HermesListResult } from "./hermes-python.js";

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

export async function syncHermesSkills(
  config: HermesBridgeConfig,
  rootDir = packageRoot(),
  inventory?: HermesListResult,
): Promise<string[]> {
  const list = inventory ?? await listHermesPlugins(config);
  const generatedRoot = path.join(rootDir, "skills", "babelfish-generated");
  const desired = new Set<string>();
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
      const description = loaded.description || skill.description || `Imported skill ${plugin.key}/${skill.name}`;
      const markdown = [
        "---",
        `name: ${name}`,
        `description: ${JSON.stringify(description)}`,
        "---",
        "",
        loaded.text,
        "",
      ];
      await fs.writeFile(path.join(dir, "SKILL.md"), markdown.join("\n"), "utf-8");
    }
  }
  await fs.mkdir(generatedRoot, { recursive: true });
  for (const entry of await fs.readdir(generatedRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !desired.has(entry.name)) {
      await fs.rm(path.join(generatedRoot, entry.name), { recursive: true, force: true });
    }
  }
  return [...desired];
}
