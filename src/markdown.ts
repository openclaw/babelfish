export function splitFrontmatter(source: string): { frontmatter: string; body: string } | undefined {
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(source);
  if (!match) return undefined;
  return {
    frontmatter: (match[1] ?? "").replaceAll("\r\n", "\n"),
    body: source.slice(match[0].length),
  };
}
