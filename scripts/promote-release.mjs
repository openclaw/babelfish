import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectTarball, PACKAGE_VERSION } from "./package-archive.mjs";
import { github, REPO, TAG } from "./release-common.mjs";

const directory = path.resolve(process.argv[2]);
const proof = JSON.parse(process.env.REGISTRY_PROOF);
assert.equal(process.env.GITHUB_REF_PROTECTED, "true");
assert.equal(proof.source, process.env.GITHUB_SHA);
assert.equal(proof.runId, process.env.GITHUB_RUN_ID);
assert.equal(proof.latest, PACKAGE_VERSION);
assert(proof.registrySignatures.length > 0 && proof.provenance.transparencyLogEntries > 0);
const archive = inspectTarball(await fs.readFile(path.join(directory, proof.filename)));
for (const key of ["sha256", "sha512", "integrity", "size"]) assert.equal(proof[key], archive[key]);
const ref = await github(`git/ref/tags/${TAG}`);
assert.equal(ref.object.sha, proof.tagObject);
const tag = await github(`git/tags/${proof.tagObject}`);
assert.equal(tag.object.sha, proof.source);
assert(tag.verification.verified && tag.verification.reason === "valid");
const notes = await fs.readFile(path.join(directory, "release-notes.md"), "utf8");
const body = `${notes}\n## Release proof\n\n- Signed protected tag: ${proof.tagObject}\n- Source: ${proof.source}\n- Workflow: https://github.com/${REPO}/actions/runs/${proof.runId}\n- Immutable artifact: ${proof.artifactId} (${proof.artifactDigest})\n- Tarball size: ${proof.size}\n- SHA256: ${proof.sha256}\n- SHA512: ${proof.sha512}\n- npm integrity: ${proof.integrity}\n- Registry signatures: ${proof.registrySignatures.join(", ")}\n- Verified provenance invocation: ${proof.provenance.invocation}\n- Fresh registry production consumer: passed CLI, runtime, MCP, strict declarations, and rollback\n`;
const releases = await github("releases?per_page=100");
let release = releases.find((entry) => entry.tag_name === TAG);
if (!release) {
  release = await github("releases", { method: "POST", body: JSON.stringify({ tag_name: TAG, target_commitish: proof.source, name: `Babelfish ${PACKAGE_VERSION}`, body, draft: true, prerelease: false }), headers: { "Content-Type": "application/json" } });
}
if (release.draft) {
  await github(`releases/${release.id}`, { method: "PATCH", body: JSON.stringify({ body, draft: false, prerelease: false, make_latest: "true" }), headers: { "Content-Type": "application/json" } });
}
const published = await github(`releases/tags/${TAG}`);
assert.equal(published.draft, false);
assert.equal(published.prerelease, false);
assert.equal(published.body, body, "release body readback");
console.log(published.html_url);
