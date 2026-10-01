export function splitFrontmatter(source: string): { frontmatter: string; body: string } | undefined {
  const match = /^---\r?\n(?:([\s\S]*?\r?\n))?---(?:\r?\n|$)/.exec(source);
  if (!match) return undefined;
  return {
    frontmatter: (match[1] ?? "").replaceAll("\r\n", "\n"),
    body: source.slice(match[0].length),
  };
}

export function readFrontmatterScalar(
  frontmatter: string,
  name: string,
): { value: string; consumed: number[] } | undefined {
  const normalized = frontmatter.replaceAll("\r\n", "\n");
  const finalBreak = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalBreak) lines.pop();
  const key = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = key.exec(lines[index] ?? "");
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    const header = /^([|>])(?:([-+])([1-9])?|([1-9])([-+])?)?(?:[ \t]+#.*)?$/.exec(raw);
    if (!header) {
      if (/^[|>]/.test(raw)) throw new Error(`Invalid block scalar header for ${name}`);
      if (!raw) return undefined;
      return { value: raw.replace(/^['"]|['"]$/g, ""), consumed: [index] };
    }
    const indicator = header[3] ?? header[4];
    const explicitIndent = indicator ? Number(indicator) : undefined;
    const consumed = [index];
    const content: string[] = [];
    let contentIndent = explicitIndent;
    if (contentIndent === undefined) {
      const first = lines.slice(index + 1).find((line) => line.trim() !== "");
      contentIndent = first?.match(/^ */)?.[0].length ?? 0;
    }
    let terminated = false;
    let contentStarted = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      const indent = line.match(/^ */)?.[0].length ?? 0;
      const blank = line.trim() === "";
      if (!blank && (contentIndent === 0 || indent < contentIndent)) break;
      if (blank && explicitIndent === undefined && !contentStarted && contentIndent > 0 && indent > contentIndent) {
        throw new Error(`Invalid leading indentation for ${name}`);
      }
      const value = blank && (contentIndent === 0 || indent <= contentIndent) ? "" : line.slice(contentIndent);
      content.push(value);
      if (value !== "") contentStarted = true;
      consumed.push(cursor);
      terminated = cursor < lines.length - 1 || finalBreak;
    }
    return {
      value: blockScalar(content, header[1] === ">", header[2] ?? header[5] ?? "", terminated),
      consumed,
    };
  }
  return undefined;
}

function blockScalar(lines: string[], folded: boolean, chomping: string, terminated: boolean): string {
  let lastContent = lines.length - 1;
  while (lastContent >= 0 && lines[lastContent] === "") lastContent -= 1;
  const moreIndented = (line: string) => /^[ \t]/.test(line);
  let text = "";
  for (const [index, line] of lines.entries()) {
    text += line;
    if (index === lines.length - 1 && !terminated) break;
    if (!folded || index >= lastContent || line === "") {
      text += "\n";
    } else {
      const next = lines[index + 1] ?? "";
      let nextContentIndex = index + 1;
      while (nextContentIndex < lastContent && lines[nextContentIndex] === "") nextContentIndex += 1;
      const nextContent = lines[nextContentIndex] ?? "";
      // Breaks around more-indented content are never folded.
      if (moreIndented(line) || moreIndented(nextContent)) text += "\n";
      else if (next !== "") text += " ";
    }
  }
  if (chomping === "+") return text;
  const stripped = text.replace(/\n+$/, "");
  return chomping === "-" || lastContent < 0 || !text.endsWith("\n") ? stripped : `${stripped}\n`;
}
