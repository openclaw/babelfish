// Diagnostic branch only. Durations are relative to the packed CLI invocation.
export function installTiming(stage: string): void {
  const start = process.env.BABELFISH_BENCH_INSTALL_START;
  if (start) console.error(`[install timing] ${stage} at ${Date.now() - Number(start)} ms`);
}
