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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      env[key] = raw;
    }
  }
  return env;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function defaultInstallDir(): string {
  return path.join(os.homedir(), ".openclaw", "babelfish", "hermes");
}

function defaultRootDir(): string {
  return path.join(os.homedir(), ".openclaw", "babelfish");
}

export function appInstallDir(config: BabelfishConfig, app: SupportedApp): string {
  return app === "hermes" ? config.installDir : path.join(config.rootDir ?? path.dirname(config.installDir), app);
}

export function resolveConfig(raw: Record<string, unknown> | undefined): BabelfishConfig {
  const timeout =
    typeof raw?.timeoutMs === "number"
      ? Math.trunc(raw.timeoutMs)
      : Number.parseInt(process.env.OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS ?? "", 10) || 120000;
  const installDir =
    readString(raw?.installDir) ??
    process.env.OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR ??
    defaultInstallDir();
  return {
    installDir: expandHome(installDir),
    rootDir: expandHome(readString(raw?.rootDir) ?? process.env.OPENCLAW_BABELFISH_ROOT ?? defaultRootDir()),
    python: readString(raw?.python) ?? process.env.OPENCLAW_BABELFISH_HERMES_PYTHON ?? "python3",
    timeoutMs: Math.max(1000, timeout),
    env: readEnv(raw?.env),
  };
}
