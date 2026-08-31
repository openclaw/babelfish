# Manual MCP server

Babelfish includes a manual MCP compatibility server outside the default
OpenClaw plugin path:

```bash
babelfish mcp
```

Configure an MCP client to launch that command over stdio. This directory is
not a Codex plugin bundle; native Codex app support is planned separately.

`babelfish_task_start` runs each call in an isolated Hermes process. At most
eight tasks may run at once. Further starts fail until a task completes or
is stopped.
