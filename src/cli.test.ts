import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBabelfishCli } from "./cli.js";

vi.mock("./native-tools.js", () => ({
  regenerateNativeTools: vi.fn(async () => ({ restartRequired: true })),
}));

const execFileAsync = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-cli-"));
  vi.stubEnv("OPENCLAW_BABELFISH_ROOT", path.join(root, "apps"));
  vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
  vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("babelfish install clone timeout", () => {
  it.each([
    ["--clone-timeout-ms"],
    ["--clone-timeout-ms", "--force"],
    ["--clone-timeout-ms", "400", "--clone-timeout-ms", "--force"],
    ["--clone-timeout-ms", "abc", "--clone-timeout-ms", "400"],
    ["--clone-timeout-ms", "400", "--clone-timeout-ms", "abc"],
    ["--clone-timeout-ms", "2147483648"],
  ])("rejects malformed timeout flags %j before creating install state", async (...flags) => {
    await expect(runBabelfishCli([
      "install", "codex", path.join(root, "unused"), ...flags,
    ])).rejects.toThrow(/positive integer/);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("uses the last valid CLI override instead of the environment", async () => {
    const source = path.join(root, "source");
    await fs.mkdir(path.join(source, ".codex-plugin"), { recursive: true });
    await fs.writeFile(path.join(source, ".codex-plugin", "plugin.json"), "{}");
    await execFileAsync("git", ["-C", source, "init", "-q"]);
    await execFileAsync("git", ["-C", source, "add", "."]);
    await execFileAsync("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", "invalid");
    await runBabelfishCli([
      "install", "codex", source, "--name", "ok-plugin",
      "--clone-timeout-ms", "1", "--clone-timeout-ms", "30000",
    ]);
    await expect(fs.access(path.join(root, "apps", "codex", "ok-plugin", ".codex-plugin", "plugin.json")))
      .resolves.toBeUndefined();
  }, 15_000);

  it.each(["flag", "environment"])("honors the %s timeout and closes the stalled Git transport", async (override) => {
    const timeoutMs = process.platform === "win32" ? 10_000 : 400;
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("error", (error: NodeJS.ErrnoException) => expect(error.code).toBe("ECONNRESET"));
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    const started = Date.now();
    try {
      const flags = override === "flag" ? ["--clone-timeout-ms", String(timeoutMs)] : [];
      if (override === "environment") vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", String(timeoutMs));
      await expect(runBabelfishCli([
        "install", "codex", `http://127.0.0.1:${port}/stalled-plugin.git`,
        "--name", "stalled", ...flags,
      ])).rejects.toThrow(`Git clone timed out after ${timeoutMs}ms`);
      expect(Date.now() - started).toBeLessThan(timeoutMs + 3_000);
      expect(sockets.length).toBeGreaterThan(0);
      await vi.waitFor(() => expect(sockets.every((socket) => socket.destroyed)).toBe(true));
      expect(await fs.readdir(path.join(root, "apps", "codex"))).toEqual([]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);
});
