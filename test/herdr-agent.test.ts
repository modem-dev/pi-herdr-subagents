import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { driveHerdrAgent, installedHerdrAgentKinds, type HerdrAgentRun } from "../src/herdr-agent.ts";
import { findLastAssistantMessage, getNewEntries } from "../src/session.ts";

interface Opts {
  statuses: Array<Record<string, unknown> | null>;
  /** Per prompt call: an error code to throw, or null to succeed (writing the report unless noReport). */
  prompts?: Array<string | null>;
  noReport?: boolean;
  screen?: string;
  interrupted?: boolean;
}

function setup(opts: Opts) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-agent-"));
  let interrupted = opts.interrupted ?? false;
  const run: HerdrAgentRun = {
    id: "run1",
    kind: "codex",
    paneId: "w:p1",
    sessionFile: join(dir, "s.agent.jsonl"),
    promptText: "Read /tmp/task.md and complete the task it describes.",
    resultFile: join(dir, "result.md"),
    autoExit: true,
    takeInterrupt: () => {
      const was = interrupted;
      interrupted = false;
      return was;
    },
  };
  const calls: string[] = [];
  const statuses = [...opts.statuses];
  const prompts = [...(opts.prompts ?? [null])];
  let t = 0;
  const client = {
    async paneGet() {
      return (statuses.length > 1 ? statuses.shift()! : statuses[0]) as any;
    },
    async paneRead() {
      return opts.screen ?? "screen text";
    },
    async paneClose(id: string) {
      calls.push(`close ${id}`);
    },
    async agentPromptAndWait() {
      calls.push("prompt");
      const code = prompts.shift() ?? null;
      if (code) throw Object.assign(new Error(code), { code });
      if (!opts.noReport) writeFileSync(run.resultFile, "the report\n");
    },
    async agentWait(_id: string, until: string[]) {
      calls.push(`wait ${until.join("|")}`);
      if (until.includes("idle")) writeFileSync(run.resultFile, "the report\n");
    },
  };
  const abort = new AbortController();
  const deps = { client, signal: abort.signal, pollMs: 0, detectTimeoutMs: 5, now: () => (t += 1) };
  return { run, calls, deps, abort };
}

const summary = (run: HerdrAgentRun) => findLastAssistantMessage(getNewEntries(run.sessionFile, 0));
const idle = { agent: "codex", agent_status: "idle" };

describe("driveHerdrAgent", () => {
  it("waits past blocked, prompts once, records the report and closes the pane", async () => {
    const { run, calls, deps } = setup({
      statuses: [{ agent: null, agent_status: "unknown" }, { agent: "codex", agent_status: "blocked" }, idle],
    });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["prompt", "close w:p1"]);
    assert.equal(summary(run), "the report");
    assert.deepEqual(JSON.parse(readFileSync(`${run.sessionFile}.exit`, "utf8")), { type: "done" });
  });

  it("resends a stalled prompt that never reached the screen", async () => {
    const { run, calls, deps } = setup({ statuses: [idle], prompts: ["agent_prompt_stalled", null] });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["prompt", "prompt", "close w:p1"]);
    assert.equal(summary(run), "the report");
  });

  it("does not resend a stalled prompt the agent already shows", async () => {
    const { run, calls, deps } = setup({
      statuses: [idle],
      prompts: ["agent_prompt_stalled"],
      screen: "› Read /tmp/task.md and complete the\n  task it describes.",
    });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["prompt", "wait idle|done", "close w:p1"]);
  });

  it("goes back to waiting when a dialog blocks the prompt", async () => {
    const { run, calls, deps } = setup({ statuses: [idle], prompts: ["agent_blocked", null] });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["prompt", "prompt", "close w:p1"]);
  });

  it("an interrupted turn waits for the steered follow-up turn", async () => {
    const { run, calls, deps } = setup({ statuses: [idle], noReport: true, interrupted: true });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["prompt", "wait working", "wait idle|done", "close w:p1"]);
    assert.equal(summary(run), "the report");
  });

  it("falls back to pane text when no report was written", async () => {
    const { run, deps } = setup({ statuses: [idle], noReport: true });
    await driveHerdrAgent(run, deps);
    assert.equal(summary(run), "screen text");
  });

  it("fails with a reason when herdr never detects the agent", async () => {
    const { run, calls, deps } = setup({ statuses: [{ agent: null, agent_status: "unknown" }] });
    await driveHerdrAgent(run, deps);
    assert.deepEqual(calls, ["close w:p1"]);
    assert.match(summary(run)!, /never detected a codex agent/);
    assert.equal(readFileSync(`${run.sessionFile}.exitcode`, "utf8"), "70 run1");
    assert.equal(existsSync(`${run.sessionFile}.exit`), false);
  });

  it("stops quietly when the pane is gone or the run already settled", async () => {
    const gone = setup({ statuses: [null] });
    await driveHerdrAgent(gone.run, gone.deps);
    assert.deepEqual(gone.calls, []);
    assert.equal(existsSync(gone.run.sessionFile), false);

    const settled = setup({ statuses: [{ agent: null, agent_status: "unknown" }] });
    settled.abort.abort();
    await driveHerdrAgent(settled.run, settled.deps);
    assert.deepEqual(settled.calls, []);
    assert.equal(existsSync(settled.run.sessionFile), false);
  });
});

describe("installedHerdrAgentKinds", () => {
  it("lists only known kinds with an executable file on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinds-"));
    for (const [name, mode] of [["codex", 0o755], ["gemini", 0o644], ["notanagent", 0o755]] as const) {
      writeFileSync(join(dir, name), "#!/bin/sh\n");
      chmodSync(join(dir, name), mode);
    }
    mkdirSync(join(dir, "claude")); // a directory is not an executable
    assert.deepEqual(installedHerdrAgentKinds(`/nonexistent:${dir}`), ["codex"]);
  });
});
