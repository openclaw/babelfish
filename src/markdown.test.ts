import { readFrontmatterScalar, splitFrontmatter } from "./markdown.js";

it("preserves next-line scalar metadata without consuming a following key", () => {
  expect(readFrontmatterScalar("keep-coding-instructions:\n  true\nnext: kept\n", "keep-coding-instructions"))
    .toEqual({ value: "true", consumed: [0, 1] });
  expect(readFrontmatterScalar("description:\n\n  'next-line description'\nnext: kept\n", "description"))
    .toEqual({ value: "next-line description", consumed: [0, 1, 2] });
  expect(readFrontmatterScalar("description:\nnext: kept\n", "description")).toBeUndefined();
});

describe("splitFrontmatter", () => {
  it("retains body bytes while normalizing frontmatter line endings", () => {
    expect(splitFrontmatter("---\r\nname: demo\r\ndescription: Demo\r\n---\r\nBody.\r\n"))
      .toEqual({ frontmatter: "name: demo\ndescription: Demo\n", body: "Body.\r\n" });
  });

  it.each(["---\n---", "---\r\n---\r\n"])("accepts an empty header %j", (source) => {
    expect(splitFrontmatter(source)).toEqual({ frontmatter: "", body: "" });
  });

  it.each(["Body\n---\nname: demo\n---\n", "---\nname: demo\n---not a delimiter\n"])(
    "does not reinterpret body text or an unclosed header %j", (source) => {
      expect(splitFrontmatter(source)).toBeUndefined();
    },
  );
});

describe("readFrontmatterScalar", () => {
  it("keeps a one-line description", () => {
    expect(readFrontmatterScalar('description: "Keep replies short"', "description")).toEqual({
      value: "Keep replies short",
      consumed: [0],
    });
  });

  it("joins a folded description and leaves the next key", () => {
    const frontmatter = [
      "description: >",
      "  Keep replies short",
      "  and specific.",
      "keep-coding-instructions: true",
    ].join("\n");
    expect(readFrontmatterScalar(frontmatter, "description")).toEqual({
      value: "Keep replies short and specific.\n",
      consumed: [0, 1, 2],
    });
    expect(readFrontmatterScalar(frontmatter, "keep-coding-instructions")?.value).toBe("true");
  });

  it("keeps line breaks in a literal description", () => {
    const frontmatter = [
      "description: |",
      "  Commit the selected files",
      "  after reviewing the diff.",
      "argument-hint: '[files]'",
    ].join("\n");
    expect(readFrontmatterScalar(frontmatter, "description")).toEqual({
      value: "Commit the selected files\nafter reviewing the diff.\n",
      consumed: [0, 1, 2],
    });
  });

  // YAML 1.2.2 sections 8.1.1.1, 8.1.1.2 and 8.1.3.
  it.each([
    ["| # header", "  alpha\n  beta\n", "alpha\nbeta\n"],
    [">- # header", "  alpha\n  beta\n", "alpha beta"],
    ["|2+", "  alpha\n\n", "alpha\n\n"],
    ["|+2", "  alpha\n\n", "alpha\n\n"],
    [">", "  alpha\n    indented\n  omega\n", "alpha\n  indented\nomega\n"],
    [">", "  alpha\n\n\n  omega\n", "alpha\n\nomega\n"],
    [">", "  alpha\n\n    indented\n\n  omega\n", "alpha\n\n  indented\n\nomega\n"],
    ["|-", "  alpha\n\n", "alpha"],
    ["|", "  alpha\n\n", "alpha\n"],
    ["|+", "  alpha\n\n", "alpha\n\n"],
    [">-", "\n", ""],
    [">", "\n", ""],
    ["|+", "\n", "\n"],
    ["|", "  \n", ""],
    ["|+", "  \n", "\n"],
    ["|", "  alpha", "alpha"],
  ])("reads %s with content %j", (header, content, expected) => {
    expect(readFrontmatterScalar(`description: ${header}\n${content}`, "description")?.value).toBe(expected);
  });

  it.each(["|12", ">0", "|+-", ">2-3"])("rejects invalid block header %s", (header) => {
    expect(() => readFrontmatterScalar(`description: ${header}\n  text\n`, "description")).toThrow(/Invalid block scalar header/);
  });

  it.each(["\n", "\r\n"])("preserves the closing-delimiter break and body bytes with %j", (eol) => {
    for (const [indicator, expected] of [["|-", "alpha"], ["|", "alpha\n"], ["|+", "alpha\n\n"]]) {
      const body = `  Body.${eol}${eol}`;
      const source = ["---", `description: ${indicator} # comment`, "  alpha", "", "---", body].join(eol);
      const parsed = splitFrontmatter(source)!;
      expect(parsed.body).toBe(body);
      expect(readFrontmatterScalar(parsed.frontmatter, "description")?.value).toBe(expected);
    }
  });

  it("keeps following metadata outside a block", () => {
    const frontmatter = "description: >2- # comment\n  alpha\n  beta\nallowed-tools: Read\n";
    expect(readFrontmatterScalar(frontmatter, "description")).toEqual({
      value: "alpha beta", consumed: [0, 1, 2],
    });
    expect(readFrontmatterScalar(frontmatter, "allowed-tools")?.value).toBe("Read");
  });
});
