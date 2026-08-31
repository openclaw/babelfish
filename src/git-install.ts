import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_CLONE_TIMEOUT_MS = 120_000;

export function resolveCloneTimeoutMs(options: {
  cliValue?: string;
  envValue?: string;
} = {}): number {
  const raw = options.cliValue ?? options.envValue;
  if (raw === undefined) {
    return GIT_CLONE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
    throw new Error("clone timeout must be a positive integer number of milliseconds");
  }
  return parsed;
}

export type InstallPluginParams = {
  installDir: string;
  source: string;
  name?: string;
  force?: boolean;
  timeoutMs?: number;
  validate?: (target: string) => Promise<void>;
  afterChange?: () => Promise<void>;
};

export type UninstallPluginParams = {
  installDir: string;
  name: string;
  afterChange?: () => Promise<void>;
};

export function repoNameFromSource(source: string): string {
  const clean = source.trim().replace(/[#?].*$/, "").replace(/[\\/]+$/, "");
  const last = clean.split(/[\\/:]/).filter(Boolean).at(-1) ?? "plugin";
  return last.replace(/\.git$/, "");
}

export function sanitizePluginName(name: string): string {
  const clean = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(clean) || clean === "." || clean === "..") {
    throw new Error("Plugin name must contain only letters, numbers, dot, underscore, or dash.");
  }
  return clean;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function validateHermesPluginDirectory(target: string): Promise<void> {
  const required = ["plugin.yaml", "__init__.py"];
  const missing = [];
  for (const file of required) {
    const marker = path.join(target, file);
    if (!(await pathExists(marker)) || !(await fs.stat(marker)).isFile()) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Repository is not a supported plugin; missing ${missing.join(", ")}.`);
  }
}

export async function installPlugin({
  installDir,
  source,
  name,
  force = false,
  timeoutMs = GIT_CLONE_TIMEOUT_MS,
  validate,
  afterChange,
}: InstallPluginParams): Promise<{ name: string; path: string }> {
  if (!source.trim()) {
    throw new Error("source required");
  }

  const pluginName = sanitizePluginName(name ?? repoNameFromSource(source));
  const target = path.join(installDir, pluginName);
  const nonce = `${process.pid}.${Date.now()}`;
  const stagingRoot = path.join(installDir, ".babelfish-staging", `${pluginName}.${nonce}`);
  const staged = path.join(stagingRoot, "new");
  const backup = path.join(stagingRoot, "old");
  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  const replacing = await pathExists(target);
  if (replacing) {
    if (!force) {
      throw new Error(`Plugin '${pluginName}' already exists. Pass force=true to reinstall.`);
    }
  }

  try {
    await execFileAsync("git", ["clone", "--depth", "1", source, staged], {
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
    await validate?.(staged);
    if (replacing) {
      await fs.rename(target, backup);
    }
    try {
      await fs.rename(staged, target);
    } catch (error) {
      if (replacing) {
        await fs.rename(backup, target);
      }
      throw error;
    }
    try {
      await afterChange?.();
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true });
      if (replacing) {
        await fs.rename(backup, target);
      }
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(path.dirname(stagingRoot)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
        throw error;
      }
    });
  }

  return { name: pluginName, path: target };
}

export async function uninstallPlugin({
  installDir,
  name,
  afterChange,
}: UninstallPluginParams): Promise<{ name: string; path: string }> {
  const pluginName = sanitizePluginName(name);
  const target = path.join(installDir, pluginName);
  if (!(await pathExists(target))) {
    throw new Error(`Plugin '${pluginName}' is not installed.`);
  }
  const stagingRoot = path.join(
    installDir,
    ".babelfish-staging",
    `${pluginName}.${process.pid}.${Date.now()}`,
  );
  const backup = path.join(stagingRoot, "old");
  await fs.mkdir(stagingRoot, { recursive: true });
  await fs.rename(target, backup);
  try {
    await afterChange?.();
    await fs.rm(backup, { recursive: true, force: true });
  } catch (error) {
    await fs.rename(backup, target);
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(path.dirname(stagingRoot)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") {
        throw error;
      }
    });
  }
  return { name: pluginName, path: target };
}


export function installHermesPlugin(params: InstallPluginParams) {
  return installPlugin({ ...params, validate: validateHermesPluginDirectory });
}

export const uninstallHermesPlugin = uninstallPlugin;
