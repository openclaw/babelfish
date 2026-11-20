export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function stringifyResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
