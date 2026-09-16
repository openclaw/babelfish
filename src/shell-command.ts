import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const windowsJobScript = fileURLToPath(
  new URL("../assets/windows-job.ps1", import.meta.url),
);

function windowsPowerShellPath(systemRoot = process.env.SystemRoot): string {
  const root = systemRoot && path.win32.isAbsolute(systemRoot)
    ? systemRoot
    : "C:\\Windows";
  return path.win32.join(
    root,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function spawnWindowsJobCommand(
  command: string | readonly string[],
  mode: "command" | "monitor",
  options: Omit<SpawnOptions, "shell">,
  spawnProcess: SpawnProcess,
): ChildProcess {
  return spawnProcess(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsJobScript,
      "-Mode",
      mode,
      typeof command === "string" ? "-CommandBase64" : "-ArgvBase64",
      Buffer.from(typeof command === "string" ? command : JSON.stringify(command), "utf8").toString("base64"),
    ],
    { ...options, detached: false, windowsHide: true },
  );
}

export function spawnShellCommand(
  command: string | readonly string[],
  options: Omit<SpawnOptions, "shell">,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: SpawnProcess = spawn,
): ChildProcess {
  if (typeof command !== "string") {
    const [file, ...args] = command;
    if (!file) {
      throw new Error("Command argv is empty");
    }
    if (platform === "win32") {
      return spawnWindowsJobCommand(command, "command", options, spawnProcess);
    }
    return spawnProcess(file, args, options);
  }
  if (platform === "win32") {
    return spawnWindowsJobCommand(command, "command", options, spawnProcess);
  }
  return spawnProcess("/bin/sh", ["-lc", command], options);
}

export function spawnMonitorShellCommand(
  command: string,
  options: Omit<SpawnOptions, "shell">,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: SpawnProcess = spawn,
): ChildProcess {
  if (platform === "win32") {
    return spawnWindowsJobCommand(command, "monitor", options, spawnProcess);
  }
  return spawnShellCommand(command, options, platform, spawnProcess);
}

export function terminateShellProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  signal: NodeJS.Signals = "SIGTERM",
  killProcess: typeof process.kill = process.kill,
): void {
  if (!child.pid) return;

  if (platform === "win32") {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill();
    return;
  }

  try {
    killProcess(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
