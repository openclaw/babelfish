import os from "node:os";
import path from "node:path";

export const SUPPORTED_APPS = ["hermes", "claude-code", "codex"] as const;
export type SupportedApp = (typeof SUPPORTED_APPS)[number];

export function isSupportedApp(value: unknown): value is SupportedApp {
  return SUPPORTED_APPS.includes(value as SupportedApp);
}

export function requireApp(value: unknown): SupportedApp {
  if (isSupportedApp(value)) return value;
  throw new Error(`Unsupported app: ${String(value || "(missing)")}`);
}

export type BabelfishConfig = {
  installDir: string;
  rootDir: string;
  python: string;
  timeoutMs: number;
  env: Record<string, string>;
};

export type HermesBridgeConfig = BabelfishConfig;

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function appInstallDir(config: BabelfishConfig, app: SupportedApp): string {
  return app === "hermes" ? config.installDir : path.join(config.rootDir ?? path.dirname(config.installDir), app);
}

export function resolveConfig(): BabelfishConfig {
  const defaultRoot = path.join(os.homedir(), ".openclaw", "babelfish");
  const defaultTimeoutMs = 120_000;
  const timeout = Number.parseInt(process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS ?? "", 10) || defaultTimeoutMs;
  return {
    installDir: expandHome(process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR ?? path.join(defaultRoot, "hermes")),
    rootDir: expandHome(process.env.OPENCLAW_BABELFISH_ROOT ?? defaultRoot),
    python: process.env.OPENCLAW_BABELFISH_HERMES_PYTHON ?? "python3",
    timeoutMs: timeout > 2_147_483_647 ? defaultTimeoutMs : Math.max(1000, timeout),
    env: {},
  };
}
