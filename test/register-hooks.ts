type Plugin = typeof import("../src/index.js").default;
type HookHandler = (event: unknown, ctx: unknown) => unknown;

export function registerTestHooks(
  entry: Plugin,
  hooks: Map<string, HookHandler>,
  warn: (message: string) => void = () => undefined,
) {
  entry.register({
    on: (name, handler) => { hooks.set(name, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerCli: () => undefined,
    registerAgentToolResultMiddleware: () => undefined,
    logger: { warn },
  });
}
