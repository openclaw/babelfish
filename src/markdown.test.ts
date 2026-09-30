import { readFrontmatterScalar, splitFrontmatter } from "./markdown.js";

describe("splitFrontmatter", () => {
  it("retains body bytes while normalizing frontmatter line endings", () => {
    expect(splitFrontmatter("---\r\nname: demo\r\ndescription: Demo\r\n---\r\nBody.\r\n"))
      .toEqual({ frontmatter: "name: demo\ndescription: Demo", body: "Body.\r\n" });
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
      value: "Keep replies short and specific.",
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
      value: "Commit the selected files\nafter reviewing the diff.",
      consumed: [0, 1, 2],
    });
  });
});
