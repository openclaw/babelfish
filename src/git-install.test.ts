import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  installPlugin,
  repoNameFromSource,
  resolveCloneTimeoutMs,
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

describe("resolveCloneTimeoutMs", () => {
  it("defaults to 120 seconds and accepts operator overrides", () => {
    expect(resolveCloneTimeoutMs()).toBe(120_000);
    expect(resolveCloneTimeoutMs({ cliValue: "45000", envValue: "90000" })).toBe(45_000);
    expect(resolveCloneTimeoutMs({ envValue: "90000" })).toBe(90_000);
    expect(resolveCloneTimeoutMs({ cliValue: "2147483647" })).toBe(2_147_483_647);
  });

  it.each(["", "0", "-1", "1.5", "fast", "1e3", "2147483648", "9007199254740993"])("rejects invalid or overflowing timers: %s", (value) => {
    expect(() => resolveCloneTimeoutMs({ cliValue: value })).toThrow(/positive integer/);
    expect(() => resolveCloneTimeoutMs({ envValue: value })).toThrow(/positive integer/);
  });
});

describe("repoNameFromSource", () => {
  it("derives names from URLs and Windows paths", () => {
    expect(repoNameFromSource("https://github.com/example/plugin.git")).toBe("plugin");
    expect(repoNameFromSource("C:\\plugins\\plugin.git")).toBe("plugin");
  });
});

describe("plugin lifecycle", () => {
  it.each([false, true])("cleans up a timed-out clone and preserves existing state (force=%s)", async (force) => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-timeout-"));
    const target = path.join(installDir, "plugin");
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", (error: NodeJS.ErrnoException) => expect(error.code).toBe("ECONNRESET"));
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const afterChange = vi.fn();
    const validate = vi.fn();
    try {
      if (force) {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "marker"), "kept");
      }
      await expect(installPlugin({
        installDir, source: `http://127.0.0.1:${port}/stalled.git`,
        name: "plugin", force, timeoutMs: process.platform === "win32" ? 10_000 : 400,
        validate, afterChange,
      })).rejects.toThrow(/Git clone timed out/);
      expect(validate).not.toHaveBeenCalled();
      expect(afterChange).not.toHaveBeenCalled();
      expect(await fs.readdir(installDir)).toEqual(force ? ["plugin"] : []);
      if (force) expect(await fs.readFile(path.join(target, "marker"), "utf8")).toBe("kept");
      expect(sockets.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fs.rm(installDir, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid programmatic timeout %s before creating staging", async (timeoutMs) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-timeout-invalid-"));
    try {
      await expect(installPlugin({ installDir: path.join(root, "install"), source: "unused", timeoutMs }))
        .rejects.toThrow(/positive integer/);
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
