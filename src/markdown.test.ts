import { splitFrontmatter } from "./markdown.js";

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
