# Babelfish 🐟 — Plugins, translated

<p align="center">
  <img src="assets/babelfish-icon-v2.svg" alt="Babelfish mascot" width="220">
</p>

[![CI](https://img.shields.io/github/actions/workflow/status/openclaw/babelfish/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/openclaw/babelfish/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@openclaw/babelfish?style=flat-square)](https://www.npmjs.com/package/@openclaw/babelfish)
[![Node.js](https://img.shields.io/node/v/@openclaw/babelfish?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/github/license/openclaw/babelfish?style=flat-square)](LICENSE)

Babelfish imports plugins from Claude Code, Codex, and Hermes Agent into OpenClaw. It translates compatible tools, skills, commands, hooks, middleware, and MCP surfaces into native OpenClaw contracts, while reporting source behavior that has no safe equivalent.

## Install

Install the published OpenClaw plugin:

```bash
openclaw plugins install npm:@openclaw/babelfish
```

Restart OpenClaw after installation. Babelfish requires Node.js 22.19 or newer.

## Quick start

Import a plugin from its Git repository, then inspect what Babelfish found:

```bash
openclaw babelfish install codex https://github.com/Kotlin/kotlin-agent-skills.git
openclaw babelfish list codex
```

Restart OpenClaw again to load the generated contracts and skills. Supported app identifiers are `claude-code`, `codex`, and `hermes`.

## What gets imported

Babelfish preserves source names when they are unique and qualifies collisions with the plugin name. Install and uninstall operations regenerate the OpenClaw plugin manifest, tool registry, and imported skill directories.

Installing an already installed name requires `--force`; a rejected duplicate leaves the existing plugin intact and creates no staging directory.

| Source contribution | OpenClaw behavior |
| --- | --- |
| Agent and MCP tools | Native tools that retain the source JSON schema |
| Skills and support files | Native OpenClaw skills with referenced files intact; Markdown frontmatter supports LF and Windows CRLF line endings |
| Prompt and terminal commands | User-invoked skills or top-level CLI commands when the source format supports them |
| Compatible hooks | Matching lifecycle, prompt, tool, compaction, and subagent hooks. String commands use a login shell; `args` or a `command` array spawn without a shell. |
| Compatible middleware | Matching prompt-build and tool-result middleware |
| Unsupported behavior | Recorded during generation and reported at Gateway startup |

Support differs by source app and surface. See the [compatibility reference](docs/compatibility.md) for the full matrix, source-specific behavior, configuration, and example plugins.

Command-hook results, including blocking exit decisions, are retained when a hook exits without reading all stdin.

## Trust and lifecycle

Installing a plugin executes code from its repository while Babelfish inspects MCP tools and later runs imported hooks or tools. Review the source before installing it. String hook commands are full shell execution. Hooks that declare `args` or a `command` array spawn the listed executable directly.

Babelfish does not expose install or uninstall as agent tools. The read-only `babelfish_plugins_list` agent tool reports installed plugins and detected surfaces. Restart OpenClaw after installing, updating, or removing an imported plugin because OpenClaw loads plugin metadata and tool contracts at process startup.

## Commands

| Command | Purpose |
| --- | --- |
| `openclaw babelfish list [app]` | List installed plugins and detected surfaces |
| `openclaw babelfish install <app> <git-url> [--name <name>] [--force]` | Install a source plugin from Git |
| `openclaw babelfish uninstall <app> <name>` | Remove an imported plugin |
| `babelfish mcp` | Start the optional Hermes-only stdio MCP server |

The standalone MCP server is a compatibility fallback for MCP clients; native OpenClaw loading remains the recommended path. See [Manual MCP server](mcp/README.md) for setup and limitations.

## Development

Development requires Node.js 22.19 or newer, npm, Git, and `python3` for the Hermes bridge tests.

```bash
npm ci
npm run check
npm run pack:check
```

The test suite covers source-runtime tools, commands, skills, hook translation, bundle discovery, transactional install and uninstall, and the optional MCP server. `npm run test:low-memory` runs the full gate at 1 GiB, runtime and end-to-end flows at 512 MiB, and install/list/uninstall plus MCP stdio at 256 MiB.

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused test commands and pull request guidance, and report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Babelfish is available under the [MIT License](LICENSE).
