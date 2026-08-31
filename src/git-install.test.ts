import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  GIT_CLONE_TIMEOUT_MS,
  installHermesPlugin,
  installPlugin,
  repoNameFromSource,
  resolveCloneTimeoutMs,
  sanitizePluginName,
  uninstallHermesPlugin,
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
  it("defaults to 120 seconds", () => {
    expect(resolveCloneTimeoutMs()).toBe(GIT_CLONE_TIMEOUT_MS);
  });

  it("prefers the CLI value over the environment", () => {
    expect(resolveCloneTimeoutMs({ cliValue: "45000", envValue: "90000" })).toBe(45_000);
  });

  it("uses the environment when the CLI omits the flag", () => {
    expect(resolveCloneTimeoutMs({ envValue: "90000" })).toBe(90_000);
  });

  it("rejects non-positive and non-integer values", () => {
    expect(() => resolveCloneTimeoutMs({ cliValue: "0" })).toThrow(/positive integer/);
    expect(() => resolveCloneTimeoutMs({ cliValue: "-1" })).toThrow(/positive integer/);
    expect(() => resolveCloneTimeoutMs({ cliValue: "1.5" })).toThrow(/positive integer/);
    expect(() => resolveCloneTimeoutMs({ envValue: "fast" })).toThrow(/positive integer/);
  });
});

describe("repoNameFromSource", () => {
  it("derives names from URLs and Windows paths", () => {
    expect(repoNameFromSource("https://github.com/example/plugin.git")).toBe("plugin");
    expect(repoNameFromSource("C:\\plugins\\plugin.git")).toBe("plugin");
  });
});

describe("installHermesPlugin", () => {
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
      installHermesPlugin({
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
      installHermesPlugin({ installDir, source, name: "existing", force: true }),
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
      installHermesPlugin({
        installDir,
        source,
        name: "existing",
        force: true,
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
      uninstallHermesPlugin({
        installDir,
        name: "existing",
        afterChange: async () => {
          throw new Error("regeneration failed");
        },
      }),
    ).rejects.toThrow("regeneration failed");
    await expect(fs.readFile(path.join(target, "marker"), "utf8")).resolves.toBe("kept");
  });

  it("times out a hung git clone instead of waiting forever", { timeout: 8_000 }, async () => {
    const installDir = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-install-"));
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    const started = Date.now();
    try {
      await expect(
        installPlugin({
          installDir,
          source: `http://127.0.0.1:${port}/stalled-plugin.git`,
          name: "stalled",
          timeoutMs: 400,
        }),
      ).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
