<p align="center">
  <img src="assets/babelfish-icon-v2.svg" alt="Babelfish mascot" width="220">
</p>

# Babelfish

Babelfish brings plugins from Claude Code, Codex, and Hermes Agent into
OpenClaw. Install a plugin from its Git repository, restart OpenClaw, and its
supported tools, skills, commands, and hooks become available automatically.
If part of a plugin is not supported yet, Babelfish reports what it skipped
instead of failing silently.

## Install

```bash
openclaw plugins install npm:@openclaw/babelfish
```

The install command registers and enables Babelfish. Restart OpenClaw after
installing Babelfish or changing its imported plugins.

Install a plugin from Git:

```bash
openclaw babelfish install <app> <git-url>
```

Supported app identifiers are `claude-code`, `codex`, and `hermes`.

Examples:

```bash
# Ars Contexta: knowledge-system skills and lifecycle hooks for Claude Code
openclaw babelfish install claude-code https://github.com/agenticnotetaking/arscontexta.git

# Kotlin Agent Skills: JetBrains-maintained Kotlin skills for Codex
openclaw babelfish install codex https://github.com/Kotlin/kotlin-agent-skills.git

# Hermes Web Search Plus: multi-provider search and extraction tools for Hermes Agent
openclaw babelfish install hermes https://github.com/robbyczgw-cla/hermes-web-search-plus.git
```

Restart OpenClaw after installing or removing a plugin. OpenClaw plugin
metadata and tool contracts are process-stable, so Babelfish generates the
contracts for the next load.

Management commands:

```bash
openclaw babelfish list [app]
openclaw babelfish install <app> <git-url> [--name <name>] [--force]
openclaw babelfish uninstall <app> <name>
```

Installing a plugin executes code from that repository while inspecting MCP
tools and while running imported hooks or tools. Babelfish intentionally does
not expose install or uninstall as agent tools. The read-only
`babelfish_plugins_list` agent tool lists installed plugins and detected
surfaces.

## How surfaces map

| Source plugin contribution | OpenClaw behavior |
| --- | --- |
| Agent tools | Generated native OpenClaw tools with the source JSON schema |
| MCP tools | Generated native OpenClaw tools backed by the declared MCP server |
| Skills | Native OpenClaw skills, including their bundled support files |
| Prompt commands | User-invoked OpenClaw skills with model auto-invocation disabled |
| Terminal commands | Top-level `openclaw <command>` commands when the source format provides them |
| Compatible command hooks | Matching OpenClaw lifecycle, prompt, tool, compaction, and subagent hooks |
| Compatible middleware | Matching OpenClaw tool middleware |
| Unsupported contributions | Recorded during generation and logged at Gateway startup |

Names remain unchanged when unique. Collisions receive a plugin-qualified
name. Install and uninstall regenerate `openclaw.plugin.json`,
`babelfish.generated.json`, and the generated skill directories.

## Plugin support

**Full** means the source behavior has a direct native mapping. **Partial**
means the useful behavior works with listed semantic gaps. **No** means the
surface is detected or documented but not executed. **N/A** means the source
format does not provide that surface.

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
| Plugin settings/default agent | N/A | N/A | No | No native Babelfish mapping yet |
| Supporting scripts, binaries, and assets | Full | Full | Full | Retained when referenced by an imported skill, hook, or MCP server |
| Marketplace-native resolution | No | No | No | Install the plugin Git repository directly |

## App notes

### Claude Code

Babelfish reads `.claude-plugin/plugin.json`, declared or conventional skill,
command, agent, output-style, hook, and MCP paths. Existing `SKILL.md`
directories are copied intact. Markdown commands, agents, and output styles are
converted to user-invoked OpenClaw skills.

Command hooks run with `${CLAUDE_PLUGIN_ROOT}` set to the installed plugin
directory. `command` handlers are supported. Single-turn `prompt` handlers use
the active OpenClaw agent and model when `plugins.entries.babelfish.llm` allows
both agent and model overrides. Without those trust flags they are reported but
not executed. Multi-turn `agent` handlers are unsupported.

### Codex

Babelfish reads `.codex-plugin/plugin.json`, declared or conventional skills,
hooks, and MCP configuration. Manifest-inline hook declarations are supported.
`${PLUGIN_ROOT}` is expanded for hook and MCP commands.

Codex app connector IDs are not MCP servers and currently have no equivalent
Babelfish runtime surface.

### Hermes Agent

The selected Python environment must import each installed plugin and its
dependencies. Plugins that import client internals also require the source
client's Python package.

```bash
export OPENCLAW_BABELFISH_HERMES_PLUGIN_DIR=/path/to/plugins
export OPENCLAW_BABELFISH_HERMES_PYTHON=/path/to/python3
export OPENCLAW_BABELFISH_HERMES_TIMEOUT_MS=120000
```

Compatible lifecycle, tool, message, run, subagent, and middleware callbacks
map to their matching OpenClaw hooks. Unmatched approval, kanban, execution,
LLM request, and output-transform callbacks produce startup warnings.

External plugins need conversation access for message and run hooks:

```jsonc
{
  "plugins": {
    "entries": {
      "babelfish": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

## Optional MCP compatibility mode

Use this mode only when an MCP client needs direct access to installed Hermes
plugins without loading Babelfish as a native OpenClaw plugin. It starts a
stdio MCP server that exposes available Hermes tools and commands, a read-only
installed-plugin listing, and helpers for starting, checking, or stopping
long-running Hermes calls.

This is a compatibility fallback, not the recommended OpenClaw path. It covers
Hermes plugins only and does not provide Babelfish's native OpenClaw skills,
hooks, middleware, or generated CLI commands. For normal OpenClaw use, install
and enable Babelfish as described above instead.

Configure an MCP client to launch:

```bash
babelfish mcp
```

The process communicates over standard input/output and runs until the MCP
client disconnects.

## Verification

```bash
npm run check
```

The test suite covers source-runtime tools, commands, skills, hook translation,
bundle discovery, transactional install/uninstall, and the optional MCP server.

Run the Docker constrained-memory matrix:

```bash
npm run test:low-memory
```

It exercises the full gate at 1 GiB, runtime tests and end-to-end flows at
512 MiB, and install/list/uninstall plus MCP stdio at 256 MiB.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, compatibility
requirements, and pull request guidance. Report security vulnerabilities
privately according to [SECURITY.md](SECURITY.md).

## License

Babelfish is available under the [MIT License](LICENSE).
