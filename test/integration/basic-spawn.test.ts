/**
 * Smoke test — the core loop end-to-end against a real isolated herdr session
 * with real pi children (ISC-1 core, minus the devenv env chain which lives in
 * direnv-env.test.ts).
 *
 * spawn → herdr pane runs the child pi directly (argv) → task via artifact
 * file → child writes marker + calls subagent_done → orchestrator session
 * receives a subagent_result steer → child pane is gone.
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
  startOrchestrator,
  type TestSession,
  uniqueId,
  waitFor,
  waitForFile,
  waitForSteer,
} from "./harness.ts";

const prereqs = integrationPrereqs();

describe("basic spawn (smoke)", { skip: prereqs.ok ? false : prereqs.reason, timeout: PI_TIMEOUT * 2 }, () => {
  let ts: TestSession;

  before(async () => {
    ts = await createTestSession();
  });

  after(async () => {
    await ts?.teardown();
  });

  it("spawn → marker file → completion steer → pane cleanup", async () => {
    const id = uniqueId();
    const marker = join(ts.tmpDir, `marker-${id}.txt`);

    const prompt = [
      `Call the subagent tool exactly once with these EXACT parameters:`,
      `name: "Echo-${id}"`,
      `agent: "test-echo"`,
      `task: "Use the bash tool to run: echo PASS_${id} > ${marker} — then call the subagent_done tool."`,
      `Do nothing else. After the tool call returns, end your turn and wait.`,
    ].join("\n");

    const orch = await startOrchestrator(ts, { prompt });
    const debug = () => dumpPanes(ts);

    // (1) the child actually ran and did the work
    const content = await waitForFile(marker, PI_TIMEOUT, /PASS/, debug);
    assert.ok(content.includes(`PASS_${id}`), `marker should contain PASS_${id}, got: ${content}`);

    // (2) completion steer lands in the orchestrator session
    const [steer] = await waitForSteer(orch.sessionFile, {
      customType: "subagent_result",
      timeout: PI_TIMEOUT,
      debug,
    });
    assert.equal(steer.details.exitCode, 0, `expected exit 0 steer, got: ${steer.content}`);
    assert.equal(
      steer.details.disposition,
      "completed",
      `expected 'completed' disposition (child called subagent_done), got: ${steer.content}`,
    );
    assert.equal(steer.details.name, `Echo-${id}`);
    assert.match(steer.content, /completed/);

    // (3) the child session file exists and is a valid v3 session
    const childSession = steer.details.sessionFile as string;
    assert.ok(childSession && existsSync(childSession), `child session should exist: ${childSession}`);
    const header = JSON.parse(readFileSync(childSession, "utf8").split("\n")[0]);
    assert.equal(header.type, "session");

    // (4) child session lives under the ISOLATED config dir, not ~/.pi
    assert.ok(
      childSession.startsWith(ts.configDir),
      `child session must live under the temp config dir (${ts.configDir}), got: ${childSession}`,
    );

    // (5) the child pane is gone (auto-close on clean exit)
    const childPane = steer.details.paneId as string;
    assert.ok(childPane, "steer should carry the child pane id");
    await waitFor(async () => !(await paneExists(ts, childPane)), {
      timeout: 30_000,
      label: `child pane ${childPane} to close`,
      debug,
    });

    // (6) the .exit sidecar was consumed by the watcher. (.exitcode may remain:
    // the watcher resolves from .exit the moment subagent_done writes it, while
    // the wrapper script only writes .exitcode after pi fully exits — that
    // stale-sidecar race is why subagent_resume clears both before launching.)
    assert.ok(!existsSync(`${childSession}.exit`), ".exit sidecar should be consumed");
  });
});
