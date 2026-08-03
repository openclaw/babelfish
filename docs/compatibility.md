# Compatibility reference

Babelfish translates plugin behavior from Claude Code, Codex, and Hermes Agent into OpenClaw. This reference describes the supported surfaces, source-specific behavior, and semantic gaps.

## Support levels

**Full** means the source behavior has a direct native mapping. **Partial** means the useful behavior works with the listed semantic gaps. **No** means the surface is detected or documented but not executed. **N/A** means the source format does not provide that surface.

| Plugin surface | Hermes Agent | Codex | Claude Code | OpenClaw mapping or limitation |
| --- | --- | --- | --- | --- |
| Manifest metadata | Full | Full | Full | Used for discovery, names, versions, and descriptions |
| Native source-runtime tools | Full | N/A | N/A | Generated as native OpenClaw tools with the source schema |
| MCP tools | N/A | Full | Full | Generated as native tools; stdio, HTTP, and SSE work without interactive auth |
| MCP resources and prompts | N/A | Partial | Partial | Exposed as generated list/read/get native tools rather than dedicated resource or prompt UI |
| Skills and support files | Full | Full | Full | Copied into native OpenClaw plugin skills |
| User prompt commands | Full | N/A | Partial | Hermes commands become native slash commands; Claude commands become user-only skills |
| Terminal CLI commands | Full | N/A | N/A | Registered as top-level `openclaw <command>` commands |
| Command-hook process output | N/A | 1 MiB per stream | 1 MiB per stream | Codex and Claude Code command hooks are terminated and reported as failed if stdout or stderr exceeds the limit |
| Plugin-defined agents | N/A | N/A | Partial | Imported as user-only skills; model and tool isolation are not preserved |
| Pre-tool command hooks | Full | Full | Full | Blocks and argument rewrites map to OpenClaw's pre-tool hook |
| Permission command hooks | N/A | No | No | OpenClaw has no equivalent approval-boundary event |
| Post-tool command hooks | Full | Full | Full | Claude Code failure hooks are also preserved |
| Session start hooks | Full | Full | Full | Additional context is injected into the next agent turn |
| Session end hooks | Full | Full | Full | Codex hooks must be declared by its supported manifest or conventional path |
| User-prompt hooks | Partial | Partial | Partial | Additional context maps; prompt replacement and hard stop do not |
| Stop/finalization hooks | Full | Full | Full | Hermes finalization is observer-only; Codex and Claude continue/block decisions map directly |
| Pre/post compaction hooks | N/A | Full | Full | Observation hooks run around OpenClaw compaction |
| Subagent lifecycle hooks | Full | Full | Full | Mapped to OpenClaw subagent start/end hooks |
| Prompt or agent hook handlers | N/A | No | Partial | Claude prompt handlers use the active OpenClaw model; Codex prompt handlers and multi-turn agent handlers remain listed only |
| Notification hooks | N/A | N/A | No | Detected but not executed |
| Tool-result middleware | Full | N/A | N/A | Maps to OpenClaw tool-result middleware |
| LLM/request/execution middleware | Partial | N/A | N/A | Request rewrites of OpenClaw system/context fields map to prompt-build hooks; provider and execution wrappers are reported but not run |
| Codex app connectors | N/A | No | N/A | Connector IDs are not MCP servers and have no current equivalent |
| LSP servers | N/A | N/A | No | Detected but not started |
| Monitors | N/A | N/A | Partial | Always-on monitors run for the session and queue bounded stdout context; skill-triggered monitors are listed only |
| Output styles | N/A | N/A | Partial | Imported as user-only skills |
| Plugin settings/default agent | N/A | N/A | No | No native Babelfish mapping exists |
| Supporting scripts, binaries, and assets | Full | Full | Full | Retained when referenced by an imported skill, hook, or MCP server |
| Marketplace-native resolution | No | No | No | Install the plugin Git repository directly |

## Claude Code

Babelfish reads `.claude-plugin/plugin.json`, declared or conventional skill, command, agent, output-style, hook, and MCP paths. Existing `SKILL.md` directories are copied intact. Markdown commands, agents, and output styles are converted to user-invoked OpenClaw skills.

Command hooks run with `${CLAUDE_PLUGIN_ROOT}` set to the installed plugin directory. `command` handlers are supported. Single-turn `prompt` handlers use the active OpenClaw agent and model when `plugins.entries.babelfish.llm` allows both agent and model overrides. Without those trust flags they are reported but not executed. Multi-turn `agent` handlers are unsupported.

## Codex

Babelfish reads `.codex-plugin/plugin.json`, declared or conventional skills, hooks, and MCP configuration. Manifest-inline hook declarations are supported. `${PLUGIN_ROOT}` is expanded for hook and MCP commands.

Codex app connector IDs are not MCP servers and have no equivalent Babelfish runtime surface.

## Hermes Agent

The selected Python environment must import each installed plugin and its dependencies. Plugins that import client internals also require the source client's Python package.

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

Restart OpenClaw after installing or removing a plugin. OpenClaw plugin metadata and tool contracts are process-stable, so Babelfish generates contracts for the next load.

## Optional MCP compatibility mode

Use this mode only when an MCP client needs direct access to installed Hermes plugins without loading Babelfish as a native OpenClaw plugin. It starts a stdio MCP server that exposes available Hermes tools and commands, a read-only installed-plugin listing, and helpers for starting, checking, or stopping long-running Hermes calls.

This mode covers Hermes plugins only. It does not provide Babelfish's native OpenClaw skills, hooks, middleware, or generated CLI commands.

Configure an MCP client to launch:

```bash
babelfish mcp
```

The process communicates over standard input/output until the MCP client disconnects. The shorter [MCP setup guide](../mcp/README.md) is suitable for client configuration.
