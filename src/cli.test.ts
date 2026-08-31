import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBabelfishCli } from "./cli.js";

const execFileAsync = promisify(execFile);

async function initGitRepo(source: string): Promise<void> {
  await fs.mkdir(path.join(source, ".codex-plugin"), { recursive: true });
  await fs.writeFile(path.join(source, ".codex-plugin", "plugin.json"), "{}");
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
}

describe("babelfish install clone timeout", () => {
  it("rejects a missing --clone-timeout-ms value", async () => {
    await expect(
      runBabelfishCli(["install", "codex", "/tmp/unused", "--clone-timeout-ms"]),
    ).rejects.toThrow(/--clone-timeout-ms requires a positive integer/);
  });

  it("rejects a flag-like --clone-timeout-ms value", async () => {
    await expect(
      runBabelfishCli(["install", "codex", "/tmp/unused", "--clone-timeout-ms", "--force"]),
    ).rejects.toThrow(/--clone-timeout-ms requires a positive integer/);
  });

  it("rejects a later malformed --clone-timeout-ms after a valid one", async () => {
    await expect(
      runBabelfishCli([
        "install",
        "codex",
        "/tmp/unused",
        "--clone-timeout-ms",
        "400",
        "--clone-timeout-ms",
        "--force",
      ]),
    ).rejects.toThrow(/--clone-timeout-ms requires a positive integer/);
  });

  it("installs a local repository when an override is long enough", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-cli-install-"));
    const source = path.join(root, "source");
    const previousRoot = process.env.OPENCLAW_BABELFISH_ROOT;
    const previousTimeout = process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS;
    await initGitRepo(source);
    try {
      process.env.OPENCLAW_BABELFISH_ROOT = path.join(root, "apps");
      delete process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS;
      await runBabelfishCli([
        "install",
        "codex",
        source,
        "--name",
        "ok-plugin",
        "--clone-timeout-ms",
        "30000",
      ]);
      await expect(
        fs.access(path.join(root, "apps", "codex", "ok-plugin", ".codex-plugin", "plugin.json")),
      ).resolves.toBeUndefined();
    } finally {
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_BABELFISH_ROOT;
      } else {
        process.env.OPENCLAW_BABELFISH_ROOT = previousRoot;
      }
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("honors a short CLI override against a stalled remote", { timeout: 8_000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-cli-stall-"));
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    const previousRoot = process.env.OPENCLAW_BABELFISH_ROOT;
    const started = Date.now();
    try {
      process.env.OPENCLAW_BABELFISH_ROOT = path.join(root, "apps");
      await expect(
        runBabelfishCli([
          "install",
          "codex",
          `http://127.0.0.1:${port}/stalled-plugin.git`,
          "--name",
          "stalled",
          "--clone-timeout-ms",
          "400",
        ]),
      ).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      if (previousRoot === undefined) {
        delete process.env.OPENCLAW_BABELFISH_ROOT;
      } else {
        process.env.OPENCLAW_BABELFISH_ROOT = previousRoot;
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
