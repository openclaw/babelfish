import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTarball, PACKAGE_VERSION } from "./package-archive.mjs";
import { github, outputs, pages, REPO, SIGNER, TAG, WORKFLOW } from "./release-common.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const mode = process.argv[2];
assert.equal(process.env.GITHUB_REPOSITORY, REPO);
assert.equal(process.env.GITHUB_REF_PROTECTED, "true", "protected release tag required");
assert.equal(process.env.GITHUB_EVENT_NAME, "push");
assert.equal(process.env.GITHUB_REF, `refs/tags/${TAG}`);
assert.equal(process.env.GITHUB_WORKFLOW_REF, `${REPO}/${WORKFLOW}@refs/tags/${TAG}`);
const source = process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(source));

async function verifyTag() {
  assert.equal(git(["rev-parse", "HEAD"]), source);
  git(["-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--no-tags", "--no-prune", "--no-write-fetch-head", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  git(["merge-base", "--is-ancestor", source, "origin/main"]);
  assert.equal(git(["cat-file", "-t", TAG]), "tag", "annotated tag required");
  assert.equal(git(["rev-parse", `${TAG}^{commit}`]), source);
  git(["-c", `gpg.ssh.allowedSignersFile=${path.join(root, ".github", "release-signers")}`, "verify-tag", TAG]);
  const tagObject = git(["rev-parse", TAG]);
  const ref = await github(`git/ref/tags/${TAG}`);
  assert.equal(ref.object.type, "tag");
  assert.equal(ref.object.sha, tagObject);
  const tag = await github(`git/tags/${tagObject}`);
  assert.equal(tag.tag, TAG);
  assert.equal(tag.object.type, "commit");
  assert.equal(tag.object.sha, source);
  assert.equal(tag.verification.verified, true);
  assert.equal(tag.verification.reason, "valid");
  assert.match(tag.verification.signature, /BEGIN SSH SIGNATURE/);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, PACKAGE_VERSION);
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, PACKAGE_VERSION);
  assert.equal(lock.packages[""].version, PACKAGE_VERSION);
  return tagObject;
}

const tagObject = mode === "discover" ? await verifyTag() : git(["rev-parse", TAG]);
const artifactName = `npm-package-${process.env.GITHUB_RUN_ID}`;
if (mode === "discover") {
  const artifacts = (await pages(`actions/runs/${process.env.GITHUB_RUN_ID}/artifacts`, "artifacts")).filter((artifact) => artifact.name === artifactName);
  assert(artifacts.length <= 1, "single immutable package artifact");
  if (artifacts.length === 1) {
    const artifact = artifacts[0];
    assert(!artifact.expired && /^sha256:[a-f0-9]{64}$/.test(artifact.digest));
    await outputs({ reuse: "true", artifact_id: artifact.id, artifact_digest: artifact.digest });
  } else {
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1", "a retry cannot pack a replacement artifact");
    await outputs({ reuse: "false" });
  }
} else {
  const directory = path.resolve(process.argv[3]);
  const proofPath = path.join(directory, "package-proof.json");
  const proof = JSON.parse(await fs.readFile(proofPath, "utf8"));
  assert.equal(proof.filename, "openclaw-babelfish-0.1.1.tgz");
  const checked = inspectTarball(await fs.readFile(path.join(directory, proof.filename)));
  for (const key of ["size", "sha256", "sha512", "integrity"]) assert.equal(proof[key], checked[key]);
  if (mode === "seal") {
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1");
    Object.assign(proof, { source, tagObject, tag: TAG, version: PACKAGE_VERSION, runId: process.env.GITHUB_RUN_ID, buildAttempt: 1, signer: SIGNER });
    await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");
    const notes = changelog.split(`## ${PACKAGE_VERSION} — 2026-10-01\n`)[1]?.split(/\n## /)[0]?.trim();
    assert(notes, "dated contributor release notes required");
    await fs.writeFile(path.join(directory, "release-notes.md"), `${notes}\n`);
  } else {
    assert.equal(mode, "admit");
    assert.equal(proof.source, source);
    assert.equal(proof.tagObject, tagObject);
    assert.equal(proof.tag, TAG);
    assert.equal(proof.runId, process.env.GITHUB_RUN_ID);
    assert.equal(proof.buildAttempt, 1);
    assert.equal(proof.signer, SIGNER);
    const artifact = await github(`actions/artifacts/${process.env.ARTIFACT_ID}`);
    const digest = process.env.ARTIFACT_DIGEST.startsWith("sha256:") ? process.env.ARTIFACT_DIGEST : `sha256:${process.env.ARTIFACT_DIGEST}`;
    assert.equal(artifact.name, artifactName);
    assert.equal(artifact.digest, digest);
    assert.equal(String(artifact.workflow_run.id), proof.runId);
    assert.equal(artifact.workflow_run.head_sha, source);
    assert.equal(artifact.expired, false);
    await outputs({ artifact_id: artifact.id, artifact_digest: digest, source, tag_object: tagObject, size: proof.size, sha256: proof.sha256, sha512: proof.sha512, integrity: proof.integrity });
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\nImmutable release package: ${JSON.stringify({ ...proof, artifactId: artifact.id, artifactDigest: digest })}\n`);
  }
}
