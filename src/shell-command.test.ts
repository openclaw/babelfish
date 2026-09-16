import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  spawnMonitorShellCommand,
  spawnShellCommand,
  terminateShellProcessTree,
} from "./shell-command.js";

describe("spawnShellCommand", () => {
  it("preserves POSIX login-shell execution", () => {
    const child = {} as ChildProcess;
    const spawn = vi.fn(() => child);

    expect(spawnShellCommand("printf ready", { cwd: "/tmp" }, "linux", spawn)).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", "printf ready"],
      { cwd: "/tmp" },
    );
  });

  it("spawns argv commands without a POSIX login shell", () => {
    const child = {} as ChildProcess;
    const spawn = vi.fn(() => child);

    expect(
      spawnShellCommand(["node", "hook.mjs", "safe; echo pwned"], { cwd: "/tmp" }, "linux", spawn),
    ).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      "node",
      ["hook.mjs", "safe; echo pwned"],
      { cwd: "/tmp" },
    );
    expect(spawn.mock.calls[0]?.[1]).not.toContain("-lc");
  });

  it("keeps Windows argv commands inside the Job supervisor", () => {
    const child = {} as ChildProcess;
    const spawn = vi.fn(() => child);

    expect(
      spawnShellCommand(["node", "hook.mjs"], { cwd: "C:\\work" }, "win32", spawn),
    ).toBe(child);
    const [executable, args, options] = spawn.mock.calls[0]!;
    expect(executable).toMatch(/powershell\.exe$/);
    expect(args).toContain("-ArgvBase64");
    expect(JSON.parse(Buffer.from(args.at(-1)!, "base64").toString("utf8")))
      .toEqual(["node", "hook.mjs"]);
    expect(options).toEqual({ cwd: "C:\\work", detached: false, windowsHide: true });
  });

  it("rejects an empty argv command", () => {
    const spawn = vi.fn();
    expect(() => spawnShellCommand([], { cwd: "/tmp" }, "linux", spawn)).toThrow(/empty/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves literal argv through the platform launcher", async () => {
    const args = ["", "two words", "a\"b", "back\\slash\\", "trail space\\", "$(echo changed)", "%PATH%", "x & y", "日本語"];
    const child = spawnShellCommand(
      [process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    const [code] = await once(child, "close");
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toEqual(args);
  }, 15_000);

  it("terminates argv command descendants with their supervisor", async () => {
    const child = spawnShellCommand([
      process.execPath, "-e",
      "const {spawn}=require('node:child_process'); const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(worker.pid); setInterval(()=>{},1000);",
    ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let workerPid: number | undefined;
    const closed = once(child, "close");
    try {
      let stdout = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      await vi.waitFor(() => expect(stdout).toMatch(/^\d+\s/), { timeout: 10_000 });
      workerPid = Number(stdout.trim());
      terminateShellProcessTree(child);
      await closed;
      await vi.waitFor(() => {
        expect(() => process.kill(workerPid!, 0)).toThrow();
      }, { timeout: 5_000 });
    } finally {
      terminateShellProcessTree(child, process.platform, "SIGKILL");
      if (workerPid) {
        try { process.kill(workerPid, "SIGKILL"); } catch { /* Already exited. */ }
      }
    }
  }, 20_000);

  it("delegates Windows command parsing to the native shell", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);

    expect(
      spawnShellCommand(
        "echo ready",
        { cwd: "C:\\work", detached: true },
        "win32",
        spawn,
      ),
    ).toBe(child);
    const [executable, args, options] = spawn.mock.calls[0]!;
    expect(executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(args).toEqual(expect.arrayContaining([
      "-File",
      expect.stringMatching(/windows-job\.ps1$/),
      "-Mode",
      "command",
      "-CommandBase64",
      expect.any(String),
    ]));
    expect(options).toEqual({
      cwd: "C:\\work",
      detached: false,
      windowsHide: true,
    });
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf8")).toBe(
      "echo ready",
    );
  });
});

describe("spawnMonitorShellCommand", () => {
  it("uses a Windows Job Object supervisor as a durable process-tree root", () => {
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);

    expect(
      spawnMonitorShellCommand(
        "start /b worker.exe",
        { detached: true },
        "win32",
        spawn,
      ),
    ).toBe(child);
    const [executable, args, options] = spawn.mock.calls[0]!;
    expect(executable).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(args).toEqual(expect.arrayContaining(["-Mode", "monitor"]));
    expect(options).toEqual({ detached: false, windowsHide: true });
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf8")).toBe(
      "start /b worker.exe",
    );
  });

  it("does not alter POSIX monitor commands", () => {
    const child = {} as ChildProcess;
    const spawn = vi.fn(() => child);

    spawnMonitorShellCommand("worker &", {}, "linux", spawn);

    expect(spawn).toHaveBeenCalledWith(
      "/bin/sh",
      ["-lc", "worker &"],
      {},
    );
  });

  it("retires a monitor supervisor after its command tree drains", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-monitor-"));
    await fs.writeFile(path.join(root, "monitor.mjs"), "console.log('ready');");
    const child = spawnMonitorShellCommand("node monitor.mjs", {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));

    const [code] = await once(child, "close");

    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString("utf8").trim()).toBe("ready");
  }, 15_000);
});

describe("terminateShellProcessTree", () => {
  it("terminates POSIX process groups", () => {
    const child = { pid: 42, kill: vi.fn() } as unknown as ChildProcess;
    const killProcess = vi.fn();

    terminateShellProcessTree(child, "linux", "SIGTERM", killProcess);

    expect(killProcess).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("terminates the Windows Job Object supervisor", () => {
    const child = {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    terminateShellProcessTree(child, "win32");

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not target an exited child's stale PID", () => {
    const child = {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const killProcess = vi.fn();

    terminateShellProcessTree(child, "win32", "SIGTERM", killProcess);

    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("still terminates a POSIX group after its leader exits", () => {
    const child = {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const killProcess = vi.fn();

    terminateShellProcessTree(child, "linux", "SIGTERM", killProcess);

    expect(killProcess).toHaveBeenCalledWith(-42, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
