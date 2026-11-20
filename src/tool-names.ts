export function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "plugin";
}

export function uniqueName(base: string, used: Set<string>, separator = "_"): string {
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) {
    name = `${base}${separator}${suffix}`;
  }
  used.add(name);
  return name;
}

export function duplicateNames<T>(entries: Iterable<T>, nameOf: (entry: T) => string): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const name = nameOf(entry);
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return duplicates;
}
