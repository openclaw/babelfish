# Changelog

## Unreleased

- Terminate a session monitor when its total stdout exceeds 1 MiB, including output already consumed by a turn. Keep complete lines that fit under the cap, including a final line with no newline and carriage-return breaks, and decode UTF-8 across reads. Thanks @SebTardif.

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
