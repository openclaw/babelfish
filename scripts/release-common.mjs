import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PACKAGE_NAME, PACKAGE_VERSION, REPOSITORY } from "./package-archive.mjs";

export const REPO = "openclaw/babelfish";
export const TAG = `v${PACKAGE_VERSION}`;
export const WORKFLOW = ".github/workflows/release.yml";
export const SIGNER = "SHA256:OIEOnMWCJeKhWpBNlB42wwPuUG5gsC8Crq1ibnt7ylQ";

export async function boundedFetch(url, options = {}, limit = 2 * 1024 * 1024) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000), redirect: "error" });
  assert(response.ok, `HTTP ${response.status} for ${new URL(url).origin}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= limit, "bounded HTTP response");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function github(endpoint, options = {}) {
  assert(process.env.GH_TOKEN, "scoped GitHub job token required");
  return JSON.parse((await boundedFetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...options.headers },
  })).toString("utf8"));
}

export async function pages(endpoint, field) {
  const entries = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await github(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    assert(Array.isArray(result[field]));
    entries.push(...result[field]);
    if (result[field].length < 100) return entries;
  }
  throw new Error("GitHub pagination exceeded bound");
}

export async function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => {
    assert(/^[a-z_]+$/.test(key) && !/[\r\n]/.test(String(value)), "safe workflow output");
    return `${key}=${value}\n`;
  });
  await fs.appendFile(process.env.GITHUB_OUTPUT, lines.join(""));
}

export function validateStatement(statement, proof, repository) {
  assert.equal(statement._type, "https://in-toto.io/Statement/v1");
  assert.equal(statement.predicateType, "https://slsa.dev/provenance/v1");
  assert.deepEqual(statement.subject, [{ name: `pkg:npm/${PACKAGE_NAME.replace("@", "%40")}@${PACKAGE_VERSION}`, digest: { sha512: proof.sha512 } }]);
  const build = statement.predicate.buildDefinition;
  assert.equal(build.buildType, "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1");
  assert.deepEqual(build.externalParameters.workflow, { repository: REPOSITORY, path: WORKFLOW, ref: `refs/tags/${TAG}` });
  assert.deepEqual(build.resolvedDependencies, [{ uri: `git+${REPOSITORY}@refs/tags/${TAG}`, digest: { gitCommit: proof.source } }]);
  assert.equal(build.internalParameters.github.event_name, "push");
  assert.equal(build.internalParameters.github.repository_id, String(repository.id));
  assert.equal(build.internalParameters.github.repository_owner_id, String(repository.owner.id));
  assert.equal(statement.predicate.runDetails.builder.id, "https://github.com/actions/runner/github-hosted");
  const invocation = statement.predicate.runDetails.metadata.invocationId;
  const match = /^https:\/\/github\.com\/openclaw\/babelfish\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(invocation);
  assert(match && match[1] === proof.runId, "exact publishing run");
  const attempt = Number(match[2]);
  assert(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= Number(process.env.GITHUB_RUN_ATTEMPT), "admitted publishing attempt");
  return attempt;
}

export function admitReleaseJobs(publishingJobs, validationJobs, proof) {
  const publisher = publishingJobs.find((job) => job.name === "Publish immutable npm package");
  assert(publisher?.head_sha === proof.source);
  const publishStep = publisher.steps.find((step) => step.name === "Publish or reconcile immutable bytes");
  assert(publishStep?.started_at && publishStep.conclusion !== "skipped", "publishing invocation admitted by attempt-specific job");
  assert(validationJobs.some((job) =>
    job.name === "Validate and retain package" && job.head_sha === proof.source && job.conclusion === "success" &&
    Date.parse(job.completed_at) <= Date.parse(publishStep.started_at) &&
    job.steps.some((step) => step.name === "Admit exact artifact identity and bytes" && step.conclusion === "success")),
  "successful retained-artifact admission before publication");
}
