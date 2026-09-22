import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  installPlugin,
  repoNameFromSource,
  sanitizePluginName,
  uninstallPlugin,
  validateHermesPluginDirectory,
} from "./git-install.js";

const execFileAsync = promisify(execFile);

describe("sanitizePluginName", () => {
  it("accepts boring repo names", () => {
    expect(sanitizePluginName("my-hermes_plugin.1")).toBe("my-hermes_plugin.1");
  });

  it("rejects traversal", () => {
    expect(() => sanitizePluginName("../bad")).toThrow(/letters/);
  });
});

describe("repoNameFromSource", () => {
  it("derives names from URLs and Windows paths", () => {
    expect(repoNameFromSource("https://github.com/example/plugin.git")).toBe("plugin");
    expect(repoNameFromSource("C:\\plugins\\plugin.git")).toBe("plugin");
  });
});

describe("plugin lifecycle", () => {
  it("rejects a duplicate install without leaving staging directories", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-duplicate-"));
    try {
      const target = path.join(installDir, "existing");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "marker"), "kept");
      await expect(installPlugin({
        installDir, source: "unused", name: "existing",
      })).rejects.toThrow("already exists");
      expect(await fs.readdir(installDir)).toEqual(["existing"]);
      expect(await fs.readFile(path.join(target, "marker"), "utf8")).toBe("kept");
    } finally {
      await fs.rm(installDir, { recursive: true, force: true });
    }
  });

  it("installs a bundle validated by its caller", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const installDir = path.join(root, "installed");
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(source, ".codex-plugin", "plugin.json"), "{}");
    await execFileAsync("git", ["-C", source, "init", "-q"]);
    await execFileAsync("git", ["-C", source, "add", "."]);
    await execFileAsync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    await expect(installPlugin({
      installDir,
      source,
      validate: async (target) => fs.access(path.join(target, ".codex-plugin", "plugin.json")),
    })).resolves.toMatchObject({ name: "source" });
  });

  it("keeps an existing plugin when a forced clone fails", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const target = path.join(installDir, "existing");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "marker"), "kept");

    await expect(
      installPlugin({
        installDir,
        source: path.join(installDir, "missing"),
        name: "existing",
        force: true,
      }),
    ).rejects.toThrow();

    await expect(fs.readFile(path.join(target, "marker"), "utf8")).resolves.toBe("kept");
  });

  it("keeps an existing plugin when the replacement is not a supported plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const installDir = path.join(root, "installed");
    const source = path.join(root, "source");
    const target = path.join(installDir, "existing");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "marker"), "kept");
    await fs.mkdir(source);
    await fs.mkdir(path.join(source, "plugin.yaml"));
    await fs.mkdir(path.join(source, "__init__.py"));
    await fs.writeFile(path.join(source, "plugin.yaml", "marker"), "directory");
    await fs.writeFile(path.join(source, "__init__.py", "marker"), "directory");
    await execFileAsync("git", ["-C", source, "init", "-q"]);
    await execFileAsync("git", ["-C", source, "add", "."]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);

    await expect(
      installPlugin({ installDir, source, name: "existing", force: true, validate: validateHermesPluginDirectory }),
    ).rejects.toThrow("not a supported plugin");
    await expect(fs.readFile(path.join(target, "marker"), "utf8")).resolves.toBe("kept");
  });

  it("restores the previous plugin when regeneration fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const installDir = path.join(root, "installed");
    const source = path.join(root, "source");
    const target = path.join(installDir, "existing");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "marker"), "kept");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "plugin.yaml"), "name: replacement\n");
    await fs.writeFile(path.join(source, "__init__.py"), "def register(ctx): pass\n");
    await execFileAsync("git", ["-C", source, "init", "-q"]);
    await execFileAsync("git", ["-C", source, "add", "."]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);

    await expect(
      installPlugin({
        installDir,
        source,
        name: "existing",
        force: true,
        validate: validateHermesPluginDirectory,
        afterChange: async () => {
          throw new Error("regeneration failed");
        },
      }),
    ).rejects.toThrow("regeneration failed");
    await expect(fs.readFile(path.join(target, "marker"), "utf8")).resolves.toBe("kept");
  });

  it("restores an uninstalled plugin when regeneration fails", async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const target = path.join(installDir, "existing");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "marker"), "kept");

    await expect(
      uninstallPlugin({
        installDir,
        name: "existing",
        afterChange: async () => {
          throw new Error("regeneration failed");
        },
      }),
    ).rejects.toThrow("regeneration failed");
    await expect(fs.readFile(path.join(target, "marker"), "utf8")).resolves.toBe("kept");
  });
});
