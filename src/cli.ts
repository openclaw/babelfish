import { inspectBundlePlugin, summarizeBundlePlugin, validateBundlePluginDirectory } from "./bundle-plugins.js";
import { appInstallDir, requireApp, resolveConfig } from "./config.js";
import {
  installPlugin,
  resolveCloneTimeoutMs,
  uninstallPlugin,
  validateHermesPluginDirectory,
} from "./git-install.js";
import { listInstalledPlugins } from "./plugin-inventory.js";
import { regenerateNativeTools } from "./native-tools.js";

function parseInstallOptions(flags: string[]) {
  let name: string | undefined;
  let timeoutMs: number | undefined;
  let force = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--force") {
      force = true;
      continue;
    }
    if (flag !== "--name" && flag !== "--clone-timeout-ms") {
      throw new Error(`Unexpected install argument: ${flag}`);
    }
    const value = flags[i + 1]?.trim();
    i += 1;
    if (!value || value.startsWith("--")) {
      throw new Error(flag === "--name"
        ? "--name requires a plugin name"
        : "--clone-timeout-ms requires a positive integer millisecond value");
    }
    if (flag === "--name") {
      if (name !== undefined && name !== value) {
        throw new Error("Conflicting --name values");
      }
      name = value;
    } else {
      timeoutMs = resolveCloneTimeoutMs({ cliValue: value });
    }
  }
  return {
    name,
    force,
    timeoutMs: timeoutMs ?? resolveCloneTimeoutMs({ envValue: process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS }),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  babelfish mcp",
    "  babelfish list [app]",
    "  babelfish install <app> <source> [--name <name>] [--force] [--clone-timeout-ms <ms>]",
    "  babelfish uninstall <app> <name>",
  ].join("\n");
}

export async function runBabelfishCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  const config = resolveConfig();
  if (command === "mcp") {
    const { startHermesMcpServer } = await import("./mcp-server.js");
    await startHermesMcpServer(config);
    return;
  }

  if (command === "list") {
    const app = args[1] ? requireApp(args[1]) : undefined;
    console.log(JSON.stringify(await listInstalledPlugins(config, app), null, 2));
    return;
  }

  if (command !== "install" && command !== "uninstall") {
    throw new Error(usage());
  }
  const app = requireApp(args[1]);
  const target = args[2];
  if (!target || target.startsWith("--")) {
    throw new Error(usage());
  }
  let generated: Awaited<ReturnType<typeof regenerateNativeTools>> | undefined;
  const options = {
    installDir: appInstallDir(config, app),
    afterChange: async () => {
      generated = await regenerateNativeTools(config);
    },
  };
  if (command === "install") {
    const result = await installPlugin({
      ...options,
      source: target,
      ...parseInstallOptions(args.slice(3)),
      validate: app === "hermes"
        ? validateHermesPluginDirectory
        : (target) => validateBundlePluginDirectory(app, target),
    });
    const plugin = app === "hermes"
      ? undefined
      : summarizeBundlePlugin(await inspectBundlePlugin(app, result.path));
    console.log(JSON.stringify({ app, installed: result, plugin, ...generated }, null, 2));
    return;
  }

  const result = await uninstallPlugin({ ...options, name: target });
  console.log(JSON.stringify({ app, removed: result, ...generated }, null, 2));
}
