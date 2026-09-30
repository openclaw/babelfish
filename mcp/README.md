# Manual MCP server

Babelfish includes a manual MCP compatibility server outside the default
OpenClaw plugin path:

```bash
babelfish mcp
```

Configure an MCP client to launch that command over stdio. This directory is
not a Codex plugin bundle; native Codex app support is planned separately.

`babelfish_task_start` runs each call in an isolated Hermes process. At most
eight isolated children may occupy slots at once. `babelfish_task_status` can
show completed or failed as soon as the helper returns; the slot stays
occupied until that child exits.
