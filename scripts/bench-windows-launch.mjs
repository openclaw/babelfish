import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-launch-"));
try {
  const script = path.join(root, "windows-job.ps1");
  await fs.copyFile(fileURLToPath(new URL("../assets/windows-job.ps1", import.meta.url)), script);
  const psHome = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0");
  const ps = path.join(psHome, "powershell.exe");
  const modules = { PSModulePath: path.join(psHome, "Modules") };
  const pick = (names) => Object.fromEntries(names.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const files = pick(["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432"]);
  const platform = pick(["SystemDrive", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]);
  const absoluteGit = spawnSync("where.exe", ["git.exe"], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
  assert(path.isAbsolute(absoluteGit));
  for (const [label, extra, git = "git"] of [
    ["baseline", {}], ["inbox-modules", modules], ["program-files", files], ["platform", platform],
    ["program-files-only", pick(["ProgramFiles"])],
    ["architecture-only", pick(["PROCESSOR_ARCHITECTURE"])],
    ["absolute-git", {}, absoluteGit], ["combined", { ...modules, ...platform, ...files }],
    ["baseline-again", {}],
  ]) {
    const home = path.join(root, label);
    await fs.mkdir(home);
    const env = { ...pick(["PATH","SystemRoot","ComSpec","PATHEXT","WINDIR"]), HOME: home, USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home, TMPDIR: home, TEMP: home, TMP: home, BABELFISH_LAUNCH_BENCH: "1", ...extra };
    const argv = Buffer.from(JSON.stringify([git, "--version"])).toString("base64");
    const start = Date.now();
    const run = spawnSync(ps, ["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-Mode","command","-ArgvBase64",argv],
      { env, cwd: root, encoding: "utf8", timeout: 90000 });
    const end = Date.now();
    const markers = [...String(run.stderr).matchAll(/\[launch-bench\] (\w+) (\d+)/g)];
    let previous = start;
    const durations = {};
    for (const [,name,timestamp] of markers) {
      durations[name] = Number(timestamp) - previous;
      previous = Number(timestamp);
    }
    durations.childAndExit = end - previous;
    console.log(JSON.stringify({ label, totalMs: end - start, durations, status: run.status }));
    assert.equal(run.status, 0);
    assert.match(run.stdout, /git version/);
    assert.equal(markers.length, 5);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 4 });
}
