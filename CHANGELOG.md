# Changelog

## 0.1.1 (Unreleased)

- Time out plugin Git clones after 120 seconds, terminate stalled transport processes, and preserve existing installs on failure; override with `--clone-timeout-ms` or `OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS`. Thanks @SebTardif.
- Accept in-root bundle directories whose names begin with two dots while retaining parent-traversal and symlink escape checks.
- Avoid leaving staging directories behind when a duplicate plugin install is rejected without `--force`.
- Preserve Markdown frontmatter in imported skills, commands, and output styles with Windows line endings or a closing delimiter at end of file.
- Refresh the MCP SDK, development dependencies, npm 11 tooling, and pinned CodeQL actions while retaining Node.js 22.19 support.
- Bound imported command-hook stdout and stderr so noisy hooks cannot exhaust
  OpenClaw memory before their timeout.
- Preserve literal arguments in exec-form command hooks while retaining Windows process-tree supervision. Thanks @SebTardif.
- Add a Docker constrained-memory matrix covering build, tests, packaging,
  three-app plugin lifecycle, generated tools, and MCP stdio down to 256 MiB.
- Prevent early command-hook exits from crashing the host with a broken stdin pipe, preserving successful output and blocking exit decisions.
- Reduce npm package size by omitting duplicate JavaScript modules and stale source maps while preserving bundled entrypoints, type declarations, and runtime assets.

## 0.1.0 — 2026-07-27

- First release: bring supported Claude Code, Codex, and Hermes Agent plugins into OpenClaw from their Git repositories.
- Generate native OpenClaw tools, skills, commands, hooks, middleware, monitors, MCP resources, and MCP prompts while reporting unsupported source behavior instead of hiding semantic gaps.
- Preserve source schemas and names where possible, qualify collisions deterministically, and regenerate stable plugin contracts after transactional install or uninstall operations.
- Map compatible lifecycle, prompt, compaction, subagent, tool, and finalization hooks while keeping approval, authentication, model, and execution trust boundaries explicit.
- Provide an optional stdio MCP compatibility server for Hermes tools and commands outside the native OpenClaw plugin path.
- Prefer exact installed Hermes plugin identities, reject ambiguous aliases, and generate MCP operations only for capabilities advertised by each server.
- Run hooks, monitors, and builds through portable POSIX and Windows process supervision with rollback-safe failure handling and bounded cleanup.
- Ship validated npm entrypoints and contents with current dependencies, security reporting, dependency automation, CodeQL, and cross-platform Node 22/24 CI.
