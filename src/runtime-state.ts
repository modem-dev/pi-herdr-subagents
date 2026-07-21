// Process-global coordination shared by the orchestrator extension (index.ts)
// and the child completion extension (subagent-done.ts). Both are loaded into
// the same pi process, but as separate extension modules. A Set is used instead
// of a scalar count so stale closures from /reload can only remove their own ids.

const ACTIVE_SUBAGENT_IDS_KEY = Symbol.for("pi-herdr-subagents/active-subagent-ids");

function getActiveSubagentIds(): Set<string> {
  let ids = (globalThis as any)[ACTIVE_SUBAGENT_IDS_KEY] as Set<string> | undefined;
  if (!(ids instanceof Set)) {
    ids = new Set<string>();
    (globalThis as any)[ACTIVE_SUBAGENT_IDS_KEY] = ids;
  }
  return ids;
}

/** Return the number of nested subagents currently watched by this pi process. */
export function getActiveSubagentCount(): number {
  return getActiveSubagentIds().size;
}

/** Mark one nested subagent as active. */
export function markSubagentActive(id: string): void {
  getActiveSubagentIds().add(id);
}

/** Mark one nested subagent as settled or abandoned. */
export function markSubagentInactive(id: string): void {
  getActiveSubagentIds().delete(id);
}

/** Test seam: clear all process-global active-subagent state. */
export function clearActiveSubagents(): void {
  getActiveSubagentIds().clear();
}
