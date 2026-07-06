/**
 * Resume / interrupt / ping integration tests (ISC-4) — real herdr session,
 * real pi children.
 *
 *   1. ping → resume round-trip: caller_ping steer (message + session path),
 *      orchestrator resumes with follow-up instructions, child completes
 *   2. interrupt: Escape lands in the running child's turn (verified via
 *      stopReason: "aborted" in the child session), no steer from the
 *      interrupt itself, child pane stays alive
 *   3. interactive positive variant: non-auto-exit child that calls
 *      subagent_done itself → completion steer
 *
 * Costs real (cheap) model tokens. Skips when herdr/tmux/auth are missing.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTestSession,
  dumpPanes,
  integrationPrereqs,
  paneExists,
  PI_TIMEOUT,
  readCustomMessages,
  sendPrompt,
  sleep,
  startOrchestrator,
  TEST_MODEL,
  type TestSession,
  uniqueId,
  waitFor,
  waitForFile,
  waitForSteer,
  writeAgentDef,
} from "./harness.ts";

const prereqs = integrationPrereqs();

/**
 * test-ping variant that can also FINISH: pings on the initial task, but a
 * resume message starting with "RESUME:" makes it execute and call
 * subagent_done (the stock def pings forever, which would deadlock case 1).
 */
const TEST_PING_RESUMABLE_DEF = `---
name: test-ping
description: Integration test agent — pings first, completes on RESUME
model: ${TEST_MODEL}
tools: read, bash
spawning: false
disable-model-invocation: true
---

You are a test agent. EVERY message you receive requires an IMMEDIATE tool call — never
reply without calling a tool, never wait for more input:
- If the message contains "RESUME:", follow those instructions exactly using the bash tool,
  then call the subagent_done tool.
- Otherwise you MUST immediately call the caller_ping tool with the message set to "PING: "
  followed by the text of the request you received.
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
  "resume / interrupt / ping (ISC-4)",
  { skip: prereqs.ok ? false : prereqs.reason, timeout: PI_TIMEOUT * 5 },
  () => {
    let ts: TestSession;

    before(async () => {
      ts = await createTestSession();
      writeAgentDef(ts, "test-ping", TEST_PING_RESUMABLE_DEF);
      writeAgentDef(ts, "test-wait", TEST_WAIT_DEF);
    });

    after(async () => {
      await ts?.teardown();
    });

    // ── ping → resume round-trip ──

    it("caller_ping → subagent_ping steer → subagent_resume → completion", async () => {
      const id = uniqueId();
      const marker = join(ts.tmpDir, `answer-${id}.txt`);

      // The orchestrator drives the WHOLE flow from one briefing — including
      // extracting the session path from the ping steer, like production use.
      const prompt = [
        `Follow these steps exactly:`,
        `Step 1: Call the subagent tool once with EXACTLY: name: "Ping-${id}", agent: "test-ping", task: "Ask your caller for input: NEED_INPUT_${id}"`,
        `Step 2: Later a message will arrive saying a sub-agent needs help; it contains a line "Session: <path>".`,
        `When it arrives, call the subagent_resume tool with sessionPath set to that exact path and`,
        `message: "RESUME: use the bash tool to run: echo ANSWER_${id} > ${marker} — then call the subagent_done tool."`,
        `Step 3: When a completion result arrives, reply NOTED.`,
        `Never retry, never spawn anything else.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      // Ping steer: message + session path.
      const [ping] = await waitForSteer(orch.sessionFile, {
        customType: "subagent_ping",
        timeout: PI_TIMEOUT,
        debug,
      });
      assert.match(String(ping.details.message), new RegExp(`NEED_INPUT_${id}`));
      assert.match(ping.content, /needs help/);
      const pingSession = ping.details.sessionFile as string;
      assert.ok(pingSession && existsSync(pingSession), "ping steer must carry the session path");
      assert.match(ping.content, /Session: \S+\.jsonl/);

      // Resume happens (orchestrator-driven), child completes the follow-up.
      const answer = await waitForFile(marker, PI_TIMEOUT, /ANSWER/, debug);
      assert.ok(answer.includes(`ANSWER_${id}`), `marker should contain ANSWER_${id}: ${answer}`);

      const [result] = await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.sessionFile === pingSession,
        timeout: PI_TIMEOUT,
        debug,
      });
      assert.equal(result.details.disposition, "completed", result.content);
      assert.equal(result.details.exitCode, 0);
      // Resume summary slicing: the summary is the post-resume assistant
      // message, not the pre-ping conversation.
      const summary = String(result.details.summary ?? "");
      assert.ok(summary.trim().length > 0, "resume completion should carry a summary");
      assert.ok(
        !summary.includes("PING:"),
        `summary must come from entries AFTER the resume, got: ${summary}`,
      );
    });

    // ── interrupt: Escape reaches the child's active turn ──

    it("subagent_interrupt aborts the child turn, no steer, pane survives", async () => {
      const id = uniqueId();
      const childCwd = join(ts.tmpDir, `interrupt-${id}`);
      mkdirSync(childCwd, { recursive: true });
      const marker = join(ts.tmpDir, `long-${id}.txt`);

      const prompt = [
        `Call the subagent tool exactly once with these EXACT parameters:`,
        `name: "Long-${id}"`,
        `agent: "test-wait"`,
        `cwd: "${childCwd}"`,
        `task: "Use the bash tool to run this single command: echo START_${id} > ${marker} && sleep 300"`,
        `Do nothing else. If any result arrives later, do NOT retry — reply NOTED.`,
        `If you are asked to interrupt a subagent, call the subagent_interrupt tool with the exact name given.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      // Child is mid-tool-call (marker written, sleep 300 running).
      await waitForFile(marker, PI_TIMEOUT, /START/, debug);
      await sleep(2_000);

      // Distinct child cwd → distinct session dir → we can find the child session.
      const childSessionDir = join(
        ts.configDir,
        "sessions",
        `--${childCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      );
      const childSession = join(
        childSessionDir,
        readdirSync(childSessionDir).find((f) => f.endsWith(".jsonl"))!,
      );
      assert.ok(existsSync(childSession), `child session should exist in ${childSessionDir}`);

      const childPane = (await ts.client.paneList()).find(
        (p) => (p as any).label === `Long-${id}`,
      )?.pane_id;
      assert.ok(childPane, `child pane for Long-${id} should exist:\n${await dumpPanes(ts)}`);

      // Drive the interrupt through the orchestrator (real tool call).
      await sendPrompt(ts, orch.paneId, `Interrupt the subagent named "Long-${id}" now.`);

      // Escape landed: the child's assistant turn ends with stopReason "aborted".
      await waitFor(
        async () => {
          const raw = readFileSync(childSession, "utf8");
          return raw.includes('"stopReason":"aborted"') ? true : null;
        },
        { timeout: 60_000, label: `aborted turn in ${childSession}`, debug },
      );

      // The interrupt itself must NOT emit a subagent_result steer, and the
      // child pane/watcher stay alive.
      await sleep(7_000); // > watcher slow-poll interval
      const steers = readCustomMessages(orch.sessionFile, "subagent_result").filter(
        (entry) => entry.details.name === `Long-${id}`,
      );
      assert.equal(steers.length, 0, `interrupt must not emit a result steer: ${JSON.stringify(steers)}`);
      assert.ok(await paneExists(ts, childPane), "child pane must survive the interrupt");

      // Cleanup: close the (idle) child pane; its watcher resolves as pane-killed.
      await ts.client.paneClose(childPane);
      await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.name === `Long-${id}`,
        timeout: 30_000,
        debug,
      });
    });

    // ── interactive child that calls subagent_done itself ──

    it("non-auto-exit child calling subagent_done delivers a completion steer", async () => {
      const id = uniqueId();
      const marker = join(ts.tmpDir, `inter-${id}.txt`);

      const prompt = [
        `Call the subagent tool exactly once with these EXACT parameters:`,
        `name: "Inter-${id}"`,
        `agent: "test-wait"`,
        `interactive: true`,
        `task: "Use the bash tool to run: echo INTER_${id} > ${marker} — then call the subagent_done tool."`,
        `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
      ].join("\n");

      const orch = await startOrchestrator(ts, { prompt });
      const debug = () => dumpPanes(ts);

      await waitForFile(marker, PI_TIMEOUT, /INTER/, debug);

      const [steer] = await waitForSteer(orch.sessionFile, {
        customType: "subagent_result",
        match: (entry) => entry.details.name === `Inter-${id}`,
        timeout: PI_TIMEOUT,
        debug,
      });
      assert.equal(steer.details.disposition, "completed", steer.content);
      assert.equal(steer.details.exitCode, 0);

      // Pane closes after subagent_done even for interactive children.
      const paneId = steer.details.paneId as string;
      await waitFor(async () => !(await paneExists(ts, paneId)), {
        timeout: 30_000,
        label: `child pane ${paneId} to close`,
        debug,
      });
    });
  },
);
