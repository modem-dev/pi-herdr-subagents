/**
 * Lifecycle integration tests — the truthful-lifecycle guarantees against a
 * real herdr session with real pi children (ISC-2, ISC-3).
 *
 *   1. startup crash (bogus --model) → launch-failed steer within seconds,
 *      naming exit code + launch script; pane held open for post-mortem
 *   2. 3 concurrent spawns → no cross-talk (each steer/session pair matches
 *      its own marker id and no other), steers arrive event-fast
 *   3. user quits child pi without subagent_done → distinct honest phrasing
 *   4. pane killed externally (pane close, no sidecars) → honest failure steer
 *      with the child session path (resumable)
 *
 * Costs real (cheap) model tokens. Skips when herdr/tmux/auth are missing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTestSession,
  dumpPanes,
  integrationPrereqs,
  paneExists,
  PI_TIMEOUT,
  sleep,
  startOrchestrator,
  type TestSession,
  uniqueId,
  waitFor,
  waitForFile,
  waitForSteer,
  writeAgentDef,
} from "./harness.ts";

const prereqs = integrationPrereqs();

const TEST_CRASH_DEF = `---
name: test-crash
description: Integration test agent — invalid model, crashes pi at startup
model: nonexistent/bogus-model-xyz
tools: read, bash
spawning: false
auto-exit: true
disable-model-invocation: true
---

You will never run: the model above does not exist and pi exits at startup.
`;

const TEST_WAIT_DEF = `---
name: test-wait
description: Integration test agent — does the task, then waits for the user
tools: read, bash
spawning: false
auto-exit: false
disable-model-invocation: true
---

You are a test agent. Execute the task given to you immediately using the bash tool.
Then STOP and wait for further instructions. Do NOT call subagent_done unless the task
explicitly tells you to. Do not ask questions.
`;

describe(
  "lifecycle matrix (integration)",
  { skip: prereqs.ok ? false : prereqs.reason, timeout: PI_TIMEOUT * 5 },
  () => {
    let ts: TestSession;

    before(async () => {
      ts = await createTestSession();
      writeAgentDef(ts, "test-crash", TEST_CRASH_DEF);
      writeAgentDef(ts, "test-wait", TEST_WAIT_DEF);
    });

    after(async () => {
      await ts?.teardown();
    });

    // ── ISC-2: startup crash produces an honest failure steer within seconds ──

    it("startup crash (bogus model) → launch-failed steer, pane held open", async () => {
      const id = uniqueId();
      const prompt = [
        `Call the subagent tool exactly once with these EXACT parameters:`,
        `name: "Crash-${id}"`,
        `agent: "test-crash"`,
        `task: "Say hello."`,
        `Do nothing else. If you receive any result or failure message afterwards,`,
        `do NOT retry and do NOT spawn anything else — reply with exactly NOTED and stop.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      // Failure steer arrives promptly. The wall-clock window includes the
      // orchestrator's own boot + first turn (can exceed 30s cold), so ISC-2's
      // "within seconds" is asserted on details.elapsed (spawn→steer) below.
      const [steer] = await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.name === `Crash-${id}`,
        timeout: 60_000,
        debug,
      });
      assert.ok(
        typeof steer.details.elapsed === "number" && steer.details.elapsed <= 20,
        `ISC-2: failure steer should resolve within seconds of the spawn, took ${steer.details.elapsed}s`,
      );

      assert.equal(steer.details.error, "launch-failed", `expected launch failure: ${steer.content}`);
      assert.ok(
        typeof steer.details.exitCode === "number" && steer.details.exitCode !== 0,
        `steer must name a nonzero exit code, got: ${JSON.stringify(steer.details)}`,
      );
      assert.match(steer.content, /failed to launch \(exit code \d+\)/);
      assert.match(steer.content, /Launch script: \S+\.sh/, "steer must name the launch script");
      const scriptPath = steer.content.match(/Launch script: (\S+\.sh)/)?.[1];
      assert.ok(scriptPath && existsSync(scriptPath), `launch script should exist: ${scriptPath}`);

      // Hold-open: the pane survives for post-mortem; close it via the
      // session-scoped client (structurally scoped to OUR isolated session).
      assert.equal(steer.details.heldOpen, true, "startup crash should hold the pane open");
      const paneId = steer.details.paneId as string;
      assert.ok(await paneExists(ts, paneId), "held-open pane should still exist");
      await ts.client.paneClose(paneId);

      // No zombie: the running entry resolved once — no further steers for it.
      await sleep(7_000); // > watcher slow-poll interval
      const repeats = (await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.name === `Crash-${id}`,
        timeout: 1_000,
      })).length;
      assert.equal(repeats, 1, "exactly one steer for the crashed child (no zombie re-fires)");
    });

    // ── ISC-3: three concurrent spawns without cross-talk ──

    it("3 concurrent spawns → 3 markers, 3 distinct steers, no cross-talk", async () => {
      const id = uniqueId();
      const workers = ["alpha", "beta", "gamma"].map((tag) => ({
        tag,
        name: `Con-${tag}-${id}`,
        token: `TOKEN_${tag}_${id}`,
        marker: join(ts.tmpDir, `concurrent-${tag}-${id}.txt`),
      }));

      const prompt = [
        `Call the subagent tool THREE times, all in this same turn, with these EXACT parameters:`,
        ...workers.map(
          (w, i) =>
            `Call ${i + 1}: name: "${w.name}", agent: "test-echo", task: "Use the bash tool to run: echo ${w.token} > ${w.marker} — then call the subagent_done tool."`,
        ),
        `Do nothing else. When results arrive later, do NOT retry or spawn anything — reply NOTED.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      // All three children did their work.
      const markerDeadline: Record<string, number> = {};
      for (const w of workers) {
        const content = await waitForFile(w.marker, PI_TIMEOUT, undefined, debug);
        markerDeadline[w.tag] = Date.now();
        assert.ok(content.includes(w.token), `${w.marker} should contain ${w.token}: ${content}`);
      }

      // Three distinct completion steers, each matching its own child.
      const steers = await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => String(entry.details.name).startsWith("Con-"),
        count: 3,
        timeout: PI_TIMEOUT,
        debug,
      });
      const lastSteerAt = Date.now();

      const byName = new Map(steers.map((s) => [s.details.name as string, s]));
      assert.equal(byName.size, 3, `expected 3 distinct steer names, got: ${[...byName.keys()]}`);

      const sessionFiles = new Set<string>();
      for (const w of workers) {
        const steer = byName.get(w.name);
        assert.ok(steer, `missing steer for ${w.name}`);
        assert.equal(steer.details.exitCode, 0, `${w.name} should complete: ${steer.content}`);
        assert.equal(steer.details.disposition, "completed", steer.content);

        // No cross-talk: each child session mentions its own token and NO other.
        const sessionFile = steer.details.sessionFile as string;
        sessionFiles.add(sessionFile);
        const session = readFileSync(sessionFile, "utf8");
        assert.ok(session.includes(w.token), `${w.name} session should mention ${w.token}`);
        for (const other of workers) {
          if (other === w) continue;
          assert.ok(
            !session.includes(other.token),
            `cross-talk: ${w.name} session mentions ${other.token}`,
          );
        }
      }
      assert.equal(sessionFiles.size, 3, "three distinct child session files");

      // Event-driven delivery speed: steers land shortly after the markers,
      // not on a 60s+ screen-poll cadence (the child still needs a closing
      // turn after the marker write, hence the allowance).
      const lastMarkerAt = Math.max(...Object.values(markerDeadline));
      const deliveryLag = lastSteerAt - lastMarkerAt;
      assert.ok(
        deliveryLag < 45_000,
        `steers should arrive event-fast after markers; lag was ${deliveryLag}ms`,
      );

      // All three child panes cleaned up.
      for (const steer of steers) {
        const paneId = steer.details.paneId as string;
        await waitFor(async () => !(await paneExists(ts, paneId)), {
          timeout: 30_000,
          label: `child pane ${paneId} to close`,
          debug,
        });
      }
    });

    // ── user quits the child pi without subagent_done → distinct phrasing ──

    it("user-exit without subagent_done → 'closed by user' steer", async () => {
      const id = uniqueId();
      const marker = join(ts.tmpDir, `wait-${id}.txt`);
      const prompt = [
        `Call the subagent tool exactly once with these EXACT parameters:`,
        `name: "Wait-${id}"`,
        `agent: "test-wait"`,
        `task: "Use the bash tool to run: echo WAITING_${id} > ${marker} — then wait for further instructions."`,
        `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      await waitForFile(marker, PI_TIMEOUT, /WAITING/, debug);

      // Find the child pane (the interactive child idles in its pane).
      const steersSoFar = () =>
        waitForSteer(orch.sessionFile, {
          customType: "subagent_result",
          match: (entry) => entry.details.name === `Wait-${id}`,
          timeout: PI_TIMEOUT,
          debug,
        });

      // Let the child finish its turn, then quit pi like a user would
      // (double ctrl+c on an idle editor).
      await sleep(5_000);
      const panes = await ts.client.paneList();
      const childPane = panes.find((p) => (p as any).label === `Wait-${id}`)?.pane_id;
      assert.ok(childPane, `child pane for Wait-${id} should exist:\n${await dumpPanes(ts)}`);
      await ts.client.paneSendKeys(childPane, ["ctrl+c"]);
      await sleep(400);
      await ts.client.paneSendKeys(childPane, ["ctrl+c"]);

      const [steer] = await steersSoFar();
      assert.equal(steer.details.disposition, "completed-user-exit", steer.content);
      assert.equal(steer.details.exitCode, 0, steer.content);
      assert.match(steer.content, /closed by user, no subagent_done/);
      assert.ok(
        existsSync(steer.details.sessionFile as string),
        "child session path must be delivered for resume",
      );
    });

    // ── pane killed externally (no sidecars) → honest failure steer ──

    it("pane closed externally → pane-killed steer with session path", async () => {
      const id = uniqueId();
      const marker = join(ts.tmpDir, `kill-${id}.txt`);
      const prompt = [
        `Call the subagent tool exactly once with these EXACT parameters:`,
        `name: "Kill-${id}"`,
        `agent: "test-wait"`,
        `task: "Use the bash tool to run: echo KILLME_${id} > ${marker} — then wait for further instructions."`,
        `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      await waitForFile(marker, PI_TIMEOUT, /KILLME/, debug);

      const panes = await ts.client.paneList();
      const childPane = panes.find((p) => (p as any).label === `Kill-${id}`)?.pane_id;
      assert.ok(childPane, `child pane for Kill-${id} should exist:\n${await dumpPanes(ts)}`);

      // Kill the pane out from under the child — wrapper gets no chance to
      // write the exitcode sidecar.
      await ts.client.paneClose(childPane);

      const [steer] = await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.name === `Kill-${id}`,
        timeout: 30_000,
        debug,
      });
      assert.equal(steer.details.error, "pane-killed", steer.content);
      assert.match(steer.content, /closed before completion|killed externally/);
      const sessionFile = steer.details.sessionFile as string;
      assert.ok(sessionFile && existsSync(sessionFile), "session path delivered for resume");
      assert.match(steer.content, new RegExp(`Session: ${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    });
  },
);
