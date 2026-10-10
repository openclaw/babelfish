import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
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

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WIN_INSERTED_DOLLAR = "$\u0000";

function shieldWindowsValue(value: string): string {
  return value.replaceAll("${", `${WIN_INSERTED_DOLLAR}{`);
}

type CasePhase = "subject" | "separator" | "pattern-start" | "pattern" | "body";

type HereDoc = {
  delimiter: string;
  originalDelimiter: string;
  headerExpanded: boolean;
  stripTabs: boolean;
  quoted: boolean;
  headerStart?: number;
  headerEnd?: number;
};

const OPENS_COMMAND = new Set(["if", "then", "else", "elif", "while", "until", "do"]);

function readAnsiQuote(command: string, start: number): { text: string; end: number } | null {
  for (let cursor = start + 2; cursor < command.length; cursor += 1) {
    if (command[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (command[cursor] !== "'") continue;
    // Only a complete quoted literal reaches the native decoder; values are inserted afterward.
    const literal = command.slice(start, cursor + 1);
    const decoded = spawnSync("/bin/sh", ["-c", `printf '%s' ${literal}`], {
      env: {}, timeout: 1000, maxBuffer: 1024 * 1024,
    });
    if (decoded.error || decoded.status !== 0) throw new Error("Could not decode ANSI-C here-document delimiter");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(decoded.stdout), end: cursor + 1 };
  }
  return null;
}

type QuoteFrame = {
  inSingle: boolean;
  ansiSingle?: boolean;
  inDouble: boolean;
  paren: number;
  caseStack: CasePhase[];
  commandPosition: boolean;
  pendingDocs: HereDoc[];
  literalHere: boolean;
  arithmetic: boolean;
  parameter?: boolean;
  quotedParameter?: boolean;
  braceSingle?: boolean;
  hereParameter?: boolean;
  parentWord?: { word: string; quoted: boolean; expanded: boolean };
};

function parseHereHeader(command: string, index: number, resolve: (name: string) => string | undefined): { cursor: number; delimiterStart: number; doc: HereDoc } | null {
  let cursor = index + 2;
  let stripTabs = false;
  if (command[cursor] === "-") {
    stripTabs = true;
    cursor += 1;
  }
  while (command[cursor] === " " || command[cursor] === "\t" || command.startsWith("\\\n", cursor)) {
    cursor += command.startsWith("\\\n", cursor) ? 2 : 1;
  }
  const delimiterStart = cursor;
  let delimiter = "";
  let quoted = false;
  while (cursor < command.length) {
    const mark = command[cursor] ?? "";
    if (mark === "$" && command[cursor + 1] === "'" && followsUnescapedDollar(command, cursor + 1) && shellSupportsAnsiQuotes()) {
      const ansi = readAnsiQuote(command, cursor);
      if (!ansi) return null;
      delimiter += ansi.text;
      cursor = ansi.end;
      quoted = true;
      continue;
    }
    if (mark === "'") {
      const endQuote = command.indexOf("'", cursor + 1);
      if (endQuote === -1) return null;
      delimiter += command.slice(cursor + 1, endQuote);
      cursor = endQuote + 1;
      quoted = true;
      continue;
    }
    if (mark === "\"") {
      let text = "";
      let scan = cursor + 1;
      let closed = false;
      while (scan < command.length) {
        if (command[scan] === "\\" && command[scan + 1] !== undefined) {
          const next = command[scan + 1] ?? "";
          if (next === "\\" || next === "$" || next === "`" || next === "\"" || next === "\n") {
            if (next !== "\n") text += next;
            scan += 2;
            continue;
          }
          text += "\\";
          scan += 1;
          continue;
        }
        if (command[scan] === "\"") {
          closed = true;
          break;
        }
        text += command[scan];
        scan += 1;
      }
      if (!closed) return null;
      delimiter += text;
      cursor = scan + 1;
      quoted = true;
      continue;
    }
    if (mark === "\\") {
      const next = command[cursor + 1];
      if (next === undefined) break;
      if (next === "\n") {
        cursor += 2;
        continue;
      }
      delimiter += next;
      cursor += 2;
      quoted = true;
      continue;
    }
    if (/[\s;&|<>()]/.test(mark)) break;
    delimiter += mark;
    cursor += 1;
  }
  if (!delimiter && !quoted) return null;
  const originalDelimiter = delimiter;
  delimiter = delimiter.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => resolve(name) ?? match);
  return { cursor, delimiterStart, doc: { delimiter, originalDelimiter, headerExpanded: delimiter !== originalDelimiter, stripTabs, quoted } };
}

function appendPendingHereDocs(
  command: string,
  index: number,
  frame: QuoteFrame,
  out: string,
  resolve: (name: string) => string | undefined,
  platform: NodeJS.Platform,
): { out: string; index: number } {
  while (frame.pendingDocs.length > 0) {
    const doc = frame.pendingDocs.shift()!;
    const split = splitHereBody(command, index, doc);
    const body = command.slice(index, split.bodyEnd);
    const expanded = doc.quoted
      ? expandQuotedHereBody(body, resolve)
      : expandSingleQuotedShellVariables(body, resolve, platform, { literalHere: true });
    const lines = [...hereDocumentLines(expanded, 0, doc)];
    const hasDelimiter = (delimiter: string): boolean => lines.some((line) => line.text === delimiter);
    if (doc.headerExpanded || hasDelimiter(doc.delimiter)) {
      let delimiter = "BABELFISH_HEREDOC";
      while (hasDelimiter(delimiter)) delimiter += "_";
      const start = doc.headerStart!;
      const end = doc.headerEnd!;
      const replacement = doc.quoted ? `'${delimiter}'` : delimiter;
      out = out.slice(0, start) + replacement + out.slice(end);
      const delta = replacement.length - (end - start);
      for (const pending of frame.pendingDocs) {
        pending.headerStart! += delta;
        pending.headerEnd! += delta;
      }
      out += expanded;
      if (split.bodyEnd < split.end) {
        out += delimiter + (command[split.end - 1] === "\n" ? "\n" : "");
      }
    } else {
      out += expanded + command.slice(split.bodyEnd, split.end);
    }
    index = split.end;
  }
  return { out, index };
}

function expandQuotedHereBody(
  body: string,
  resolve: (name: string) => string | undefined,
): string {
  return body.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = resolve(name);
    return value === undefined ? match : value;
  });
}

let joinsHereDocumentLines: boolean | undefined;
let supportsAnsiQuotes: boolean | undefined;
let preservesParameterQuotes: boolean | undefined;

function shellPreservesParameterQuotes(): boolean {
  if (preservesParameterQuotes === undefined) {
    const probe = spawnSync("/bin/sh", ["-c", "printf '%s' \"${BABELFISH_PROBE_UNSET:-'}'}\""], {
      env: {}, encoding: "utf8", timeout: 1000, maxBuffer: 1024,
    });
    if (probe.error || probe.status !== 0) throw new Error("Could not determine shell parameter quoting behavior");
    preservesParameterQuotes = probe.stdout === "'}'";
  }
  return preservesParameterQuotes;
}

function shellSupportsAnsiQuotes(): boolean {
  if (supportsAnsiQuotes === undefined) {
    const probe = spawnSync("/bin/sh", ["-c", "printf '%s' $'\\141'"], {
      env: {}, encoding: "utf8", timeout: 1000, maxBuffer: 1024,
    });
    if (probe.error || probe.status !== 0) {
      throw new Error("Could not determine shell ANSI-C quoting behavior");
    }
    supportsAnsiQuotes = probe.stdout === "a";
  }
  return supportsAnsiQuotes;
}

function followsUnescapedDollar(command: string, quote: number): boolean {
  const skipContinuations = (index: number): number => {
    while (index > 0 && command[index] === "\n" && command[index - 1] === "\\") index -= 2;
    return index;
  };
  let dollar = skipContinuations(quote - 1);
  if (command[dollar] !== "$") return false;
  let dollars = 0;
  while (dollar >= 0 && command[dollar] === "$") {
    dollars += 1;
    dollar = skipContinuations(dollar - 1);
  }
  let slashes = 0;
  for (let index = dollar; index >= 0 && command[index] === "\\"; index -= 1) slashes += 1;
  return (dollars - (slashes % 2)) % 2 === 1;
}

function shellJoinsHereDocumentLines(): boolean {
  if (joinsHereDocumentLines === undefined) {
    // Bash and dash disagree here. Probe only this syntax, once, without user code or environment.
    const probe = spawnSync("/bin/sh", ["-c", ": <<EOF\nE\\\nOF\nexit 73\nEOF\n"], {
      env: {}, timeout: 1000, maxBuffer: 1024,
    });
    if (probe.error || (probe.status !== 0 && probe.status !== 73)) {
      throw new Error("Could not determine shell here-document continuation behavior");
    }
    joinsHereDocumentLines = probe.status === 73;
  }
  return joinsHereDocumentLines;
}

function* hereDocumentLines(command: string, start: number, doc: HereDoc): Generator<{ text: string; start: number; end: number }> {
  let cursor = start;
  while (cursor < command.length) {
    const lineStart = cursor;
    let text = "";
    while (cursor < command.length) {
      const newline = command.indexOf("\n", cursor);
      const end = newline === -1 ? command.length : newline;
      let line = command.slice(cursor, end);
      if (doc.stripTabs) line = line.replace(/^\t+/, "");
      cursor = newline === -1 ? command.length : newline + 1;
      const slashes = /\\+$/.exec(line)?.[0].length ?? 0;
      if (!doc.quoted && newline !== -1 && slashes % 2 === 1 && shellJoinsHereDocumentLines()) {
        text += line.slice(0, -1);
        continue;
      }
      text += line;
      break;
    }
    yield { text, start: lineStart, end: cursor };
  }
}

function splitHereBody(command: string, start: number, doc: HereDoc): { bodyEnd: number; end: number } {
  for (const line of hereDocumentLines(command, start, doc)) {
    if (line.text === doc.delimiter || (doc.headerExpanded && line.text === doc.originalDelimiter)) {
      return { bodyEnd: line.start, end: line.end };
    }
  }
  return { bodyEnd: command.length, end: command.length };
}

function isCasePattern(frame: QuoteFrame): boolean {
  return frame.caseStack.at(-1) === "pattern-start" || frame.caseStack.at(-1) === "pattern";
}

function noteShellWord(frame: QuoteFrame, word: string): void {
  if (isCasePattern(frame)) {
    // Only the first unquoted pattern token can close an empty/final case arm.
    if (word === "esac" && frame.caseStack.at(-1) === "pattern-start") {
      frame.caseStack.pop();
      frame.commandPosition = false;
    } else {
      frame.caseStack[frame.caseStack.length - 1] = "pattern";
    }
    return;
  }
  if (word === "{" && frame.commandPosition) {
    frame.commandPosition = true;
    return;
  }
  if (word === "!" && frame.commandPosition) return;
  if (word === "case" && frame.commandPosition) {
    frame.caseStack.push("subject");
    frame.commandPosition = false;
    return;
  }
  if (word === "in" && frame.caseStack.at(-1) === "separator") {
    frame.caseStack[frame.caseStack.length - 1] = "pattern-start";
    frame.commandPosition = false;
    return;
  }
  if (word === "esac" && frame.caseStack.at(-1) === "body" && frame.commandPosition) {
    frame.caseStack.pop();
    frame.commandPosition = false;
    return;
  }
  frame.commandPosition = frame.commandPosition && OPENS_COMMAND.has(word);
}

function readLegacyBackticks(command: string, start: number, inDouble: boolean, resolve: (name: string) => string | undefined): { body: string; end: number } {
  let body = "";
  for (let cursor = start + 1; cursor < command.length; cursor += 1) {
    const character = command[cursor]!;
    const next = command[cursor + 1];
    if (character === "\\" && (next === "$" || next === "`" || next === "\\" || next === "\n" || (inDouble && next === '"'))) {
      const placeholder = next === "$" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(command.slice(cursor + 1)) : null;
      // Keep known escaped placeholders on the literal-insertion path after decoding.
      if (placeholder && resolve(placeholder[1]!) !== undefined) body += "\\";
      if (next !== "\n") body += next;
      cursor += 1;
    } else if (character === "`") {
      return { body, end: cursor + 1 };
    } else {
      body += character;
    }
  }
  throw new Error("Unterminated legacy command substitution");
}

// Values already inside single quotes are inserted here. The shell never
// expands ${NAME} in single quotes, and a raw insert would let a quote in
// the value close a POSIX string. A $(...) or backtick command starts a new
// quote context, including when the outer command is double-quoted. cmd.exe
// treats apostrophes as ordinary characters, so Windows copies the value.
export function expandSingleQuotedShellVariables(
  command: string,
  resolve: (name: string) => string | undefined,
  platform: NodeJS.Platform = process.platform,
  options: { literalHere?: boolean } = {},
): string {
  const stack: QuoteFrame[] = [{
    inSingle: false,
    inDouble: false,
    paren: 0,
    caseStack: [],
    commandPosition: true,
    pendingDocs: [],
    literalHere: options.literalHere === true,
    arithmetic: false,
  }];
  let out = "";
  let word = "";
  let wordQuoted = false;
  let wordExpanded = false;
  const takeParentWord = (): NonNullable<QuoteFrame["parentWord"]> => {
    const saved = { word, quoted: wordQuoted, expanded: true };
    word = "";
    wordQuoted = false;
    wordExpanded = false;
    return saved;
  };
  const restoreParentWord = (frame: QuoteFrame): void => {
    word = frame.parentWord?.word ?? "";
    wordQuoted = frame.parentWord?.quoted ?? false;
    wordExpanded = frame.parentWord?.expanded ?? true;
  };
  const flushWord = (): void => {
    if (!word && !wordQuoted && !wordExpanded) return;
    const frame = stack[stack.length - 1]!;
    if (!frame.literalHere && !frame.arithmetic && !frame.parameter && frame.caseStack.at(-1) === "subject") {
      frame.caseStack[frame.caseStack.length - 1] = "separator";
      frame.commandPosition = false;
    } else if (!frame.literalHere && !frame.arithmetic && !frame.parameter && !wordQuoted && !wordExpanded) noteShellWord(frame, word);
    else if (!frame.literalHere && !frame.arithmetic && !frame.parameter) {
      if (isCasePattern(frame)) frame.caseStack[frame.caseStack.length - 1] = "pattern";
      frame.commandPosition = false;
    }
    word = "";
    wordQuoted = false;
    wordExpanded = false;
  };
  for (let index = 0; index < command.length;) {
    const frame = stack[stack.length - 1]!;
    const character = command[index] ?? "";
    const quoted = frame.inSingle || frame.inDouble || frame.braceSingle;
    if (frame.parameter && !quoted && character === "}") {
      stack.pop();
      restoreParentWord(frame);
      out += character;
      index += 1;
      continue;
    }
    if (platform !== "win32" && frame.parameter && frame.quotedParameter && !frame.inDouble && character === "'" && shellPreservesParameterQuotes()) {
      frame.braceSingle = !frame.braceSingle;
      out += character;
      index += 1;
      continue;
    }
    if (!frame.literalHere && !frame.inDouble && !frame.quotedParameter && character === "'") {
      wordQuoted = true;
      frame.ansiSingle = !frame.inSingle && platform !== "win32" && followsUnescapedDollar(command, index) && shellSupportsAnsiQuotes();
      frame.inSingle = !frame.inSingle;
      out += character;
      index += 1;
      continue;
    }
    if (frame.ansiSingle && character === "\\") {
      out += command.slice(index, index + 2);
      index += Math.min(2, command.length - index);
      continue;
    }
    if (!frame.literalHere && !frame.inSingle && !frame.braceSingle && character === "\"") {
      wordQuoted = true;
      frame.inDouble = !frame.inDouble;
      out += character;
      index += 1;
      continue;
    }
    if ((frame.inDouble || frame.quotedParameter) && character === "\\") {
      const next = command[index + 1];
      if (next === "$" && command.startsWith("${", index + 1)) {
        const end = command.indexOf("}", index + 3);
        const name = end === -1 ? "" : command.slice(index + 3, end);
        if (end !== -1 && SHELL_NAME.test(name)) {
          const value = resolve(name);
          if (value !== undefined) {
            if (platform === "win32") out += `\\${shieldWindowsValue(value)}`;
            else {
              if (frame.hereParameter && !/^[\\$`"}\n]/.test(value)) out += "\\\\";
              out += command.slice(index + 1, end + 1);
            }
            index = end + 1;
            continue;
          }
        }
      }
      out += next === undefined ? character : `${character}${next}`;
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (platform !== "win32" && !frame.inSingle && !frame.inDouble && character === "\\") {
      const next = command[index + 1];
      if (next === "$" && command.startsWith("${", index + 1)) {
        const end = command.indexOf("}", index + 3);
        const name = end === -1 ? "" : command.slice(index + 3, end);
        if (end !== -1 && SHELL_NAME.test(name)) {
          const value = resolve(name);
          if (value !== undefined) {
            if (frame.literalHere) {
              const literal = /^[\\$`]/.test(value) ? value : `\\${value}`;
              out += literal.replace(/[\\$`]/g, (mark) => `\\${mark}`);
            } else {
              out += "'" + value.replaceAll("'", "'\\''") + "'";
            }
            wordExpanded = true;
            index = end + 1;
            continue;
          }
        }
      }
      if (next !== "\n") wordQuoted = true;
      out += next === undefined ? character : `${character}${next}`;
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (
      platform !== "win32"
      && !frame.literalHere
      && !frame.parameter
      && !frame.inSingle
      && !frame.inDouble
      && character === "#"
      && !word && !wordQuoted && !wordExpanded
    ) {
      const newline = command.indexOf("\n", index);
      const end = newline === -1 ? command.length : newline + 1;
      frame.commandPosition = true;
      out += command.slice(index, end);
      index = end;
      if (newline !== -1) {
        const drained = appendPendingHereDocs(command, index, frame, out, resolve, platform);
        out = drained.out;
        index = drained.index;
      }
      continue;
    }
    if (platform !== "win32" && !frame.literalHere && !frame.arithmetic && !frame.parameter && !quoted && command.startsWith("<<", index)) {
      flushWord();
      const header = parseHereHeader(command, index, resolve);
      if (header) {
        frame.pendingDocs.push({
          ...header.doc,
          headerStart: out.length + header.delimiterStart - index,
          headerEnd: out.length + header.cursor - index,
        });
        out += command.slice(index, header.cursor);
        index = header.cursor;
        continue;
      }
    }
    if (platform !== "win32" && !quoted && character === "\n") {
      flushWord();
      out += "\n";
      index += 1;
      frame.commandPosition = true;
      const drained = appendPendingHereDocs(command, index, frame, out, resolve, platform);
      out = drained.out;
      index = drained.index;
      continue;
    }
    if (platform !== "win32" && !quoted && command.startsWith(";;", index) && frame.caseStack.at(-1) === "body") {
      flushWord();
      frame.caseStack[frame.caseStack.length - 1] = "pattern-start";
      frame.commandPosition = false;
      out += ";;";
      index += 2;
      continue;
    }
    if (platform !== "win32" && !frame.inSingle && command.startsWith("$(", index)) {
      const arithmetic = command.startsWith("$((", index);
      stack.push({
        parentWord: takeParentWord(),
        inSingle: false,
        inDouble: false,
        paren: arithmetic ? 2 : 1,
        caseStack: [],
        commandPosition: true,
        pendingDocs: [],
        literalHere: false,
        arithmetic,
      });
      out += arithmetic ? "$((" : "$(";
      index += arithmetic ? 3 : 2;
      continue;
    }
    if (platform !== "win32" && !frame.inSingle && character === "`") {
      const legacy = readLegacyBackticks(command, index, frame.inDouble || frame.quotedParameter === true, resolve);
      const expanded = expandSingleQuotedShellVariables(legacy.body, resolve, platform);
      out += "`" + expanded.replace(/[\\`$]/g, (mark) => `\\${mark}`) + "`";
      wordExpanded = true;
      index = legacy.end;
      continue;
    }
    if (frame.paren > 0 && !quoted && character === "(") {
      flushWord();
      if (isCasePattern(frame)) {
        frame.caseStack[frame.caseStack.length - 1] = "pattern";
        out += character;
        index += 1;
        continue;
      }
      frame.paren += 1;
      frame.commandPosition = true;
      out += character;
      index += 1;
      continue;
    }
    if (frame.paren > 0 && !quoted && character === ")") {
      flushWord();
      if (isCasePattern(frame)) {
        frame.caseStack[frame.caseStack.length - 1] = "body";
        frame.commandPosition = true;
        out += character;
        index += 1;
        continue;
      }
      frame.paren -= 1;
      out += character;
      index += 1;
      if (frame.paren === 0) {
        stack.pop();
        restoreParentWord(frame);
      }
      continue;
    }
    if (command.startsWith("${", index)) {
      const end = command.indexOf("}", index + 2);
      const name = end === -1 ? "" : command.slice(index + 2, end);
      if (end !== -1 && SHELL_NAME.test(name)) {
        if (frame.inSingle) {
          const value = resolve(name);
          if (value !== undefined) {
            out += platform === "win32" ? shieldWindowsValue(value)
              : frame.ansiSingle ? value.replace(/[\\']/g, (mark) => `\\${mark}`)
                : value.replaceAll("'", "'\\''");
            index = end + 1;
            continue;
          }
        }
        if (!frame.inSingle) wordExpanded = true;
        out += command.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (platform !== "win32" && !frame.inSingle) {
        const pattern = /^\$\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?$!_-])[#%]/.test(command.slice(index));
        stack.push({ inSingle: false, inDouble: false, paren: 0, parentWord: takeParentWord(), caseStack: [], commandPosition: false, pendingDocs: [],
          literalHere: false, arithmetic: false, parameter: true,
          hereParameter: frame.literalHere || frame.hereParameter,
          quotedParameter: !pattern && (frame.literalHere || frame.inDouble || frame.quotedParameter) });
        out += "${";
        index += 2;
        continue;
      }
    }
    if (!quoted && character === "|" && isCasePattern(frame)) {
      flushWord();
      frame.caseStack[frame.caseStack.length - 1] = "pattern";
      out += character;
      index += 1;
      continue;
    }
    if (platform !== "win32" && !frame.literalHere && (quoted || !/[\s;&|()<>]/.test(character))) {
      word += character;
    } else if (!quoted) {
      flushWord();
      if (character === ";" || character === "|" || character === "&") {
        frame.commandPosition = true;
      }
    }
    out += character;
    index += 1;
  }
  return out;
}

// cmd.exe expands %NAME%, not ${NAME}. The value stays in the environment.
export function commandForPlatformShell(command: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") {
    return command;
  }
  return command
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `%${name}%`)
    .replaceAll(WIN_INSERTED_DOLLAR, "$");
}

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
  if (typeof command === "string") {
    command = commandForPlatformShell(command, platform);
  }
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
  const shellCommand = commandForPlatformShell(command, platform);
  if (platform === "win32") {
    return spawnWindowsJobCommand(shellCommand, "monitor", options, spawnProcess);
  }
  return spawnShellCommand(shellCommand, options, platform, spawnProcess);
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
