# Changelog

## Unreleased

- Check the package on Node.js 26 in Linux CI and honor the selected npm cache during offline consumer validation.

- Reuse Hermes plugin discovery when generating tools and skills during an install or uninstall.

- Use the default Hermes deadline when the configured value exceeds the maximum Node timer.

- Report tool installation, fresh package installation, lifecycle checks, and cleanup times in the package-consumer log.

- Load the MCP SDK when a client or server starts, reducing startup time for everyday CLI commands and plugin registration.

- Reuse the CI npm download cache for fresh package-consumer installs on Linux, macOS, and Windows.

- Update the Vitest test runner to 5.1.1.

- Refresh Vitest to 5.1.0 and CodeQL to 4.39.3, and patch transitive Hono vulnerabilities while retaining Node.js 22.19 support. Thanks @dependabot! #64 #65

- Run the platform test matrix without repeating fresh package installs when only source test files change.

- Skip platform and constrained-memory CI for changes limited to contributor guidance and issue or PR templates.

- Cancel the remaining platform jobs after a failure on a main push. Pull requests and manual CI runs report every platform.

- Refresh the MCP SDK and Node typings, and patch transitive body-parser, fast-uri, ip-address, qs, and Zod vulnerabilities while preserving Node.js 22.19 support. Thanks @dependabot! #59 #60

- Allow Vincent's Git signing key for release tags and record the actual verified tag signer while preserving immutable tag and package proof bindings.

- Use a single-CPU runner for ClawSweeper metadata dispatch.

- Keep full weekly CodeQL analysis without duplicate main-push scans, protect scheduled/manual runs, and analyze ready-for-review and checkout-attribute PR changes.

- Warm the low-memory image with a production install and run the full package-consumer proof once under the 1 GiB limit.

- Allow Python cold starts in the observer-result test on slower CI runners while retaining dedicated timeout coverage.
- Update the pinned CodeQL actions to 4.39.0 for repository security scanning. Thanks @dependabot.
- Register Babelfish management and imported CLI commands during OpenClaw metadata discovery so the host can invoke them before runtime activation.
- Run macOS CI on the Apple Silicon Xcode 27 image while retaining Node.js 22.19 support.

- Keep Hermes session state when a caller cancels a request that already failed JSON encoding.

- Pass Hermes tool-result hooks the serialized result and session identifier, honor empty replacements, and warn when a plugin requests the terminal-only output hook.

- Report Hermes command handler failures as MCP tool errors and reject unknown tool names with the JSON-RPC invalid-params code.

## 0.1.2 — 2026-10-17

**Highlights:** Preserve literal shell values and installed deny guards; security hardening bounds retained monitor output to prevent unbounded memory growth.

- Preserve literal variable values in string hooks and monitors while retaining installed deny guards across quoting, command substitutions, case patterns, arithmetic, comments, and here-documents. Thanks @SebTardif.
- Bound session monitor lines and queued context to 1 MiB while preserving long-running monitors across consumed turns, UTF-8 decoding, carriage-return breaks, and final lines without a newline. Thanks @SebTardif.
- Give the full package-consumer lifecycle suite its own timeout budget so Windows cold starts do not exhaust a single-command limit; retain bounded individual commands and release verification.
- Refresh Vitest to 5.0.5 and its development dependencies while retaining Node.js 22.19 support.
- Refresh the MCP SDK to 1.32.1 and Node typings to 26.6.5 while retaining Node.js 22.19 support.
- Refresh Vitest to 5.0.3, Node typings to 26.6.4, and their transitive development dependencies while retaining Node.js 22.19 support.

## 0.1.1 — 2026-10-01

- Align MCP runtime identities with 0.1.1 and ship the linked compatibility guide in the public package.
- Validate the actual release tarball in an isolated production consumer, including strict declarations and late-regeneration rollback; publish retained bytes through a signed, protected tag and trusted OIDC workflow with independent registry verification before release promotion.

- Allow discovery and hooks without Python only for a verified absent or empty Hermes install; preserve failed installed guards and propagate pre-tool callback failures. Thanks @SebTardif.
- Keep concurrent turns waiting for their current session start, consume its context once, and recover later turns after a failed start without deleting a newer pending start. Thanks @SebTardif.
- Read folded and literal YAML descriptions for generated commands, agents, and output styles, preserving header comments, indentation, blank lines, and clip/strip/keep chomping across LF and CRLF; retain copied skill bodies, metadata, assets, and regeneration rollback. Thanks @SebTardif.
- Isolate imported hook command expansion failures while retaining a blocking decision for PreToolUse, UserPromptSubmit, and Stop, preserving prior results and later hooks; observers warn and continue. Thanks @SebTardif.
- Let a Stop hook with `continue: false` finish the turn. `decision: "block"` still asks OpenClaw to revise, and `continue: false` outranks a block on the same hook. Thanks @SebTardif.
- Pass an empty string when an MCP command tool is called without `args`, matching `babelfish_task_start`. Thanks @SebTardif.
- Refresh the MCP SDK to 1.31.0, Vitest to 5.0.2, Node typings, transitive dependencies, and pinned CodeQL actions to 4.38.2 while retaining Node.js 22.19 support; clear two dependency audit advisories.
- Bound MCP tool inspection to 50 pages and one pagination deadline, rejecting repeated cursors while preserving finite listings. Thanks @SebTardif.
- Time out plugin Git clones after 120 seconds, terminate stalled transport processes, and preserve existing installs on failure; override with `--clone-timeout-ms` or `OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS`. Thanks @SebTardif.
- Cap background MCP tasks at eight isolated Hermes processes, holding slots until children exit while publishing task results promptly. Thanks @SebTardif.
- Accept in-root bundle directories whose names begin with two dots while retaining parent-traversal and symlink escape checks.
- Avoid leaving staging directories behind when a duplicate plugin install is rejected without `--force`.
- Preserve Markdown frontmatter in imported skills, commands, and output styles with Windows line endings or a closing delimiter at end of file.
- Refresh the MCP SDK to 1.30.1, development dependencies, npm 11 tooling, and pinned CodeQL actions while retaining Node.js 22.19 support.
- Bound imported command-hook stdout and stderr so noisy hooks cannot exhaust
  OpenClaw memory before their timeout.
- Preserve literal arguments in exec-form command hooks while retaining Windows process-tree supervision. Thanks @SebTardif.
- Add a Docker constrained-memory matrix covering build, tests, packaging,
  three-app plugin lifecycle, generated tools, and MCP stdio down to 256 MiB.
- Prevent early command-hook exits from crashing the host with a broken stdin pipe, preserving successful output and blocking exit decisions.
- Reduce npm package size by omitting duplicate JavaScript modules and stale source maps while preserving bundled entrypoints, type declarations, and runtime assets.
- Bound hook discovery to 50 unique files and eight nested directories, and reject command-hook stdin over 1 MiB; oversized decision events fail closed. Thanks @SebTardif.

## 0.1.0 — 2026-07-27

- First release: bring supported Claude Code, Codex, and Hermes Agent plugins into OpenClaw from their Git repositories.
- Generate native OpenClaw tools, skills, commands, hooks, middleware, monitors, MCP resources, and MCP prompts while reporting unsupported source behavior instead of hiding semantic gaps.
- Preserve source schemas and names where possible, qualify collisions deterministically, and regenerate stable plugin contracts after transactional install or uninstall operations.
- Map compatible lifecycle, prompt, compaction, subagent, tool, and finalization hooks while keeping approval, authentication, model, and execution trust boundaries explicit.
- Provide an optional stdio MCP compatibility server for Hermes tools and commands outside the native OpenClaw plugin path.
- Prefer exact installed Hermes plugin identities, reject ambiguous aliases, and generate MCP operations only for capabilities advertised by each server.
- Run hooks, monitors, and builds through portable POSIX and Windows process supervision with rollback-safe failure handling and bounded cleanup.
- Ship validated npm entrypoints and contents with current dependencies, security reporting, dependency automation, CodeQL, and cross-platform Node 22/24 CI.
