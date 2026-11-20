import os from "node:os";
import path from "node:path";
import { resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", undefined);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", undefined);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PYTHON", undefined);
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uses the default root independently of the Hermes directory", () => {
    const rootDir = path.join(os.homedir(), ".openclaw", "babelfish");
    expect(resolveConfig()).toMatchObject({ rootDir, installDir: path.join(rootDir, "hermes"), python: "python3", timeoutMs: 120_000 });
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR", "~/custom-hermes");
    expect(resolveConfig()).toMatchObject({ rootDir, installDir: path.join(os.homedir(), "custom-hermes") });
  });

  it("reads the bundle root, Python executable and deadline from the environment", () => {
    vi.stubEnv("OPENCLAW_BABELFISH_ROOT", "~/bundles");
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_PYTHON", "fixture-python");
    vi.stubEnv("OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS", "4500");
    expect(resolveConfig()).toMatchObject({ rootDir: path.join(os.homedir(), "bundles"), python: "fixture-python", timeoutMs: 4500 });
  });

  it.each([["10", 1000], ["2147483647", 2147483647], ["2147483648", 120_000]])(
    "resolves a timer boundary of %s ms to %i ms", (input, expected) => {
      vi.stubEnv("OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS", String(input));
      expect(resolveConfig().timeoutMs).toBe(expected);
    },
  );
});
