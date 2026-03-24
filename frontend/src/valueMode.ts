export type ValueMode = "normalized" | "original";

export function resolveCellValueForMode(
  value: unknown,
  mode: ValueMode,
): unknown {
  if (
    value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && "normalized" in value
    && "original" in value
  ) {
    const pair = value as { original?: unknown; normalized?: unknown };
    return mode === "original" ? pair.original : pair.normalized;
  }
  return value;
}

export function flattenRowsByValueMode<T extends Record<string, unknown>>(
  rows: T[],
  mode: ValueMode,
): T[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [col, val] of Object.entries(row)) {
      out[col] = resolveCellValueForMode(val, mode);
    }
    return out as T;
  });
}
