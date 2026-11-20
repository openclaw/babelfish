import fs from "node:fs/promises";
import path from "node:path";
import { tempDir } from "../test/temp-dir.js";
import { syncHermesSkills } from "./skill-sync.js";

async function copyFixture(target: string): Promise<void> {
  const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
  await fs.cp(fixture, path.join(target, "simple"), { recursive: true });
}

describe("syncHermesSkills", () => {
  it("writes current Hermes skills and removes stale generated skills", async () => {
    const installDir = await tempDir("openclaw-babelfish-skills-");
    const rootDir = await tempDir("openclaw-babelfish-package-");
    const staleDir = path.join(rootDir, "skills", "babelfish-generated", "old");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.writeFile(path.join(staleDir, "SKILL.md"), "old", "utf-8");
    await copyFixture(installDir);

    const written = await syncHermesSkills(
      { installDir, python: "python3", timeoutMs: 10000, env: {} },
      rootDir,
    );

    expect(written).toEqual(["babelfish-simple-simple_skill"]);
    const markdown = await fs.readFile(
      path.join(rootDir, "skills", "babelfish-generated", "babelfish-simple-simple_skill", "SKILL.md"),
      "utf-8",
    );
    expect(markdown).toContain("name: babelfish-simple-simple_skill");
    expect(markdown).toContain("Simple Skill");
    await expect(fs.stat(staleDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("suffixes generated skill slug collisions", async () => {
    const installDir = await tempDir("openclaw-babelfish-skills-");
    const rootDir = await tempDir("openclaw-babelfish-package-");
    const fixture = path.join(process.cwd(), "test/fixtures/simple-hermes-plugin");
    await fs.cp(fixture, path.join(installDir, "a.b"), { recursive: true });
    await fs.cp(fixture, path.join(installDir, "a-b"), { recursive: true });

    await expect(
      syncHermesSkills({ installDir, python: "python3", timeoutMs: 10000, env: {} }, rootDir),
    ).resolves.toEqual(["babelfish-a-b-simple_skill", "babelfish-a-b-simple_skill-2"]);
  });
});
