import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import { inspectTarball } from "../scripts/package-archive.mjs";
import { validateStatement } from "../scripts/release-common.mjs";

function tarball(overrides: Record<string, unknown> = {}, extra?: { name: string; type: string }) {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const entries = new Map([
    ["package.json", JSON.stringify({ ...pkg, ...overrides })],
    ...["LICENSE", "README.md", "CHANGELOG.md", "docs/compatibility.md", "dist/index.js", "dist/index.d.ts", "dist/bin.js", "openclaw.plugin.json", "python/hermes_openclaw_bridge.py"].map((name) => [name, "fixture"]),
  ]);
  const chunks: Buffer[] = [];
  function entry(name: string, contents: string, type = "0") {
    const data = Buffer.from(contents);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write("ustar\0", 257);
    header.write(`${[...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0")}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  for (const [name, contents] of entries) entry(`package/${name}`, contents);
  if (extra) entry(extra.name, "", extra.type);
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

describe("immutable release archive", () => {
  it("validates the public package metadata and computes both hashes", () => {
    const result = inspectTarball(tarball());
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sha512).toMatch(/^[a-f0-9]{128}$/);
    expect(result.integrity).toMatch(/^sha512-/);
    expect(result.files.has("docs/compatibility.md")).toBe(true);
  });
  it.each([
    ["package/../escape", "0"], ["/absolute", "0"], ["package/link", "2"],
    ["package/hardlink", "1"], ["package/pax", "x"], ["package/package.json", "0"],
    ["package/node_modules/dependency.js", "0"], ["package/dist/duplicate.js", "0"],
  ])("rejects unsafe or unexpected archive member %s", (name, type) => {
    expect(() => inspectTarball(tarball({}, { name, type }))).toThrow();
  });
  it.each([{ version: "0.1.0" }, { name: "other-package" }, { repository: { url: "https://example.invalid" } }, { publishConfig: { access: "public", registry: "https://example.invalid" } }])("rejects conflicting package metadata", (override) => {
    expect(() => inspectTarball(tarball(override))).toThrow();
  });
  it("rejects truncated and over-expanding archives", () => {
    expect(() => inspectTarball(tarball().subarray(0, 100))).toThrow();
    expect(() => inspectTarball(gzipSync(Buffer.alloc(17 * 1024 * 1024)))).toThrow();
  });
});

describe("release provenance identity", () => {
  const proof = { source: "a".repeat(40), sha512: "b".repeat(128), runId: "123" };
  const repository = { id: 1285835794, owner: { id: 252820863 } };
  const statement = () => ({
    _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/%40openclaw/babelfish@0.1.1", digest: { sha512: proof.sha512 } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: "https://github.com/openclaw/babelfish", path: ".github/workflows/release.yml", ref: "refs/tags/v0.1.1" } },
        internalParameters: { github: { event_name: "push", repository_id: String(repository.id), repository_owner_id: String(repository.owner.id) } },
        resolvedDependencies: [{ uri: "git+https://github.com/openclaw/babelfish@refs/tags/v0.1.1", digest: { gitCommit: proof.source } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" }, metadata: { invocationId: "https://github.com/openclaw/babelfish/actions/runs/123/attempts/1" } },
    },
  });
  beforeEach(() => vi.stubEnv("GITHUB_RUN_ATTEMPT", "2"));
  afterEach(() => vi.unstubAllEnvs());
  it("admits retained-byte provenance from the actual earlier publishing attempt", () => {
    assert.equal(validateStatement(statement(), proof, repository), 1);
  });
  it.each(["subject", "source", "workflow", "repository", "builder", "run", "attempt", "event"])("rejects mismatched %s", (field) => {
    const value = statement();
    if (field === "subject") value.subject[0].digest.sha512 = "c".repeat(128);
    if (field === "source") value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
    if (field === "workflow") value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml";
    if (field === "repository") value.predicate.buildDefinition.internalParameters.github.repository_id = "1";
    if (field === "builder") value.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted";
    if (field === "run") value.predicate.runDetails.metadata.invocationId = "https://github.com/openclaw/babelfish/actions/runs/124/attempts/1";
    if (field === "attempt") value.predicate.runDetails.metadata.invocationId = "https://github.com/openclaw/babelfish/actions/runs/123/attempts/3";
    if (field === "event") value.predicate.buildDefinition.internalParameters.github.event_name = "workflow_dispatch";
    expect(() => validateStatement(value, proof, repository)).toThrow();
  });
});
