import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commandForPlatformShell,
  expandSingleQuotedShellVariables,
  spawnMonitorShellCommand,
  spawnShellCommand,
  terminateShellProcessTree,
} from "./shell-command.js";

describe("expandSingleQuotedShellVariables", () => {
  const resolve = (name: string) => name === "FLAG" ? "deny" : undefined;

  it("leaves double-quoted and bare variables for the shell", () => {
    expect(expandSingleQuotedShellVariables('echo "${FLAG}" ${FLAG}', resolve)).toBe(
      'echo "${FLAG}" ${FLAG}',
    );
  });

  it("inserts a single-quoted variable and escapes quotes in the value", () => {
    expect(expandSingleQuotedShellVariables("echo '${FLAG}'", () => "den'y", "linux")).toBe(
      "echo 'den'\\''y'",
    );
  });

  it("inserts a single-quoted name inside a double-quoted command substitution", () => {
    const command = "if [ \"$(printf %s '${FLAG}')\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(printf %s 'deny')\" = deny ]; then exit 2; fi; exit 0",
    );
    expect(expandSingleQuotedShellVariables(
      "if [ \"`printf %s '${FLAG}'`\" = deny ]; then exit 2; fi",
      () => "deny",
      "linux",
    )).toBe("if [ \"`printf %s 'deny'`\" = deny ]; then exit 2; fi");
  });

  it("leaves a double-quoted name inside a command substitution for the shell", () => {
    expect(expandSingleQuotedShellVariables(
      'echo "$(printf %s "${FLAG}")"',
      () => "deny",
      "linux",
    )).toBe('echo "$(printf %s "${FLAG}")"');
  });

  it("escapes an apostrophe inside a nested POSIX command substitution", () => {
    expect(expandSingleQuotedShellVariables(
      "$(printf %s '${FLAG}')",
      () => "a'b",
      "linux",
    )).toBe("$(printf %s 'a'\\''b')");
  });

  it("ignores an apostrophe inside a shell comment", () => {
    const command = "# don't skip guard\nif [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "# don't skip guard\nif [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("ignores an apostrophe inside a quoted here-document", () => {
    const command = "cat <<'EOF' >/dev/null\n'\nEOF\nif [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<'EOF' >/dev/null\n'\nEOF\nif [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps parsing the command after a here-document redirection", () => {
    const command = "cat <<'EOF' >/dev/null; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0\ntext\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<'EOF' >/dev/null; if [ 'deny' = deny ]; then exit 2; fi; exit 0\ntext\nEOF\n",
    );
  });

  it("closes an empty case before the following guard", () => {
    const command = ": \"$(case x in esac)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    const expanded = expandSingleQuotedShellVariables(command, () => "deny", "linux");
    expect(expanded).toBe(
      ": \"$(case x in esac)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
    if (process.platform === "win32") return;
    const result = spawnSync("/bin/sh", ["-lc", expanded], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  it("keeps esac as data inside a case arm", () => {
    const command = ": \"$(case x in x) echo esac;; esac)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    const expanded = expandSingleQuotedShellVariables(command, () => "deny", "linux");
    expect(expanded).toBe(
      ": \"$(case x in x) echo esac;; esac)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
    if (process.platform === "win32") return;
    const result = spawnSync("/bin/sh", ["-lc", expanded], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  it("keeps command position after then", () => {
    const command = "if [ \"$(if true; then case x in x) printf %s '${FLAG}';; esac; fi)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(if true; then case x in x) printf %s 'deny';; esac; fi)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("inserts a bare name inside a quoted here-document", () => {
    const command = "if [ \"$(cat <<'EOF'\n${FLAG}\nEOF\n)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(cat <<'EOF'\ndeny\nEOF\n)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("inserts a single-quoted name inside a command substitution in an unquoted here-document", () => {
    const command = "if [ \"$(cat <<EOF\n$(printf %s '${FLAG}')\nEOF\n)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(cat <<EOF\n$(printf %s 'deny')\nEOF\n)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("accepts an empty quoted here-document delimiter", () => {
    const command = "cat <<'' >/dev/null\n'\n\nif [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<'' >/dev/null\n'\n\nif [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("honors an escaped quote in a double-quoted here-document delimiter", () => {
    const command = "if [ \"$(cat <<\"E\\\"OF\"\n${FLAG}\nE\"OF\n)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(cat <<\"E\\\"OF\"\ndeny\nE\"OF\n)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("leaves quote characters in an unquoted here-document for the shell", () => {
    const command = "cat <<EOF\n'${FLAG}'\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "den'y", "linux")).toBe(command);
  });

  it("treats a partly quoted delimiter as a quoted here-document", () => {
    const command = "cat <<E'OF'\n${FLAG}\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<E'OF'\ndeny\nEOF\n",
    );
  });

  it("starts a here-document body after a comment on the header line", () => {
    const command = "cat <<'EOF' # note\n${FLAG}\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<'EOF' # note\ndeny\nEOF\n",
    );
  });

  it("leaves a bare name in an unquoted here-document for the shell", () => {
    const command = "cat <<EOF\n${FLAG}\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(command);
  });

  it("inserts a single-quoted name inside a quoted here-document", () => {
    const command = "sh <<'EOF'\nif [ '${FLAG}' = deny ]; then exit 2; fi\nexit 0\nEOF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "sh <<'EOF'\nif [ 'deny' = deny ]; then exit 2; fi\nexit 0\nEOF\n",
    );
  });

  it("does not treat a parenthesized case pattern as a substitution", () => {
    const command = ": \"$(case x in (x) :;; esac)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(case x in (x) :;; esac)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("does not treat case after a parameter expansion as syntax", () => {
    const command = ": \"$(${CMD} case in)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(${CMD} case in)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps an ordinary backslash in a double-quoted here-document delimiter", () => {
    const command = "cat <<\"E\\OF\"\nEOF\n${FLAG}\nE\\OF\n";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "cat <<\"E\\OF\"\nEOF\ndeny\nE\\OF\n",
    );
  });

  it("treats an empty quoted suffix as part of the same word", () => {
    const command = ": \"$(case\"\" in 2>/dev/null)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(case\"\" in 2>/dev/null)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps command position after pipeline negation", () => {
    const command = "if [ \"$( ! case x in x) printf %s '${FLAG}';; esac)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$( ! case x in x) printf %s 'deny';; esac)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("does not treat a plus-signed command as a reserved word", () => {
    const command = ": \"$(case+helper in 2>/dev/null)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(case+helper in 2>/dev/null)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps an inserted Windows value from becoming a cmd placeholder", () => {
    const expanded = expandSingleQuotedShellVariables(
      "if not '${FLAG}'=='allow' exit /b 2",
      () => "${OTHER}",
      "win32",
    );
    expect(commandForPlatformShell(expanded, "win32")).toBe(
      "if not '${OTHER}'=='allow' exit /b 2",
    );
    expect(commandForPlatformShell("echo \"${FLAG}\"", "win32")).toBe("echo \"%FLAG%\"");
  });

  it("does not treat a dotted or slashed command as a reserved word", () => {
    const dotted = ": \"$(case.helper in 2>/dev/null)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    const slashed = ": \"$(case/helper in 2>/dev/null)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(dotted, () => "deny", "linux")).toBe(
      ": \"$(case.helper in 2>/dev/null)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
    expect(expandSingleQuotedShellVariables(slashed, () => "deny", "linux")).toBe(
      ": \"$(case/helper in 2>/dev/null)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("recognizes a comment after a closing parenthesis", () => {
    const command = "if [ \"$( (true)# don't skip\nprintf %s '${FLAG}')\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$( (true)# don't skip\nprintf %s 'deny')\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("does not treat a hyphenated command as a reserved word", () => {
    const command = ": \"$(case-helper in 2>/dev/null)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(case-helper in 2>/dev/null)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps the backslash when a Windows double-quoted placeholder is escaped", () => {
    const command = "if \"\\${FLAG}\"==\"\\deny\" exit /b 2";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "win32")).toBe(
      "if \"\\deny\"==\"\\deny\" exit /b 2",
    );
  });

  it("counts a nested command substitution as the parent command word", () => {
    const command = ": \"$($(printf echo) case in)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$($(printf echo) case in)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("lets the shell expand escaped placeholders inside double quotes", () => {
    const command = "if [ \"\\${FLAG}\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"${FLAG}\" = deny ]; then exit 2; fi; exit 0",
    );
    expect(expandSingleQuotedShellVariables(command, () => "a\"b$(c)", "linux")).toBe(
      "if [ \"${FLAG}\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("inserts a placeholder after an unquoted backslash", () => {
    const command = "if [ \\${FLAG} = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("consumes command position when the executable is quoted", () => {
    const command = ": \"$('echo' case in)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$('echo' case in)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("starts a case arm in command position", () => {
    const command = "if [ \"$(case x in x) case y in y) printf %s '${FLAG}';; esac;; esac)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(case x in x) case y in y) printf %s 'deny';; esac;; esac)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("does not treat case and in arguments as shell syntax", () => {
    const command = ": \"$(printf '%s' case in)\"; if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      ": \"$(printf '%s' case in)\"; if [ 'deny' = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("keeps a command substitution open across a case pattern", () => {
    const command = "if [ \"$(case x in x) printf %s '${FLAG}';; esac)\" = deny ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "deny", "linux")).toBe(
      "if [ \"$(case x in x) printf %s 'deny';; esac)\" = deny ]; then exit 2; fi; exit 0",
    );
  });

  it("does not treat an unquoted escape as the start of a quote", () => {
    const command = ": \\'; if [ \"" + "${FLAG}" + "\" = \"den'y\" ]; then exit 2; fi; exit 0";
    expect(expandSingleQuotedShellVariables(command, () => "inserted", "linux")).toBe(command);
  });

  it("copies an apostrophe into a Windows command without a POSIX escape", () => {
    expect(expandSingleQuotedShellVariables(
      "if '${FLAG}'=='den'y' exit /b 2",
      () => "den'y",
      "win32",
    )).toBe("if 'den'y'=='den'y' exit /b 2");
  });

  it("keeps a single-quoted name the resolver does not supply", () => {
    expect(expandSingleQuotedShellVariables("echo '${OTHER}'", resolve)).toBe("echo '${OTHER}'");
  });
});

describe.skipIf(process.platform === "win32")("executed shell variable regressions", () => {
  const guard = "if [ '${FLAG}' = deny ]; then exit 2; fi; exit 0";
  it.each(["\\'; printf INJECTED; #", "a\\n'b"])("keeps values literal in native dollar-quoted strings (%s)", (value) => {
    const source = "printf '%s' $'${FLAG}'";
    const prefix = spawnSync("/bin/sh", ["-lc", "printf '%s' $''"], { encoding: "utf8" }).stdout;
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(prefix + value);
  });
  it.each(["$$", "\\$$", "$$$", "$\\\n$", "$\\\n$$"])("distinguishes dollar-quote introducers from parameter expansions (%s)", (prefix) => {
    const source = `printf '<%s>' ${prefix}'\${FLAG}'`;
    const value = "\\'; printf INJECTED; #";
    const baseline = spawnSync("/bin/sh", ["-lc", source.replace("${FLAG}", "")], { encoding: "utf8" });
    expect(baseline.stdout.endsWith(">")).toBe(true);
    const expected = baseline.stdout.replace(/[0-9]+/, "").slice(0, -1) + value + ">";
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.replace(/[0-9]+/, "")).toBe(expected);
  });
  it.each([
    ["esac pattern alternative", "if [ \"$(case x in (x|esac) printf %s '${FLAG}';; esac)\" = deny ]; then exit 2; fi; exit 0"],
    ["case pattern alternative", "if [ \"$(case x in (x|case) printf %s '${FLAG}';; esac)\" = deny ]; then exit 2; fi; exit 0"],
    ["parenthesized esac pattern", "if [ \"$(case esac in (esac) printf %s '${FLAG}';; esac)\" = deny ]; then exit 2; fi; exit 0"],
    ["escaped executable placeholder", `: "$(\\\${CMD} case in)"; ${guard}`],
    ["escaped executable word", `: "$(\\echo case in)"; ${guard}`],
    ["hash following an escaped space", `: \\ #'\${FLAG}'; ${guard}`],
    ["arithmetic names that resemble keywords", `: "$(( case + in ))"; ${guard}`],
    ["multiline arithmetic shift", `: "$((1 << 2\n))"; ${guard}`],
    ["parameter fallback with nested quotes", `: "\${OTHER:-"don't"}"; ${guard}`],
    ["brace used as an argument", `: "$(printf '%s' { case in)"; ${guard}`],
    ["substitution joined to a reserved-word prefix", `: "$(case$(printf %s helper) in 2>/dev/null)"; ${guard}`],
    ["parameter joined to a reserved-word prefix", `: "$(case\${SUFFIX:-helper} in 2>/dev/null)"; ${guard}`],
    ["in used as a case subject", `: "$(case in in esac)"; ${guard}`],
  ])("retains deny and allow decisions after %s", (_name, command) => {
    for (const value of ["deny", "allow"]) {
      const expanded = expandSingleQuotedShellVariables(command, (name) => name === "FLAG" ? value : "echo", "linux");
      const result = spawnSync("/bin/sh", ["-lc", expanded], {
        encoding: "utf8", env: { ...process.env, FLAG: value, CMD: "echo" },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(value === "deny" ? 2 : 0);
    }
  });

  it("matches the native shell's continued here-document delimiters", () => {
    const source = `cat <<EOF\nE\\\nOF\n${guard}`;
    for (const value of ["deny", "allow"]) {
      const options = { encoding: "utf8" as const, env: { ...process.env, FLAG: value } };
      const baseline = spawnSync("/bin/sh", ["-lc", source.replaceAll("${FLAG}", value)], options);
      const expanded = expandSingleQuotedShellVariables(source, () => value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", expanded], options);
      expect(result.status).toBe(baseline.status);
      expect(result.stdout).toBe(baseline.stdout);
    }
  });

  it("keeps inherited double quotes when inserting an escaped fallback value", () => {
    const source = "printf '%s' \"${BABELFISH_OPTIONAL:-\\${FLAG}}\"";
    const value = 'x"; $(printf INJECTED) `printf INJECTED` \\ tail';
    const command = expandSingleQuotedShellVariables(source, (name) => name === "FLAG" ? value : undefined, "linux");
    const env = { ...process.env, FLAG: value };
    delete env.BABELFISH_OPTIONAL;
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });
  it("keeps brace-matching quotes separate from fallback expansion", () => {
    const source = "printf '%s' \"${BABELFISH_OPTIONAL:-'}'\"\\${FLAG}\"}\"";
    const value = '$(printf INJECTED) " }';
    const env = { ...process.env, FLAG: value };
    delete env.BABELFISH_OPTIONAL;
    const baseline = spawnSync("/bin/sh", ["-lc", source.replace("${FLAG}", "SENTINEL")], { encoding: "utf8", env });
    const command = expandSingleQuotedShellVariables(source, (name) => name === "FLAG" ? value : undefined, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env });
    expect(baseline.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(baseline.stdout.replace("SENTINEL", value));
  });
  it("lets the shell expand apostrophes inside brace-matching quotes as data", () => {
    const source = "printf '%s' \"${BABELFISH_OPTIONAL:-'\\${FLAG}'}\"";
    const value = "a'b$(printf INJECTED)}";
    const env = { ...process.env, FLAG: value };
    delete env.BABELFISH_OPTIONAL;
    const command = expandSingleQuotedShellVariables(source, (name) => name === "FLAG" ? value : undefined, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("'" + value + "'");
  });

  it.each(["deny", "$(printf INJECTED)", "$(printf INJECTED)}"])("retains here-document quoting inside a fallback (%s)", (value) => {
    const source = "cat <<EOF\n${BABELFISH_OPTIONAL:-\\${FLAG}}\nEOF";
    const command = expandSingleQuotedShellVariables(source, (name) => name === "FLAG" ? value : undefined, "linux");
    const env = { ...process.env, FLAG: value };
    delete env.BABELFISH_OPTIONAL;
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe((value === "deny" ? "\\" : "") + value + "\n");
  });

  it.each(["#", "##", "%", "%%"])("preserves quoted parameter-removal patterns (%s)", (operator) => {
    for (const value of ["deny", "allow"]) {
      const input = operator.startsWith("#") ? `prefix${value}` : `${value}suffix`;
      const pattern = operator.startsWith("#") ? "prefix" : "suffix";
      const source = `if [ "\${VALUE${operator}'\${PATTERN}'}" = deny ]; then exit 2; fi; exit 0`;
      const command = expandSingleQuotedShellVariables(source, (name) => name === "PATTERN" ? pattern : input, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env: { ...process.env, VALUE: input } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(value === "deny" ? 2 : 0);
    }
  });

  it.each(["'${DELIMITER}'", '"${DELIMITER}"', "${DELIMITER}"])("preserves variable here-document delimiters (%s)", (header) => {
    for (const closing of ["END", "${DELIMITER}"]) {
      for (const value of ["deny", "allow"]) {
        const source = `: <<${header}\nignored\n${closing}\n${guard}`;
        const command = expandSingleQuotedShellVariables(source, (name) => name === "DELIMITER" ? "END" : value, "linux");
        const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env: { ...process.env, FLAG: value } });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(value === "deny" ? 2 : 0);
      }
    }
  });
  it("recognizes native ANSI-C quoting in a variable here-document delimiter", () => {
    const prefix = spawnSync("/bin/sh", ["-lc", "printf '%s' $''"], { encoding: "utf8" }).stdout;
    for (const value of ["deny", "allow"]) {
      const source = `: <<$'\${DELIMITER}'\nignored\n${prefix}END\n${guard}`;
      const command = expandSingleQuotedShellVariables(source, (name) => name === "DELIMITER" ? "END" : value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(value === "deny" ? 2 : 0);
    }
  });
  it("decodes ANSI-C delimiter escape bytes when the native shell supports them", () => {
    if (spawnSync("/bin/sh", ["-lc", "printf '%s' $''"], { encoding: "utf8" }).stdout) return;
    for (const [header, closing] of [["$'E\\x4eD'", "END"], ["$'E\\'ND'", "E'ND"], ["$'\\303\\251'", "é"]]) {
      const source = `: <<${header}\nignored\n${closing}\n${guard}`;
      const command = expandSingleQuotedShellVariables(source, () => "deny", "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(2);
    }
  });
  it("uses native ANSI-C delimiter escape semantics before inserting values", () => {
    if (spawnSync("/bin/sh", ["-lc", "printf '%s' $''"], { encoding: "utf8" }).stdout) return;
    for (const header of ["$'E\\u0041D'", "$'E\\U00000041D'", "$'E\\c?D'"]) {
      const delimiter = spawnSync("/bin/sh", ["-lc", `printf '%s' ${header}`], { encoding: "utf8" }).stdout;
      const source = `: <<${header}\nignored\n${delimiter}\nprintf '%s' '\${FLAG}'`;
      const value = "x'; printf INJECTED; #";
      const command = expandSingleQuotedShellVariables(source, () => value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(value);
    }
  });
  it("keeps delimiter values out of the native ANSI-C decoder's source", () => {
    const prefix = spawnSync("/bin/sh", ["-lc", "printf '%s' $''"], { encoding: "utf8" }).stdout;
    const value = "END'; printf INJECTED; #";
    const source = `: <<$'\${DELIMITER}'\nignored\n${prefix}${value}\nprintf '%s' safe`;
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("safe");
  });

  it.each(["\\${FLAG}", '"\\${FLAG}"', "'${FLAG}'", '"${FLAG}"'])(
    "passes shell syntax as data in %s", (argument) => {
      const value = "a'\"; $(printf INJECTED) `printf INJECTED` \\ tail";
      const command = expandSingleQuotedShellVariables(`printf '%s' ${argument}`, () => value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], {
        encoding: "utf8", env: { ...process.env, FLAG: value },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(value);
    },
  );

  it.each([
    "printf '%s' \"`printf '%s' '${FLAG}'`\"",
    "printf '%s' \"`printf '%s' \\${FLAG}`\"",
  ])("keeps substituted backticks and dollars literal in %s", (source) => {
    const value = "x`$(printf INJECTED)`y'\\z";
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it.each([
    "printf '%s' \"`printf '%s' \\`printf '%s' '${FLAG}'\\``\"",
    "printf '%s' \"`cat <<'EOF'\n${FLAG}\nEOF\n`\"",
  ])("keeps nested backtick and document inserts literal in %s", (source) => {
    const value = "x`$(printf${IFS}INJECTED)`y'\\z";
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it("preserves escaped here-document values through the enclosing backtick layer", () => {
    const value = "$(printf INJECTED)";
    const source = "printf '%s' \"`cat <<EOF\n\\${FLAG}\nEOF\n`\"";
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it.each(["deny", "a; $(printf INJECTED)\nEOF\nprintf INJECTED"])(
    "preserves escaped text in an unquoted here-document (%s)", (value) => {
      const source = "cat <<EOF\n\\${FLAG}\nEOF\n";
      const command = expandSingleQuotedShellVariables(source, () => value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("\\" + value + "\n");
    },
  );

  it.each(["EOF", "", "E'OF'"])("keeps inserted delimiter lines inside a quoted here-document (%s)", (delimiter) => {
    const value = `x\n${delimiter}\nprintf INJECTED\nBABELFISH_HEREDOC\n`;
    const quoted = "'" + delimiter.replaceAll("'", "'\\''") + "'";
    const source = `cat <<${quoted}\n\${FLAG}\n${delimiter}\n`;
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value + "\n");
  });

  it.each(["cat <<EO\\\nF >/dev/null\nignored\nEOF\nprintf '%s' '${FLAG}'", "cat <<\"EO\\\nF\" >/dev/null\nignored\nEOF\nprintf '%s' '${FLAG}'", "cat <<\\\nEOF >/dev/null\nignored\nEOF\nprintf '%s' '${FLAG}'"])("removes continued delimiter words before locating the body (%s)", (source) => {
    const value = "x'; printf INJECTED; #";
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it("decodes legacy escape layers before identifying quotes", () => {
    const source = "printf '%s' \"`printf '%s' \\\\'\"${FLAG}\"\\\\'`\"";
    const value = 'x"; printf INJECTED; #';
    const command = expandSingleQuotedShellVariables(source, () => value, "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env: { ...process.env, FLAG: value } });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("'" + value + "'");
  });

  it("keeps a nested guard visible after legacy dollar escape removal", () => {
    const source = "if [ \"`printf '%s' \\$(printf '%s' '${FLAG}')`\" = deny ]; then exit 2; fi; exit 0";
    for (const value of ["deny", "allow"]) {
      const command = expandSingleQuotedShellVariables(source, () => value, "linux");
      const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8", env: { ...process.env, FLAG: value } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(value === "deny" ? 2 : 0);
    }
  });

  it("preserves multiple here-document boundaries when both values contain their delimiters", () => {
    const source = "cat <<'ONE' <<-'TWO'\n${FIRST}\nONE\n${SECOND}\nTWO\n";
    const values: Record<string, string> = { FIRST: "ONE\nprintf INJECTED", SECOND: "\tTWO\nprintf INJECTED" };
    const command = expandSingleQuotedShellVariables(source, (name) => values[name], "linux");
    const result = spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("TWO\nprintf INJECTED\n");
  });
});

describe("commandForPlatformShell", () => {
  it("keeps cmd parameter-like text independent of POSIX parsing", () => {
    const source = 'echo "${OPTIONAL:-\'fallback\'}"';
    const expanded = expandSingleQuotedShellVariables(source, () => undefined, "win32");
    expect(commandForPlatformShell(expanded, "win32")).toBe(source);
  });
  it("leaves braced variables for the POSIX shell", () => {
    expect(commandForPlatformShell('printf "%s" "${CLAUDE_PROJECT_DIR}"', "linux")).toBe(
      'printf "%s" "${CLAUDE_PROJECT_DIR}"',
    );
  });

  it("asks Windows cmd to expand the same names", () => {
    expect(commandForPlatformShell('node "${CLAUDE_PLUGIN_ROOT}\\monitor.mjs"', "win32")).toBe(
      'node "%CLAUDE_PLUGIN_ROOT%\\monitor.mjs"',
    );
  });
});

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
