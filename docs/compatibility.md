# Compatibility reference

Babelfish translates plugin behavior from Claude Code, Codex, and Hermes Agent into OpenClaw. This reference describes the supported surfaces, source-specific behavior, and semantic gaps.

## Support levels

**Full** means the source behavior has a direct native mapping. **Partial** means the useful behavior works with the listed semantic gaps. **No** means the surface is detected or documented but not executed. **N/A** means the source format does not provide that surface.

Bundle paths must stay inside the plugin root, including after resolving skill-root symlinks. Names beginning with two dots (for example, `..skills`) are ordinary directory names; parent-directory traversal (`..` or `../outside`) remains rejected.

| Plugin surface | Hermes Agent | Codex | Claude Code | OpenClaw mapping or limitation |
| --- | --- | --- | --- | --- |
| Manifest metadata | Full | Full | Full | Used for discovery, names, versions, and descriptions |
| Native source-runtime tools | Full | N/A | N/A | Generated as native OpenClaw tools with the source schema |
| MCP tools | N/A | Full | Full | Generated as native tools; stdio, HTTP, and SSE work without interactive auth. Inspection follows at most 50 `tools/list` pages within one request-timeout budget and rejects repeated cursors. |
| MCP resources and prompts | N/A | Partial | Partial | Exposed as generated list/read/get native tools rather than dedicated resource or prompt UI |
| Skills and support files | Full | Full | Full | Copied into native OpenClaw plugin skills |
| User prompt commands | Full | N/A | Partial | Hermes commands become native slash commands; Claude commands become user-only skills |
| Terminal CLI commands | Full | N/A | N/A | Registered as top-level `openclaw <command>` commands |
| Command-hook process output | N/A | 1 MiB per stream | 1 MiB per stream | Codex and Claude Code command hooks are terminated and reported as failed if stdout or stderr exceeds the limit |
| Command-hook process stdin | N/A | 1 MiB payload | 1 MiB payload | Oversized events do not start command hooks. Observer hooks are skipped; PreToolUse, UserPromptSubmit, and Stop return blocking decisions. |
| Hook-file discovery | N/A | 50 unique files, depth 8 | 50 unique files, depth 8 | One file budget is shared across declared paths; overlapping files count once. Excess files or directory depth fail discovery. |
| Command-hook invocation | N/A | String shell or exec `args` | String shell or exec `args` | String `command` runs via `/bin/sh -lc` (Windows uses `cmd.exe`). `/bin/sh` expands braced `${...}` names in that text. A single-quoted name is inserted, including inside `$(...)` and backticks. Windows copies that inserted value without a POSIX apostrophe escape, and rewrites remaining names to `%NAME%`. `args` or a `command` array spawn the executable without shell parsing. Both forms retain Windows Job supervision and process-tree cleanup. Plugin install is trusted code execution. |
| Plugin-defined agents | N/A | N/A | Partial | Imported as user-only skills; model and tool isolation are not preserved |
| Pre-tool command hooks | Full | Full | Full | Blocks and argument rewrites map to OpenClaw's pre-tool hook |
| Permission command hooks | N/A | No | No | OpenClaw has no equivalent approval-boundary event |
| Post-tool command hooks | Full | Full | Full | Claude Code failure hooks are also preserved |
| Session start hooks | Full | Full | Full | Additional context is injected into the next agent turn |
| Session end hooks | Full | Full | Full | Codex hooks must be declared by its supported manifest or conventional path |
| User-prompt hooks | Partial | Partial | Partial | Additional context maps; prompt replacement and hard stop do not |
| Stop/finalization hooks | Full | Full | Full | Hermes finalization is observer-only. Codex and Claude `decision: "block"` asks OpenClaw to revise. `continue: false` allows finalization and outranks a block on the same hook. |
| Pre/post compaction hooks | N/A | Full | Full | Observation hooks run around OpenClaw compaction |
| Subagent lifecycle hooks | Full | Full | Full | Mapped to OpenClaw subagent start/end hooks |
| Prompt or agent hook handlers | N/A | No | Partial | Claude prompt handlers use the active OpenClaw model; Codex prompt handlers and multi-turn agent handlers remain listed only |
| Notification hooks | N/A | N/A | No | Detected but not executed |
| Tool-result middleware | Full | N/A | N/A | Maps to OpenClaw tool-result middleware |
| LLM/request/execution middleware | Partial | N/A | N/A | Request rewrites of OpenClaw system/context fields map to prompt-build hooks; provider and execution wrappers are reported but not run |
| Codex app connectors | N/A | No | N/A | Connector IDs are not MCP servers and have no current equivalent |
| LSP servers | N/A | N/A | No | Detected but not started |
| Monitors | N/A | N/A | Partial | Always-on monitors run for the session and retain at most 50 lines and 1 MiB of queued context, dropping oldest lines first. A stdout line over 1 MiB stops that monitor. Consumed output does not count against future turns. `${CLAUDE_PROJECT_DIR}` is the session workspace and is expanded by the shell. Skill-triggered monitors are listed only |
| Output styles | N/A | N/A | Partial | Imported as user-only skills |
| Plugin settings/default agent | N/A | N/A | No | No native Babelfish mapping exists |
| Supporting scripts, binaries, and assets | Full | Full | Full | Retained when referenced by an imported skill, hook, or MCP server |
| Marketplace-native resolution | No | No | No | Install the plugin Git repository directly |

## Claude Code

For installed Claude Code and Codex Stop hooks, upgrading changes
`continue: false` from requesting revision to finishing the turn. Precedence is
per hook: a separate hook's block still requests revision in either order.
Exit-2 and oversized-input Stop decisions also still request revision.
Pre-tool and prompt hooks continue to treat `continue: false` as blocking.

Babelfish reads `.claude-plugin/plugin.json`, declared or conventional skill, command, agent, output-style, hook, and MCP paths. Existing `SKILL.md` directories are copied intact. Markdown commands, agents, and output styles are converted to user-invoked OpenClaw skills.

Generated descriptions read literal (`|`) and folded (`>`) YAML block scalars,
including header comments, single-digit indentation indicators, and `-`/`+`
chomping indicators in either order. Folding retains breaks around more-indented
content and repeated blank lines. Clip retains one final line break, strip
removes trailing breaks, and keep retains them, including before the Markdown
closing delimiter. LF and CRLF headers work without altering copied skill body
bytes or support files. This is a scalar reader, not general YAML parsing.

Command hooks run with `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` set to the installed plugin directory. In string commands, `/bin/sh` expands bare and double-quoted `${NAME}` references. Babelfish substitutes single-quoted and escaped references as literal values, including inside command substitutions and backticks, preserving installed guards such as `'${FLAG}'`. Quoted here-documents also receive substitutions; their delimiters are adjusted when needed to keep inserted lines inside the document. Case patterns, arithmetic expressions, and escaped whitespace retain their shell meaning. An unset referenced name still fails that hook before spawn. On Windows, remaining `${NAME}` references become `%NAME%`, and `cmd.exe` inserts the raw value; quotes do not protect that value on Windows. Windows single-quoted substitutions retain apostrophes without POSIX escaping. When `args` is set (Claude Code exec form), or when `command` is a string array, Babelfish substitutes each argument and spawns the executable directly without a shell. Single-turn `prompt` handlers use the active OpenClaw agent and model when `plugins.entries.babelfish.llm` allows both agent and model overrides. Without those trust flags they are reported but not executed. Multi-turn `agent` handlers are unsupported.

## Codex

Command expansion failures are isolated per hook. PreToolUse, UserPromptSubmit,
and Stop append a blocking decision when a variable cannot be expanded, including
when that is the only hook. Prior decisions, context, and argument rewrites are
retained and later hooks still run. Observer expansion failures warn and continue.
This policy applies to string and argv commands in both Codex and Claude Code;
it does not change unrelated command or prompt execution-error handling.

Babelfish reads `.codex-plugin/plugin.json`, declared or conventional skills, hooks, and MCP configuration. Manifest-inline hook declarations are supported. `${PLUGIN_ROOT}` is available to string hook commands through the shell, and it is substituted into MCP server arguments.

Codex app connector IDs are not MCP servers and have no equivalent Babelfish runtime surface.

## Hermes Agent

Turn preparation waits for the current session-start operation. A rejected start
is reported once and removed only after settling, so later turns can retain
their own context. Concurrent prepares also wait; completion of an older start
cannot remove a newer pending start or publish stale start context. Successful
start context is consumed once per session and cleared at session end.

The selected Python environment must import each installed plugin and its dependencies. Plugins that import client internals also require the source client's Python package.

Discovery, hooks, and middleware can return empty results without Python only
after checking that the install directory is absent or empty. This check is not
cached and does not trust a generated registry. Unreadable paths, dangling
symlinks, and nonempty or incomplete installations do not establish absence.
Unexpanded user-home paths stay on the Python path; missing paths with `.` or
`..` components are not normalized into an absence claim.
Explicit tool, command, CLI command, and skill requests still require Python.

Installed guard failures remain failures: startup, import, registration, protocol,
timeout, and `pre_tool_call` or `tool_request` callback errors prevent the host
tool call. Other callback failures retain their warning-and-continue behavior.

```bash
export OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR=/path/to/plugins
export OPENCLAW_BABELFISH_HERMES_PYTHON=/path/to/python3
export OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS=120000
```

Compatible lifecycle, tool, message, run, subagent, and middleware callbacks map to their matching OpenClaw hooks. Unmatched approval, kanban, execution, LLM request, and output-transform callbacks produce startup warnings.

## Example plugins

```bash
# Ars Contexta: knowledge-system skills and lifecycle hooks for Claude Code
openclaw babelfish install claude-code https://github.com/agenticnotetaking/arscontexta.git

# Kotlin Agent Skills: JetBrains-maintained Kotlin skills for Codex
openclaw babelfish install codex https://github.com/Kotlin/kotlin-agent-skills.git

# Hermes Web Search Plus: search and extraction tools for Hermes Agent
openclaw babelfish install hermes https://github.com/robbyczgw-cla/hermes-web-search-plus.git
```

`babelfish install` gives Git clones a 120-second deadline, including forced replacements. Unlike earlier releases, a healthy clone that takes longer must use `--clone-timeout-ms <ms>` or `OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS` to raise the deadline. Values must be positive integer milliseconds up to 2147483647; every flag occurrence is validated, the last flag wins, and flags take precedence over the environment. A timeout terminates the Git process tree, removes staging, and leaves any existing installation and generated files unchanged.

Restart OpenClaw after installing or removing a plugin. OpenClaw plugin metadata and tool contracts are process-stable, so Babelfish generates contracts for the next load.

## Optional MCP compatibility mode

Use this mode only when an MCP client needs direct access to installed Hermes plugins without loading Babelfish as a native OpenClaw plugin. It starts a stdio MCP server that exposes available Hermes tools and commands, a read-only installed-plugin listing, and helpers for starting, checking, or stopping long-running Hermes calls. `babelfish_task_start` rejects a new start when eight isolated children still occupy slots, including after status is completed, failed, or stopped but the process has not exited.

This mode covers Hermes plugins only. It does not provide Babelfish's native OpenClaw skills, hooks, middleware, or generated CLI commands.

Hermes MCP command tools accept an optional string `args` field. Omitting the
`arguments` object, passing `{}`, or passing `{ "args": "" }` sends an empty
string to the command handler. Explicit text is preserved. This matches the
default for command calls through `babelfish_task_start`.

Configure an MCP client to launch:

```bash
babelfish mcp
```

The process communicates over standard input/output until the MCP client disconnects. The shorter [MCP setup guide](../mcp/README.md) is suitable for client configuration.
