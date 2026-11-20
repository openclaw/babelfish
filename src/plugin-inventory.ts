import { listBundlePlugins, summarizeBundlePlugin } from "./bundle-plugins.js";
import { SUPPORTED_APPS, type BabelfishConfig, type SupportedApp } from "./config.js";
import { listHermesPlugins } from "./hermes-python.js";

export async function listInstalledPlugins(config: BabelfishConfig, filter?: SupportedApp) {
  async function listApp(app: SupportedApp) {
    if (app === "hermes") return { app, ...(await listHermesPlugins(config)) };
    const plugins = await listBundlePlugins(config, app);
    return { app, plugins: plugins.map(summarizeBundlePlugin) };
  }

  if (filter) return listApp(filter);
  const apps = [];
  for (const app of SUPPORTED_APPS) apps.push(await listApp(app));
  return { apps };
}
