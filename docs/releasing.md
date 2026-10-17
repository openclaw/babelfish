# Releasing Babelfish 0.1.2

The release workflow publishes only `v0.1.2`. Prepare later versions in a separate
reviewed change. Do not publish from a local checkout or use an npm token.

## Before tagging

1. Merge the release preparation PR after exact-head CI, low-memory, CodeQL,
   independent static review, and ClawSweeper review pass.
2. Verify live main and npm version absence. Keep the package and lock versions
   aligned. Keep contributor credits in the dated changelog.
3. Verify an active tag ruleset covering `v0.1.2` and the `stable-release`
   environment with a tag deployment policy. Do not add a required reviewer for
   an authorized self-release. Do not weaken either protection to unblock a run.
4. Dispatch `release.yml` on the release-preparation merge commit on `main` with
   `dry_run: true` and require that exact run to pass. This read-only validation
   builds, tests, and proves the package consumer without publishing, creating a
   tag, or accessing the publishing environment. Dispatch cannot publish.
5. Use the fleet release SSH signer (`SHA256:WmI9lVtd…`) to create and verify an annotated tag
   on qualified release main. The workflow also checks the pinned public key,
   GitHub tag verification, version, and main ancestry.
6. Push the tag normally. The publisher runs only on GitHub-hosted infrastructure
   with the `stable-release` environment and trusted npm OIDC publishing.

Keep an empty `Unreleased` section above the dated version and its one-line
`**Highlights:**`. Preserve every existing changelog bullet and contributor credit.
Update the package/lock, MCP identities, archive/consumer/provenance fixtures,
source-release date and signer pin, and exact-version publisher assertions together.
There are no native binaries, notarization, Homebrew, Go, or Sparkle channels.

## Package and privilege boundaries

`npm run check` builds and tests. `npm run pack:check` then packs once with lifecycle
scripts disabled, validates the actual bounded archive, and runs a fresh
production-only consumer in isolated HOME, cwd, npm configuration, and state.
Use `-- --out <directory>` to retain these exact bytes. Use `-- --tarball <path>`
to validate retained bytes without repacking. Build first when using this command
outside the full check. The public compatibility guide is included in the archive.

The builtin-only consumer driver resolves the runtime and MCP SDK from the fresh
installation. It proves CLI help and three-app install/list/uninstall, generated
contracts, MCP echo, registered plugin session/native tools, strict NodeNext
declarations with `skipLibCheck:false`, and rollback after a real late skill
regeneration failure. Compiler `7.0.2` and Node types `26.6.3` live in a separately
qualified tool installation, never in the production dependency tree. Docker
warms these inputs before running the low-memory matrix without network access.

Individual consumer commands retain a two-minute timeout. The full lifecycle
worker has six minutes, and its driver has twelve minutes for fresh installs,
the worker, optional signature auditing, and cleanup. These separate budgets
allow Windows cold starts without letting one stalled command run indefinitely.

The build uploads one immutable `npm-package-<run_id>` artifact. Workflow outputs
and the run summary retain its ID and container digest plus tar SHA256, SHA512,
integrity, size, source commit, signed tag object, and initial build attempt.
Retries paginate artifact metadata and reuse that artifact. Missing, expired,
ambiguous, or digest-mismatched artifacts fail closed; retries never repack.

The publisher has only `contents:read` and `id-token:write`. It does not check out
source, install dependencies, restore a cache, or run package lifecycle scripts.
It uses empty cwd, HOME, and npm config, validates the archive and package metadata,
and admits at most one publish invocation after an exact registry `E404`. Existing
or uncertain writes reconcile registry bytes and both hashes. A prior possible
publish with no registry bytes is a blocker, not permission to publish again.

A separate job without OIDC or write permissions verifies registry integrity and
signatures, `npm audit signatures --include-attestations`, pinned npm-bundled
Sigstore verification, exact certificate issuer/identity, subject and SHA512,
source/workflow/tag/repository/run/publishing-attempt identities, and a second
fresh registry consumer. Only then can the separate promotion job make the
GitHub release public. Its body is read back and includes immutable release proof.

## Failure recovery

Inspect the failed job and registry state before retrying. Rerun only failed jobs
when retained inputs and publication state permit it. Never repeat an uncertain
publish, delete/recreate the signed tag, or replace an artifact.

Before the first OIDC publication, inspect the npm trusted publisher for repository
`openclaw/babelfish`, workflow `release.yml`, and environment `stable-release` with
the approved npm service helper. An unused record expires after two days; renew
it with identical settings immediately before publication when needed. Do not
publish locally or replace OIDC with a registry token. A missing or differently
scoped publisher remains a blocker; do not broaden its permissions.
