import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "babelfish-launch-"));
try {
  const script = path.join(root, "windows-job.ps1");
  const source = await fs.readFile(fileURLToPath(new URL("../assets/windows-job.ps1", import.meta.url)), "utf8");
  await fs.writeFile(script, source);
  const qualified = path.join(root, "qualified.ps1");
  await fs.writeFile(qualified, source.replace("Add-Type -TypeDefinition", "Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition"));
  const psHome = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0");
  const ps = path.join(psHome, "powershell.exe");
  const pick = (names) => Object.fromEntries(names.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const machine = path.join(root, "isolated-machine-data");
  await fs.mkdir(machine);
  for (const [label, mode, target = script, extra = {}] of [
    ["baseline", "implicit"], ["explicit", "named-import"], ["qualified", "implicit", qualified],
    ["inbox", "inbox-import"], ["baseline-again", "implicit"], ["inbox-again", "inbox-import"],
    ["machine-data", "implicit", script, { ProgramData: machine, ALLUSERSPROFILE: machine }],
  ]) {
    const home = path.join(root, label);
    await fs.mkdir(home);
    const env = { ...pick(["PATH","SystemRoot","ComSpec","PATHEXT","WINDIR"]), HOME: home, USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home, TMPDIR: home, TEMP: home, TMP: home, BABELFISH_LAUNCH_BENCH: mode, ...extra };
    const argv = Buffer.from(JSON.stringify(["git", "--version"])).toString("base64");
    const start = Date.now();
    const run = spawnSync(ps, ["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",target,"-Mode","command","-ArgvBase64",argv],
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
    assert.equal(markers.length, 6);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 4 });
}
