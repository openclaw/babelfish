type Hook = (event: unknown, ctx: unknown) => unknown;

export function hookTestApi(hooks: Map<string, Hook>, warn: (message: string) => void = () => {}) {
  return {
    on: (name: string, handler: Hook) => { hooks.set(name, handler); },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerCli: () => undefined,
    registerAgentToolResultMiddleware: () => undefined,
    logger: { warn },
  };
}
