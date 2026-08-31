import { inspectBundlePlugin, listBundlePlugins, summarizeBundlePlugin, validateBundlePluginDirectory } from "./bundle-plugins.js";
import { appInstallDir, resolveConfig, SUPPORTED_APPS, type SupportedApp } from "./config.js";
import {
  installPlugin,
  resolveCloneTimeoutMs,
  uninstallPlugin,
  validateHermesPluginDirectory,
} from "./git-install.js";
import { listHermesPlugins } from "./hermes-python.js";
import { regenerateNativeTools } from "./native-tools.js";

function readOptionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readRequiredOptionValue(args: string[], name: string): string | undefined {
  let last: string | undefined;
  let seen = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== name) {
      continue;
    }
    seen = true;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a positive integer millisecond value`);
    }
    last = value;
  }
  return seen ? last : undefined;
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

function requireApp(value: string | undefined): SupportedApp {
  if (SUPPORTED_APPS.includes(value as SupportedApp)) {
    return value as SupportedApp;
  }
  throw new Error(`Unsupported app: ${value || "(missing)"}`);
}

export async function runBabelfishCli(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  const config = resolveConfig(undefined);
  if (command === "mcp") {
    const { startHermesMcpServer } = await import("./mcp-server.js");
    await startHermesMcpServer(config);
    return;
  }

  if (command === "list") {
    const app = args[1];
    if (app) {
      const supported = requireApp(app);
      console.log(JSON.stringify(
        supported === "hermes"
          ? { app: supported, ...(await listHermesPlugins(config)) }
          : { app: supported, plugins: (await listBundlePlugins(config, supported)).map(summarizeBundlePlugin) },
        null,
        2,
      ));
      return;
    }
    console.log(
      JSON.stringify({ apps: [
        { app: "hermes", ...(await listHermesPlugins(config)) },
        { app: "claude-code", plugins: (await listBundlePlugins(config, "claude-code")).map(summarizeBundlePlugin) },
        { app: "codex", plugins: (await listBundlePlugins(config, "codex")).map(summarizeBundlePlugin) },
      ] }, null, 2),
    );
    return;
  }

  if (command === "install") {
    const app = requireApp(args[1]);
    const source = args[2];
    if (!source || source.startsWith("--")) {
      throw new Error(usage());
    }
    let generated: Awaited<ReturnType<typeof regenerateNativeTools>> | undefined;
    const result = await installPlugin({
      installDir: appInstallDir(config, app),
      source,
      name: readOptionValue(args, "--name"),
      force: args.includes("--force"),
      timeoutMs: resolveCloneTimeoutMs({
        cliValue: readRequiredOptionValue(args, "--clone-timeout-ms"),
        envValue: process.env.OPENCLAW_BABELFISH_CLONE_TIMEOUT_MS,
      }),
      validate: app === "hermes"
        ? validateHermesPluginDirectory
        : (target) => validateBundlePluginDirectory(app, target),
      afterChange: async () => {
        generated = await regenerateNativeTools(config);
      },
    });
    const plugin = app === "hermes"
      ? undefined
      : summarizeBundlePlugin(await inspectBundlePlugin(app, result.path));
    console.log(JSON.stringify({ app, installed: result, plugin, ...generated }, null, 2));
    return;
  }

  if (command === "uninstall") {
    const app = requireApp(args[1]);
    const name = args[2];
    if (!name || name.startsWith("--")) {
      throw new Error(usage());
    }
    let generated: Awaited<ReturnType<typeof regenerateNativeTools>> | undefined;
    const result = await uninstallPlugin({
      installDir: appInstallDir(config, app),
      name,
      afterChange: async () => {
        generated = await regenerateNativeTools(config);
      },
    });
    console.log(JSON.stringify({ app, removed: result, ...generated }, null, 2));
    return;
  }

  throw new Error(usage());
}
