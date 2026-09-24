import fs from "node:fs/promises";
import path from "node:path";
import { spawnShellCommand, terminateShellProcessTree } from "./shell-command.js";

const GIT_CLONE_TIMEOUT_MS = 120_000;
const MAX_CLONE_OUTPUT_BYTES = 1024 * 1024;

function validateCloneTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("clone timeout must be a positive integer number of milliseconds (at most 2147483647)");
  }
  return value;
}

export function resolveCloneTimeoutMs(options: {
  cliValue?: string;
  envValue?: string;
} = {}): number {
  const raw = options.cliValue ?? options.envValue;
  if (raw === undefined) {
    return GIT_CLONE_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error("clone timeout must be a positive integer number of milliseconds");
  }
  return validateCloneTimeoutMs(Number(raw));
}

async function cloneRepository(source: string, target: string, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnShellCommand(["git", "clone", "--depth", "1", "--", source, target], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let failure: Error | undefined;
    const stderr: Buffer[] = [];
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      // Git transports inherit the process group or Windows Job, so stop the whole tree.
      terminateShellProcessTree(child, process.platform, "SIGKILL");
    };
    const timer = setTimeout(() => {
      stop(new Error(`Git clone timed out after ${timeoutMs}ms; increase --clone-timeout-ms or OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS for a slow remote.`));
    }, timeoutMs);
    for (const stream of ["stdout", "stderr"] as const) {
      let bytes = 0;
      child[stream]!.on("data", (chunk: Buffer) => {
        if (failure) return;
        bytes += chunk.length;
        if (bytes > MAX_CLONE_OUTPUT_BYTES) {
          stop(new Error(`Git clone ${stream} exceeded the ${MAX_CLONE_OUTPUT_BYTES}-byte output limit`));
        } else if (stream === "stderr") {
          stderr.push(chunk);
        }
      });
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git clone exited with ${code ?? signal}`));
      }
    });
  });
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

  validateCloneTimeoutMs(timeoutMs);
  const pluginName = sanitizePluginName(name ?? repoNameFromSource(source));
  const target = path.join(installDir, pluginName);
  const replacing = await pathExists(target);
  if (replacing && !force) {
    throw new Error(`Plugin '${pluginName}' already exists. Pass force=true to reinstall.`);
  }
  const nonce = `${process.pid}.${Date.now()}`;
  const stagingRoot = path.join(installDir, ".babelfish-staging", `${pluginName}.${nonce}`);
  const staged = path.join(stagingRoot, "new");
  const backup = path.join(stagingRoot, "old");
  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  try {
    await cloneRepository(source, staged, timeoutMs);
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
