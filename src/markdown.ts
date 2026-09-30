export function splitFrontmatter(source: string): { frontmatter: string; body: string } | undefined {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(source);
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
  const lines = frontmatter.split("\n");
  const key = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = key.exec(lines[index] ?? "");
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    const header = /^([|>])([-+]?)([1-9]\d*)?([-+]?)$/.exec(raw);
    if (!header || (header[2] && header[4])) {
      if (!raw) return undefined;
      return { value: raw.replace(/^['"]|['"]$/g, ""), consumed: [index] };
    }
    const explicitIndent = header[3] ? Number(header[3]) : undefined;
    const consumed = [index];
    const content: string[] = [];
    let contentIndent = explicitIndent;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? "";
      if (line.trim() === "") {
        content.push("");
        consumed.push(cursor);
        continue;
      }
      const indent = line.match(/^ */)?.[0].length ?? 0;
      if (contentIndent === undefined) {
        if (indent === 0) break;
        contentIndent = indent;
      }
      if (indent < contentIndent) break;
      content.push(line.slice(contentIndent));
      consumed.push(cursor);
    }
    const folded = header[1] === ">";
    return { value: blockScalar(content, folded), consumed };
  }
  return undefined;
}

function blockScalar(lines: string[], folded: boolean): string {
  const text = folded ? foldScalar(lines) : lines.join("\n");
  return text.replace(/\n+$/, "");
}

function foldScalar(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    let text = current[0] ?? "";
    for (const line of current.slice(1)) {
      text += line.startsWith(" ") ? `\n${line}` : ` ${line}`;
    }
    paragraphs.push(text);
    current = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return paragraphs.join("\n");
}
