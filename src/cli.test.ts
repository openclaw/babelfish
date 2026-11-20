import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commitFixture, stalledGitRemote } from "../test/git-fixtures.js";
import { runBabelfishCli } from "./cli.js";

vi.mock("./native-tools.js", () => ({
  regenerateNativeTools: vi.fn(async () => ({ restartRequired: true })),
}));

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-cli-"));
  vi.stubEnv("OPENCLAW_BABELFISH_ROOT", path.join(root, "apps"));
  vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", path.join(root, "hermes"));
  vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", undefined);
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

it("lists one app or all apps in discovery order", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const codex = { app: "codex", plugins: [] };
    await runBabelfishCli(["list", "codex"]);
    expect(JSON.parse(log.mock.lastCall![0])).toEqual(codex);
    await runBabelfishCli(["list"]);
    expect(JSON.parse(log.mock.lastCall![0])).toEqual({ apps: [
      { app: "hermes", installDir: path.join(root, "hermes"), plugins: [] },
      { app: "claude-code", plugins: [] },
      codex,
    ] });
  } finally {
    log.mockRestore();
  }
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
    await commitFixture(source);
    vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", "invalid");
    await runBabelfishCli([
      "install", "codex", source, "--name", "ok-plugin",
      "--clone-timeout-ms", "1", "--clone-timeout-ms", "30000",
    ]);
    const installed = path.join(root, "apps", "codex", "ok-plugin");
    await expect(fs.access(path.join(installed, ".codex-plugin", "plugin.json"))).resolves.toBeUndefined();
    await runBabelfishCli(["uninstall", "codex", "ok-plugin"]);
    await expect(fs.access(installed)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each(["flag", "environment"])("honors the %s timeout and closes the stalled Git transport", async (override) => {
    const timeoutMs = process.platform === "win32" ? 10_000 : 2_000;
    const remote = await stalledGitRemote();
    const flags = override === "flag" ? ["--clone-timeout-ms", String(timeoutMs)] : [];
    if (override === "environment") vi.stubEnv("OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS", String(timeoutMs));
    await expect(runBabelfishCli([
      "install", "codex", remote.url,
      "--name", "stalled", ...flags,
    ])).rejects.toThrow(`Git clone timed out after ${timeoutMs}ms`);
    await remote.expectDisconnected();
    expect(await fs.readdir(path.join(root, "apps", "codex"))).toEqual([]);
  }, 20_000);
});
