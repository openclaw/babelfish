# Contributing to Babelfish

Babelfish translates plugin behavior across several agent ecosystems. Small
changes can affect command execution, generated manifests, or OpenClaw trust
boundaries, so contributions should include focused compatibility evidence.

## Before You Start

- Search existing issues before opening a new one.
- Use the compatibility request form for unsupported plugin surfaces.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development Setup

Prerequisites:

- Node.js 22.19 or newer.
- npm.
- Git.
- OpenSSH `ssh-keygen` for release-signature tests.
- Python 3 available as `python3` for Hermes bridge tests.

Install dependencies:

```bash
npm ci
```

Run the full local gate:

```bash
npm run check
npm run pack:check
```

Run one test file while iterating:

```bash
npx vitest run src/git-install.test.ts
```

Tests must use temporary directories and repository fixtures. Do not read from
or modify a developer's live OpenClaw state.

## Change Requirements

- Add or update tests for behavior changes.
- Preserve source plugin semantics where OpenClaw has a native equivalent.
- Document intentional semantic gaps in the README compatibility table.
- Update `CHANGELOG.md` for user-visible, security-relevant, or operational changes.
- Keep generated `dist/`, package archives, and `babelfish.generated.json` out of commits.
- Never add credentials, private repository URLs, personal paths, or unredacted logs.

## Pull Requests

Keep pull requests focused and explain:

- Which source apps and plugin surfaces are affected.
- Whether command execution, hooks, tools, MCP, or generated files change.
- Any trust-boundary impact.
- The tests and package checks you ran.

Use semantic titles such as `fix(runtime): handle failed monitor launches`.
Maintainers may ask for a smaller reproduction or a fixture that demonstrates
the upstream plugin behavior.
