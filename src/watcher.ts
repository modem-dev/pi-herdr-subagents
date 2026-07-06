// Per-subagent completion watcher — implements the lifecycle classification
// matrix from PLAN.md exactly. Hard requirement 4: every signal path terminates
// the watch; there is NO path to an eternal "stalled" zombie.
//
// Three signal sources, first one wins (latecomers no-op):
//   (a) HerdrEventStream pane_exited/pane_closed for this pane — primary.
//   (b) fs.watch + slow poll on the session dir for the sidecar files. In the
//       startup-crash hold-open case the pane stays alive, so the exitcode
//       sidecar is the ONLY signal.
//   (c) the stream's reconcile hook (fired after a socket reconnect —
//       events.subscribe has no replay) plus the slow poll → pane existence
//       check; a watched-but-missing pane exited during the gap.
//
// Semantic sidecars (written by the child / wrapper script):
//   <sessionFile>.exit     — {"type":"done"} or {"type":"ping","name","message"}
//                            written by subagent-done.ts before the child exits.
//   <sessionFile>.exitcode — process exit code, written by the wrapper script
//                            (pane.exited carries no exit code — verified).
//
// The watcher consumes (deletes) both sidecars when it resolves from them so a
// later resume of the same session cannot see stale completion signals. It
// does NOT touch the runningSubagents map — removal is the caller's job.
//
// Anti-patterns deliberately absent: no `pane read` screen scraping, no stall
// detection/status transitions (discarded per plan §9).
import { readFileSync, rmSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import type { PaneInfo } from "./herdr/client.ts";
import { findLastAssistantMessage, getNewEntries } from "./session.ts";

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  paneId: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile: string;
  interactive: boolean;
  autoExit: boolean;
  abortController?: AbortController;
}

export type SubagentOutcome =
  | { kind: "completed"; summary: string; exitCode: 0 }
  | { kind: "completed-user-exit"; summary: string; exitCode: 0 } // no .exit sidecar
  | { kind: "ping"; name: string; message: string }
  | { kind: "launch-failed"; exitCode: number; heldOpen: boolean }
  | { kind: "crashed"; exitCode: number; summary: string | null }
  | { kind: "pane-killed"; summary: string | null }
  | { kind: "gap-exit"; summary: string | null; exitCode: number | null }
  | { kind: "cancelled" };

export interface WatcherDeps {
  client: {
    paneGet(paneId: string): Promise<PaneInfo | null>;
    paneList(): Promise<PaneInfo[]>;
  };
  stream: {
    watch(paneId: string, listener: (ev: { event: "pane_exited" | "pane_closed"; paneId: string }) => void): () => void;
    onReconcile(cb: () => void): () => void;
  };
  signal: AbortSignal;
  /** Slow-poll backstop interval (default 5s). */
  pollIntervalMs?: number;
  /** Startup-crash window: nonzero exit inside it with an empty session = launch failure (default 15s). */
  startupWindowMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_WINDOW_MS = 15_000;

type Trigger = "event" | "sidecar" | "gone";

export function watchSubagent(
  running: RunningSubagent,
  deps: WatcherDeps,
): Promise<SubagentOutcome> {
  return new Promise((resolve) => {
    const now = deps.now ?? Date.now;
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startupWindowMs = deps.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
    const exitFile = `${running.sessionFile}.exit`;
    const exitcodeFile = `${running.sessionFile}.exitcode`;

    let done = false;
    let paneEventSeen = false;
    const cleanups: Array<() => void> = [];

    function finish(outcome: SubagentOutcome, consumeSidecars: boolean): void {
      if (done) return;
      done = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          // best-effort teardown
        }
      }
      if (consumeSidecars) {
        try {
          rmSync(exitFile, { force: true });
        } catch {}
        try {
          rmSync(exitcodeFile, { force: true });
        } catch {}
      }
      resolve(outcome);
    }

    if (deps.signal.aborted) {
      finish({ kind: "cancelled" }, false);
      return;
    }

    // ── on-disk state readers (session file is written incrementally → crash-safe) ──

    function readSessionEntries() {
      try {
        return getNewEntries(running.sessionFile, 0);
      } catch {
        return [];
      }
    }

    function readSummary(): string | null {
      return findLastAssistantMessage(readSessionEntries());
    }

    function readExitSidecar(): { type?: string; name?: string; message?: string } | null {
      try {
        return JSON.parse(readFileSync(exitFile, "utf8"));
      } catch {
        return null;
      }
    }

    function readExitCode(): number | null {
      try {
        const parsed = Number.parseInt(readFileSync(exitcodeFile, "utf8").trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    // ── classification matrix (normative — PLAN.md) ──

    function classify(trigger: Trigger): SubagentOutcome | null {
      const exitData = readExitSidecar();
      if (exitData?.type === "ping") {
        return {
          kind: "ping",
          name: exitData.name ?? running.name,
          message: exitData.message ?? "",
        };
      }
      if (exitData?.type === "done") {
        return {
          kind: "completed",
          summary: readSummary() ?? "Sub-agent exited without output",
          exitCode: 0,
        };
      }

      const exitCode = readExitCode();
      if (exitCode !== null) {
        if (exitCode === 0) {
          // No .exit sidecar → the user drove the session and quit pi normally.
          return {
            kind: "completed-user-exit",
            summary: readSummary() ?? "Sub-agent exited without output",
            exitCode: 0,
          };
        }
        const withinStartupWindow = now() - running.startTime < startupWindowMs;
        if (withinStartupWindow && readSessionEntries().length === 0) {
          // Startup crash (e.g. bad --model). If the wrapper's hold-open kept
          // the pane alive, no pane event has fired — the sidecar is the signal.
          return { kind: "launch-failed", exitCode, heldOpen: !paneEventSeen };
        }
        return { kind: "crashed", exitCode, summary: readSummary() };
      }

      // No sidecars at all.
      if (trigger === "event") {
        // The wrapper script always writes the exitcode sidecar before its pane
        // exits, so pane death without sidecars means it was killed externally.
        return { kind: "pane-killed", summary: readSummary() };
      }
      if (trigger === "gone") {
        // Watched pane vanished while the event stream was down (no replay).
        return { kind: "gap-exit", summary: readSummary(), exitCode: null };
      }
      return null; // sidecar trigger without sidecars — not a signal
    }

    let staleCheckInFlight = false;

    function trySettle(trigger: Trigger): void {
      if (done) return;
      const outcome = classify(trigger);
      if (!outcome) return;

      // Stale-sidecar guard (verified live in the resume race): resuming a
      // session whose previous pi is still tearing down can see the OLD
      // wrapper's exit-0 sidecar land AFTER subagent_resume cleared it. An
      // exit-0 wrapper closes its pane immediately, so exit 0 signalled by a
      // sidecar while OUR pane is still alive cannot be ours — consume it and
      // keep watching. (Nonzero exits pass through: hold-open keeps the pane
      // alive on purpose, and pane events/reconcile prove the pane is gone.)
      if (outcome.kind === "completed-user-exit" && trigger === "sidecar") {
        if (staleCheckInFlight) return;
        staleCheckInFlight = true;
        void deps.client
          .paneGet(running.paneId)
          .then((pane) => {
            if (done) return;
            if (pane !== null) {
              try {
                rmSync(exitcodeFile, { force: true });
              } catch {}
              return;
            }
            finish(outcome, true);
          })
          .catch(() => {
            // herdr unreachable — keep watching; the next signal retries
          })
          .finally(() => {
            staleCheckInFlight = false;
          });
        return;
      }

      finish(outcome, true);
    }

    // ── signal source (a): pane events ──

    const unwatch = deps.stream.watch(running.paneId, () => {
      paneEventSeen = true;
      trySettle("event");
    });
    cleanups.push(unwatch);

    // ── signal source (b): sidecar appearance (fs.watch + slow poll backstop) ──

    let fsWatcher: FSWatcher | null = null;
    try {
      const sidecarNames = new Set([basename(exitFile), basename(exitcodeFile)]);
      fsWatcher = fsWatch(dirname(running.sessionFile), (_eventType, filename) => {
        if (filename == null || sidecarNames.has(filename)) trySettle("sidecar");
      });
      fsWatcher.on("error", () => {});
      cleanups.push(() => fsWatcher?.close());
    } catch {
      // session dir may not exist yet; the slow poll still covers sidecars
    }

    async function checkPaneGone(list: boolean): Promise<void> {
      try {
        const gone = list
          ? !(await deps.client.paneList()).some((pane) => pane.pane_id === running.paneId)
          : (await deps.client.paneGet(running.paneId)) === null;
        if (!done && gone) trySettle("gone");
      } catch {
        // herdr unreachable — keep watching; next poll retries
      }
    }

    const pollTimer = setInterval(() => {
      if (done) return;
      trySettle("sidecar");
      if (done) return;
      void checkPaneGone(false);
    }, pollIntervalMs);
    cleanups.push(() => clearInterval(pollTimer));

    // ── signal source (c): reconcile after event-stream reconnect ──

    const offReconcile = deps.stream.onReconcile(() => {
      if (done) return;
      void checkPaneGone(true);
    });
    cleanups.push(offReconcile);

    // ── abort (orchestrator shutdown / interrupt) ──

    const onAbort = () => finish({ kind: "cancelled" }, false);
    deps.signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => deps.signal.removeEventListener("abort", onAbort));

    // Sidecars may already be on disk when the watcher arms (fast child, or
    // re-arming after a reconnect) — check immediately.
    queueMicrotask(() => trySettle("sidecar"));
  });
}
