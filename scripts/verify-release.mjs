import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTarball, PACKAGE_NAME, PACKAGE_VERSION, REPOSITORY } from "./package-archive.mjs";
import { admitReleaseJobs, boundedFetch, github, outputs, pages, REPO, TAG, validateStatement, WORKFLOW } from "./release-common.mjs";

assert.equal(process.version, "v26.10.0");
assert.equal(execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), "11.19.1");
assert.equal(process.env.GITHUB_REF_PROTECTED, "true");
const directory = path.resolve(process.argv[2]);
const proof = JSON.parse(await fs.readFile(path.join(directory, "package-proof.json"), "utf8"));
const original = await fs.readFile(path.join(directory, proof.filename));
const checked = inspectTarball(original);
for (const key of ["sha256", "sha512", "integrity", "size"]) assert.equal(proof[key], checked[key]);
assert.equal(proof.source, process.env.GITHUB_SHA);
assert.equal(proof.runId, process.env.GITHUB_RUN_ID);
const artifact = await github(`actions/artifacts/${process.env.ARTIFACT_ID}`);
assert.equal(artifact.digest, process.env.ARTIFACT_DIGEST);
assert.equal(artifact.name, `npm-package-${proof.runId}`);
assert.equal(artifact.workflow_run.head_sha, proof.source);
assert.equal(String(artifact.workflow_run.id), proof.runId);
assert.equal(artifact.expired, false);
const repository = await github("");
assert.equal(repository.full_name, REPO);
const ref = await github(`git/ref/tags/${TAG}`);
assert.equal(ref.object.sha, proof.tagObject);
const tag = await github(`git/tags/${proof.tagObject}`);
assert.equal(tag.object.sha, proof.source);
assert(tag.verification.verified && tag.verification.reason === "valid");
const run = await github(`actions/runs/${proof.runId}`);
assert.equal(run.head_sha, proof.source);
assert.equal(run.event, "push");
assert.equal(run.path, WORKFLOW);
const metadata = JSON.parse((await boundedFetch(`https://registry.npmjs.org/@openclaw%2fbabelfish/${PACKAGE_VERSION}`)).toString("utf8"));
assert.equal(metadata.name, PACKAGE_NAME);
assert.equal(metadata.version, PACKAGE_VERSION);
assert.equal(metadata.dist.integrity, proof.integrity);
assert.equal(metadata.dist.tarball, `https://registry.npmjs.org/@openclaw/babelfish/-/babelfish-${PACKAGE_VERSION}.tgz`);
const published = await boundedFetch(metadata.dist.tarball, {}, 8 * 1024 * 1024);
assert.deepEqual(published, original, "registry tarball equals tested immutable bytes");
assert.equal(createHash("sha1").update(published).digest("hex"), metadata.dist.shasum);
const keys = JSON.parse((await boundedFetch("https://registry.npmjs.org/-/npm/v1/keys")).toString("utf8"));
assert(metadata.dist.signatures?.length > 0, "registry signature required");
const signatureKeys = [];
for (const signature of metadata.dist.signatures) {
  const key = keys.keys.find((candidate) => candidate.keyid === signature.keyid);
  assert(key && (!key.expires || Date.parse(key.expires) > Date.now()), "current registry signing key");
  assert(verify("sha256", Buffer.from(`${PACKAGE_NAME}@${PACKAGE_VERSION}:${proof.integrity}`), createPublicKey({ key: Buffer.from(key.key, "base64"), format: "der", type: "spki" }), Buffer.from(signature.sig, "base64")), "registry signature cryptographically verified");
  signatureKeys.push(signature.keyid);
}
const driver = fileURLToPath(new URL("./consumer-proof.mjs", import.meta.url));
const audit = JSON.parse(execFileSync(process.execPath, [driver, `${PACKAGE_NAME}@${PACKAGE_VERSION}`], {
  env: { ...process.env, BABELFISH_AUDIT_SIGNATURES: "1" }, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
}));
assert.equal(audit.invalid?.length, 0);
assert.equal(audit.missing?.length, 0);
const entry = audit.verified.find((candidate) => candidate.name === PACKAGE_NAME && candidate.version === PACKAGE_VERSION);
assert(entry && entry.registry === "https://registry.npmjs.org/", "explicit package audit evidence");
const bundles = entry.attestationBundles.filter((candidate) => candidate.predicateType === "https://slsa.dev/provenance/v1");
assert.equal(bundles.length, 1, "one npm provenance bundle");
const bundle = bundles[0].bundle;
assert.equal(bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
const npmPath = await fs.realpath(execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
const npmRequire = createRequire(npmPath);
assert.equal(npmRequire("sigstore/package.json").version, "4.1.1");
await npmRequire("sigstore").verify(bundle, {
  certificateIssuer: "https://token.actions.githubusercontent.com",
  certificateIdentityURI: `${REPOSITORY}/${WORKFLOW}@refs/tags/${TAG}`,
});
const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
const publishingAttempt = validateStatement(statement, proof, repository);
const jobs = await pages(`actions/runs/${proof.runId}/attempts/${publishingAttempt}/jobs`, "jobs");
assert.equal(proof.buildAttempt, 1);
const validationJobs = [...jobs];
for (let attempt = 1; attempt < publishingAttempt; attempt += 1) {
  validationJobs.push(...await pages(`actions/runs/${proof.runId}/attempts/${attempt}/jobs`, "jobs"));
}
admitReleaseJobs(jobs, validationJobs, proof);
const distTags = JSON.parse((await boundedFetch("https://registry.npmjs.org/-/package/@openclaw%2fbabelfish/dist-tags")).toString("utf8"));
assert.equal(distTags.latest, PACKAGE_VERSION);
const result = {
  ...proof, artifactId: artifact.id, artifactDigest: artifact.digest,
  registrySignatures: signatureKeys, registryShasum: metadata.dist.shasum,
  provenance: { subject: statement.subject, workflow: statement.predicate.buildDefinition.externalParameters.workflow, builder: statement.predicate.runDetails.builder.id, invocation: statement.predicate.runDetails.metadata.invocationId, publishingAttempt, issuer: "https://token.actions.githubusercontent.com", identity: `${REPOSITORY}/${WORKFLOW}@refs/tags/${TAG}`, transparencyLogEntries: bundle.verificationMaterial.tlogEntries.length },
  consumer: "fresh registry production CLI/runtime/MCP/declarations/rollback passed", latest: distTags.latest,
};
await outputs({ proof: JSON.stringify(result) });
await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `\nVerified public npm release: ${JSON.stringify(result)}\n`);
console.log(JSON.stringify(result));
