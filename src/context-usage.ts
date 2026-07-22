import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export const CONTEXT_USAGE_VERSION = 1 as const;
export const contextUsagePath = (sessionFile: string): string => `${sessionFile}.context-usage`;

export interface ContextUsageSnapshot {
  version: typeof CONTEXT_USAGE_VERSION;
  subagentId: string;
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

type ContextUsage = Pick<ContextUsageSnapshot, "tokens" | "contextWindow" | "percent">;

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

export function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === CONTEXT_USAGE_VERSION &&
    typeof candidate.subagentId === "string" &&
    candidate.subagentId.length > 0 &&
    isNullableNonNegativeNumber(candidate.tokens) &&
    typeof candidate.contextWindow === "number" &&
    Number.isFinite(candidate.contextWindow) &&
    candidate.contextWindow >= 0 &&
    isNullableNonNegativeNumber(candidate.percent)
  );
}

/** Write a complete snapshot before atomically publishing it at the sidecar path. */
export function writeContextUsageSidecar(
  sessionFile: string,
  id: string,
  usage: ContextUsage,
  options?: { overwrite?: boolean },
): boolean {
  if (
    !id ||
    !isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: id, ...usage })
  ) {
    return false;
  }

  const target = contextUsagePath(sessionFile);
  if (options?.overwrite === false && existsSync(target)) return false;

  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(
      temp,
      JSON.stringify({ version: CONTEXT_USAGE_VERSION, subagentId: id, ...usage }),
    );
    if (options?.overwrite === false && existsSync(target)) return false;
    renameSync(temp, target);
    return true;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Read once, validate ownership, and consume even malformed or stale telemetry. */
export function consumeContextUsageSidecar(
  sessionFile: string,
  expectedId: string,
): ContextUsageSnapshot | null {
  const path = contextUsagePath(sessionFile);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isContextUsageSnapshot(parsed) && parsed.subagentId === expectedId ? parsed : null;
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
}
