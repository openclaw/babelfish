import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectTarball } from "../scripts/package-archive.mjs";
import { admitReleaseJobs, githubUrl, outputs, TAG, validateDryRunContext, validateStatement, verifyReleaseTag } from "../scripts/release-common.mjs";

describe("validation-only release dispatch", () => {
  const context = {
    GITHUB_REPOSITORY: "openclaw/babelfish",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "openclaw/babelfish/.github/workflows/release.yml@refs/heads/main",
    DRY_RUN: "true",
  };
  it("accepts an explicit dry run on main", () => {
    expect(() => validateDryRunContext(context)).not.toThrow();
  });
  it.each([
    { GITHUB_REPOSITORY: "other/babelfish" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_REF: "refs/tags/v0.1.2" },
    { GITHUB_WORKFLOW_REF: "openclaw/babelfish/.github/workflows/other.yml@refs/heads/main" },
    { DRY_RUN: "false" },
    { DRY_RUN: undefined },
  ])("rejects an unauthorized dry-run context: %j", (override) => {
    expect(() => validateDryRunContext({ ...context, ...override })).toThrow();
  });
});

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

describe("verified release tag signer", () => {
  let root: string;
  let source: string;
  let fingerprints: string[];
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const signTag = (tag: string, key: number) => {
    git("-c", `user.signingkey=${path.join(root, `key-${key}`)}`, "tag", "-s", "-m", "release fixture", tag);
    return git("rev-parse", `refs/tags/${tag}`);
  };
  beforeEach(() => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", os.devNull);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "babelfish-release-signer-"));
    fs.mkdirSync(path.join(root, ".github"));
    git("init", "--quiet", "--template=");
    git("config", "user.name", "Release fixture");
    git("config", "user.email", "release@example.invalid");
    git("config", "gpg.format", "ssh");
    fingerprints = [0, 1, 2].map((index) => {
      const key = path.join(root, `key-${index}`);
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      return execFileSync("ssh-keygen", ["-lf", `${key}.pub`, "-E", "sha256"], { encoding: "utf8" }).split(" ")[1];
    });
    fs.writeFileSync(path.join(root, ".github", "release-signers"), [0, 1].map((index) =>
      `signer-${index} namespaces="git" ${fs.readFileSync(path.join(root, `key-${index}.pub`), "utf8")}`,
    ).join(""));
    git("-c", `user.signingkey=${path.join(root, "key-0")}`, "commit", "--quiet", "--allow-empty", "-S", "-m", "fixture");
    source = git("rev-parse", "HEAD");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records each allowed tag key, independently of the commit signer", () => {
    for (const key of [0, 1]) {
      const tag = `signed-${key}`;
      expect(verifyReleaseTag(root, tag, source, signTag(tag, key))).toBe(fingerprints[key]);
    }
    expect(git("-c", `gpg.ssh.allowedSignersFile=${path.join(root, ".github", "release-signers")}`, "log", "-1", "--format=%GF")).toBe(fingerprints[0]);
  });

  it.each(["unknown key", "wrong namespace", "unsigned", "lightweight", "tampered", "wrong source"])("rejects %s", (failure) => {
    let tagObject: string;
    if (failure === "unsigned" || failure === "lightweight") {
      git(...(failure === "unsigned" ? ["tag", "-a", "-m", "unsigned", TAG] : ["tag", TAG]));
      tagObject = git("rev-parse", TAG);
    } else {
      tagObject = signTag(TAG, failure === "unknown key" ? 2 : 1);
    }
    if (failure === "wrong namespace") {
      const allowed = path.join(root, ".github", "release-signers");
      fs.writeFileSync(allowed, fs.readFileSync(allowed, "utf8").replaceAll('namespaces="git"', 'namespaces="file"'));
    }
    if (failure === "tampered") {
      const contents = git("cat-file", "tag", tagObject).replace("release fixture", "tampered fixture");
      tagObject = execFileSync("git", ["hash-object", "-w", "-t", "tag", "--stdin"], { cwd: root, encoding: "utf8", input: `${contents}\n` }).trim();
      git("update-ref", `refs/tags/${TAG}`, tagObject);
    }
    expect(() => verifyReleaseTag(root, TAG, failure === "wrong source" ? "a".repeat(40) : source, tagObject)).toThrow();
  });

  it("rejects a replacement tag signed by another allowed key for the same commit", () => {
    const discovered = signTag(TAG, 0);
    expect(verifyReleaseTag(root, TAG, source, discovered)).toBe(fingerprints[0]);
    git("tag", "-d", TAG);
    const replacement = signTag(TAG, 1);
    expect(verifyReleaseTag(root, TAG, source, replacement)).toBe(fingerprints[1]);
    expect(() => verifyReleaseTag(root, TAG, source, discovered)).toThrow("release tag object changed");
  });

  it("seals and admits the actual signer while rejecting altered frozen proof", () => {
    const tagObject = signTag(TAG, 1);
    git("branch", "-M", "main");
    git("remote", "add", "origin", root);
    fs.mkdirSync(path.join(root, "scripts"));
    for (const file of ["release-source.mjs", "release-common.mjs", "package-archive.mjs"]) {
      fs.copyFileSync(new URL(`../scripts/${file}`, import.meta.url), path.join(root, "scripts", file));
    }
    fs.copyFileSync(new URL("../CHANGELOG.md", import.meta.url), path.join(root, "CHANGELOG.md"));
    for (const file of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(new URL(`../${file}`, import.meta.url), path.join(root, file));
    }
    const archive = tarball();
    const { size, sha256, sha512, integrity } = inspectTarball(archive);
    const directory = path.join(root, "artifact");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "openclaw-babelfish-0.1.2.tgz"), archive);
    const proofPath = path.join(directory, "package-proof.json");
    fs.writeFileSync(proofPath, JSON.stringify({ filename: "openclaw-babelfish-0.1.2.tgz", size, sha256, sha512, integrity }));
    const artifact = { id: 123, name: "npm-package-456", digest: `sha256:${"a".repeat(64)}`, workflow_run: { id: 456, head_sha: source }, expired: false };
    const apiResponses = {
      [`git/ref/tags/${TAG}`]: { object: { type: "tag", sha: tagObject } },
      [`git/tags/${tagObject}`]: { tag: TAG, object: { type: "commit", sha: source }, verification: { verified: true, reason: "valid", signature: "-----BEGIN SSH SIGNATURE-----" } },
      "actions/artifacts/123": artifact,
    };
    const mockApi = `const responses = ${JSON.stringify(apiResponses)};
      globalThis.fetch = async (url) => {
        const endpoint = url.replace("https://api.github.com/repos/openclaw/babelfish/", "");
        if (endpoint === "actions/runs/456/artifacts?per_page=100&page=1") return Response.json({ artifacts: process.env.FIXTURE_REUSE === "true" ? [responses["actions/artifacts/123"]] : [] });
        if (!Object.hasOwn(responses, endpoint)) throw Error("unexpected API request");
        return Response.json(responses[endpoint]);
      };`;
    const env = {
      ...process.env, GITHUB_REPOSITORY: "openclaw/babelfish", GITHUB_SHA: source,
      GITHUB_REF_PROTECTED: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: `refs/tags/${TAG}`,
      GITHUB_WORKFLOW_REF: `openclaw/babelfish/.github/workflows/release.yml@refs/tags/${TAG}`,
      GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", TAG_OBJECT: "", FIXTURE_REUSE: "false",
      GITHUB_OUTPUT: path.join(root, "outputs"), GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      GH_TOKEN: "fixture-token", ARTIFACT_ID: "123", ARTIFACT_DIGEST: artifact.digest,
    };
    const run = (mode: string) => spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(mockApi)}`, "scripts/release-source.mjs", mode, directory], { cwd: root, encoding: "utf8", env });
    const discover = run("discover");
    assert.equal(discover.status, 0, discover.stderr);
    expect(fs.readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(`reuse=false\ntag_object=${tagObject}\n`);
    env.TAG_OBJECT = fs.readFileSync(env.GITHUB_OUTPUT, "utf8").match(/^tag_object=(.+)$/m)![1];
    const sealed = run("seal");
    assert.equal(sealed.status, 0, sealed.stderr);
    const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
    expect(proof.signer).toBe(fingerprints[1]);
    expect(proof.tagObject).toBe(tagObject);
    const admitted = run("admit");
    assert.equal(admitted.status, 0, admitted.stderr);
    expect(fs.readFileSync(path.join(root, "summary"), "utf8")).toContain(fingerprints[1]);
    env.GITHUB_RUN_ATTEMPT = "2";
    env.FIXTURE_REUSE = "true";
    fs.writeFileSync(env.GITHUB_OUTPUT, "");
    const rediscovered = run("discover");
    assert.equal(rediscovered.status, 0, rediscovered.stderr);
    expect(fs.readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe(`reuse=true\ntag_object=${tagObject}\nartifact_id=123\nartifact_digest=${artifact.digest}\n`);
    const readmitted = run("admit");
    assert.equal(readmitted.status, 0, readmitted.stderr);
    for (const alteration of [{ signer: fingerprints[0] }, { tagObject: "a".repeat(40) }, { sha256: "a".repeat(64) }]) {
      fs.writeFileSync(proofPath, JSON.stringify({ ...proof, ...alteration }));
      expect(run("admit").status).not.toBe(0);
    }
    fs.writeFileSync(proofPath, JSON.stringify(proof));
    git("tag", "-d", TAG);
    signTag(TAG, 0);
    for (const mode of ["seal", "admit"]) {
      const replaced = run(mode);
      expect(replaced.status).not.toBe(0);
      expect(replaced.stderr).toContain("release tag object changed");
    }
  });
});

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
    subject: [{ name: "pkg:npm/%40openclaw/babelfish@0.1.2", digest: { sha512: proof.sha512 } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: "https://github.com/openclaw/babelfish", path: ".github/workflows/release.yml", ref: "refs/tags/v0.1.2" } },
        internalParameters: { github: { event_name: "push", repository_id: String(repository.id), repository_owner_id: String(repository.owner.id) } },
        resolvedDependencies: [{ uri: "git+https://github.com/openclaw/babelfish@refs/tags/v0.1.2", digest: { gitCommit: proof.source } }],
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

describe("failed-job publication retry admission", () => {
  const proof = { source: "a".repeat(40) };
  const publisher = { name: "Publish immutable npm package", head_sha: proof.source, steps: [{ name: "Publish or reconcile immutable bytes", started_at: "2026-10-01T10:10:00Z", conclusion: "success" }] };
  const builder = { name: "Validate and retain package", head_sha: proof.source, conclusion: "success", completed_at: "2026-10-01T10:00:00Z", steps: [{ name: "Admit exact artifact identity and bytes", conclusion: "success" }] };
  it("accepts an earlier successful build when only failed publisher jobs rerun", () => {
    expect(() => admitReleaseJobs([publisher], [builder], proof)).not.toThrow();
  });
  it.each([
    { ...builder, conclusion: "failure" },
    { ...builder, head_sha: "b".repeat(40) },
    { ...builder, completed_at: "2026-10-01T10:20:00Z" },
    { ...builder, steps: [{ name: "Admit exact artifact identity and bytes", conclusion: "failure" }] },
  ])("rejects missing, late, or mismatched artifact admission", (validation) => {
    expect(() => admitReleaseJobs([publisher], [validation], proof)).toThrow();
  });
  it("rejects an unattempted or different-head publisher", () => {
    expect(() => admitReleaseJobs([{ ...publisher, head_sha: "b".repeat(40) }], [builder], proof)).toThrow();
    expect(() => admitReleaseJobs([{ ...publisher, steps: [{ ...publisher.steps[0], conclusion: "skipped" }] }], [builder], proof)).toThrow();
  });
});

describe("release admission helper boundaries", () => {
  it("uses the canonical repository URL for an empty endpoint", () => {
    expect(githubUrl("")).toBe("https://api.github.com/repos/openclaw/babelfish");
    expect(githubUrl("git/ref/tags/v0.1.2")).toBe("https://api.github.com/repos/openclaw/babelfish/git/ref/tags/v0.1.2");
  });
  it("serializes the complete artifact admission output set without allowing line injection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "babelfish-release-output-"));
    const target = path.join(root, "output");
    vi.stubEnv("GITHUB_OUTPUT", target);
    try {
      const admission = { artifact_id: 123, artifact_digest: `sha256:${"a".repeat(64)}`, source: "b".repeat(40), tag_object: "c".repeat(40), size: 72073, sha256: "d".repeat(64), sha512: "e".repeat(128), integrity: "sha512-fixture" };
      await outputs(admission);
      expect(fs.readFileSync(target, "utf8")).toBe(Object.entries(admission).map(([key, value]) => `${key}=${value}\n`).join(""));
      for (const invalid of [{ "1bad": "value" }, { "bad-key": "value" }, { "bad\nkey": "value" }, { safe: "value\nunsafe=true" }, { safe: "value\runsafe=true" }]) {
        await expect(outputs(invalid)).rejects.toThrow("safe workflow output");
      }
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
