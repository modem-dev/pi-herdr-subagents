import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { watchSubagent, type RunningSubagent, type SubagentOutcome } from "../src/watcher.ts";
import type { PaneInfo } from "../src/herdr/client.ts";

// ── fakes ─────────────────────────────────────────────────────────────────

function makeFakeStream() {
  const listeners = new Map<string, (ev: { event: "pane_exited" | "pane_closed"; paneId: string }) => void>();
  let reconcileCbs: Array<() => void> = [];
  let unwatchCount = 0;
  return {
    stream: {
      watch(paneId: string, listener: (ev: { event: "pane_exited" | "pane_closed"; paneId: string }) => void) {
        listeners.set(paneId, listener);
        return () => {
          unwatchCount++;
          listeners.delete(paneId);
        };
      },
      onReconcile(cb: () => void) {
        reconcileCbs.push(cb);
        return () => {
          reconcileCbs = reconcileCbs.filter((c) => c !== cb);
        };
      },
    },
    fire(paneId: string, event: "pane_exited" | "pane_closed") {
      listeners.get(paneId)?.({ event, paneId });
    },
    reconcile() {
      for (const cb of [...reconcileCbs]) cb();
    },
    get unwatchCount() {
      return unwatchCount;
    },
    get watchedCount() {
      return listeners.size;
    },
    get reconcileCbCount() {
      return reconcileCbs.length;
    },
  };
}

function makeFakeClient(opts?: { panes?: PaneInfo[] }) {
  let panes = opts?.panes ?? [];
  return {
    client: {
      async paneGet(paneId: string): Promise<PaneInfo | null> {
        return panes.find((p) => p.pane_id === paneId) ?? null;
      },
      async paneList(): Promise<PaneInfo[]> {
        return panes;
      },
    },
    setPanes(next: PaneInfo[]) {
      panes = next;
    },
  };
}

// ── fixtures ──────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function makeRunning(overrides?: Partial<RunningSubagent>): RunningSubagent {
  const dir = mkdtempSync(join(tmpdir(), "herdr-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return {
    id: "sub1",
    name: "Worker",
    task: "do the thing",
    paneId: "w1:p4",
    startTime: Date.now(),
    sessionFile: join(dir, "child.jsonl"),
    launchScriptFile: join(dir, "worker-sub1.sh"),
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function writeSession(sessionFile: string, assistantText: string | null): void {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: "task" }] },
    }),
  ];
  if (assistantText != null) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: "m2",
        message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
      }),
    );
  }
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

function watch(
  running: RunningSubagent,
  deps: {
    stream: ReturnType<typeof makeFakeStream>["stream"];
    client: ReturnType<typeof makeFakeClient>["client"];
    signal?: AbortSignal;
    pollIntervalMs?: number;
    startupWindowMs?: number;
  },
): Promise<SubagentOutcome> {
  return watchSubagent(running, {
    client: deps.client,
    stream: deps.stream,
    signal: deps.signal ?? new AbortController().signal,
    pollIntervalMs: deps.pollIntervalMs ?? 30_000,
    startupWindowMs: deps.startupWindowMs,
  });
}

// ── classification matrix ────────────────────────────────────────────────

describe("watcher: lifecycle classification matrix", () => {
  it("done sidecar + exit 0 → completed", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "All done!");
    writeFileSync(`${running.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.fire(running.paneId, "pane_exited");
    const outcome = await promise;

    assert.deepEqual(outcome, { kind: "completed", summary: "All done!", exitCode: 0 });
    assert.ok(!existsSync(`${running.sessionFile}.exit`), "exit sidecar consumed");
    assert.ok(!existsSync(`${running.sessionFile}.exitcode`), "exitcode sidecar consumed");
  });

  it("ping sidecar → ping", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "I need help with X");
    writeFileSync(
      `${running.sessionFile}.exit`,
      JSON.stringify({ type: "ping", name: "Worker", message: "help me" }),
    );
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const outcome = await watch(running, { stream: fakeStream.stream, client: fakeClient.client });

    assert.deepEqual(outcome, { kind: "ping", name: "Worker", message: "help me" });
  });

  it("no .exit, exit 0, session has entries → completed-user-exit", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "We got this far together.");
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.fire(running.paneId, "pane_exited");
    const outcome = await promise;

    assert.deepEqual(outcome, {
      kind: "completed-user-exit",
      summary: "We got this far together.",
      exitCode: 0,
    });
  });

  it("stale exit-0 sidecar with the pane still alive is consumed, not trusted", async () => {
    // Verified live (resume race): resuming a session whose previous pi is
    // still tearing down can see the OLD wrapper's exit-0 sidecar land after
    // subagent_resume cleared it. An exit-0 wrapper closes its pane
    // immediately, so exit 0 + live pane = not our exit — consume and keep
    // watching until the REAL signal arrives.
    const running = makeRunning();
    writeSession(running.sessionFile, "Old conversation tail.");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [{ pane_id: running.paneId }] });

    const promise = watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      pollIntervalMs: 20,
    });

    // Stale sidecar from the previous run lands while OUR pane is alive.
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      !existsSync(`${running.sessionFile}.exitcode`),
      "stale exit-0 sidecar should be consumed while the pane lives",
    );

    // The real completion: child writes the done sidecar and the pane closes.
    writeSession(running.sessionFile, "Fresh answer after resume.");
    writeFileSync(`${running.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    fakeClient.setPanes([]);
    fakeStream.fire(running.paneId, "pane_exited");
    const outcome = await promise;

    assert.deepEqual(outcome, {
      kind: "completed",
      summary: "Fresh answer after resume.",
      exitCode: 0,
    });
  });

  it("exit 7 within startup window, empty session, no pane event → launch-failed (hold-open)", async () => {
    const running = makeRunning();
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [{ pane_id: running.paneId }] });

    // The pane is held open — the exitcode sidecar is the ONLY signal.
    const promise = watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      pollIntervalMs: 20,
    });
    writeFileSync(`${running.sessionFile}.exitcode`, "7\n");
    const outcome = await promise;

    assert.deepEqual(outcome, { kind: "launch-failed", exitCode: 7, heldOpen: true });
  });

  it("exit 1 after startup window with session entries → crashed with summary", async () => {
    const running = makeRunning({ startTime: Date.now() - 60_000 });
    writeSession(running.sessionFile, "I was mid-task when it broke.");
    writeFileSync(`${running.sessionFile}.exitcode`, "1\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.fire(running.paneId, "pane_exited");
    const outcome = await promise;

    assert.deepEqual(outcome, {
      kind: "crashed",
      exitCode: 1,
      summary: "I was mid-task when it broke.",
    });
  });

  it("pane_closed with no sidecars → pane-killed with last assistant message", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "Last words before the kill.");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.fire(running.paneId, "pane_closed");
    const outcome = await promise;

    assert.deepEqual(outcome, { kind: "pane-killed", summary: "Last words before the kill." });
  });

  it("reconcile: watched pane missing from paneList, no sidecars → gap-exit", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "Something happened during the gap.");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [{ pane_id: "w1:other" }] });

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.reconcile();
    const outcome = await promise;

    assert.deepEqual(outcome, {
      kind: "gap-exit",
      summary: "Something happened during the gap.",
      exitCode: null,
    });
  });

  it("reconcile with on-disk done sidecar → classified as completed, not gap-exit", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "Finished during the gap.");
    writeFileSync(`${running.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [] });

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    fakeStream.reconcile();
    const outcome = await promise;

    assert.deepEqual(outcome, { kind: "completed", summary: "Finished during the gap.", exitCode: 0 });
  });

  it("reconcile: pane still present → keeps watching", async () => {
    const running = makeRunning();
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [{ pane_id: running.paneId }] });

    let resolved: SubagentOutcome | null = null;
    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    void promise.then((o) => (resolved = o));

    fakeStream.reconcile();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(resolved, null, "must not resolve while the pane is alive");

    // ...until the pane actually exits
    writeSession(running.sessionFile, "done now");
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    fakeStream.fire(running.paneId, "pane_exited");
    const outcome = await promise;
    assert.equal(outcome.kind, "completed-user-exit");
  });

  it("abort → cancelled, all listeners and timers cleaned up", async () => {
    const running = makeRunning();
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [{ pane_id: running.paneId }] });
    const controller = new AbortController();

    const promise = watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      signal: controller.signal,
      pollIntervalMs: 10,
    });
    controller.abort();
    const outcome = await promise;

    assert.deepEqual(outcome, { kind: "cancelled" });
    assert.equal(fakeStream.unwatchCount, 1, "pane listener unwatched");
    assert.equal(fakeStream.watchedCount, 0);
    assert.equal(fakeStream.reconcileCbCount, 0, "reconcile callback unregistered");
    // sidecars are NOT consumed on cancel — children keep running
  });

  it("already-aborted signal resolves cancelled immediately", async () => {
    const running = makeRunning();
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();
    const controller = new AbortController();
    controller.abort();

    const outcome = await watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      signal: controller.signal,
    });
    assert.deepEqual(outcome, { kind: "cancelled" });
    assert.equal(fakeStream.watchedCount, 0);
  });

  it("duplicate signals resolve once and latecomers are no-ops", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "All done!");
    writeFileSync(`${running.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(`${running.sessionFile}.exitcode`, "0\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [] });

    const promise = watch(running, { stream: fakeStream.stream, client: fakeClient.client });
    // pile on every signal source
    fakeStream.fire(running.paneId, "pane_exited");
    fakeStream.fire(running.paneId, "pane_closed");
    fakeStream.reconcile();
    const outcome = await promise;

    assert.equal(outcome.kind, "completed");
    assert.equal(fakeStream.unwatchCount, 1, "cleanup ran exactly once");
    assert.equal(fakeStream.watchedCount, 0);
    assert.equal(fakeStream.reconcileCbCount, 0);

    // latecomer signals after resolution must be harmless no-ops
    fakeStream.fire(running.paneId, "pane_exited");
    fakeStream.reconcile();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("startup window boundary: nonzero exit past the window with empty session → crashed", async () => {
    const running = makeRunning({ startTime: Date.now() - 200 });
    writeFileSync(`${running.sessionFile}.exitcode`, "3\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const outcome = await watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      startupWindowMs: 100, // window already elapsed
    });

    assert.deepEqual(outcome, { kind: "crashed", exitCode: 3, summary: null });
  });

  it("nonzero exit within window but session has entries → crashed, not launch-failed", async () => {
    const running = makeRunning();
    writeSession(running.sessionFile, "Real work happened.");
    writeFileSync(`${running.sessionFile}.exitcode`, "1\n");
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient();

    const outcome = await watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
    });

    assert.deepEqual(outcome, { kind: "crashed", exitCode: 1, summary: "Real work happened." });
  });

  it("slow poll backstop: pane vanished without any event or sidecar → gap-exit", async () => {
    const running = makeRunning();
    const fakeStream = makeFakeStream();
    const fakeClient = makeFakeClient({ panes: [] }); // pane already gone

    const outcome = await watch(running, {
      stream: fakeStream.stream,
      client: fakeClient.client,
      pollIntervalMs: 15,
    });

    assert.deepEqual(outcome, { kind: "gap-exit", summary: null, exitCode: null });
  });
});
