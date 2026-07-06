import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseDeniedTools,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
  writeExitSidecar,
} from "../subagent-done.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe("subagent-done: shouldMarkUserTookOver", () => {
  it("ignores the initial injected task before the first agent run", () => {
    assert.equal(shouldMarkUserTookOver(false), false);
  });

  it("treats later input as manual takeover", () => {
    assert.equal(shouldMarkUserTookOver(true), true);
  });
});

describe("subagent-done: shouldAutoExitOnAgentEnd", () => {
  it("auto-exits after normal completion when there was no takeover", () => {
    const messages = [{ role: "assistant", stopReason: "stop" }];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
  });

  it("auto-exits after normal completion even when the user sent the prompt", () => {
    const messages = [{ role: "assistant", stopReason: "stop" }];
    assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
  });

  it("stays open after Escape aborts the run", () => {
    const messages = [{ role: "assistant", stopReason: "aborted" }];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
  });

  it("defaults to exiting when no messages are available", () => {
    assert.equal(shouldAutoExitOnAgentEnd(false, undefined), true);
  });
});

describe("subagent-done: parseDeniedTools", () => {
  it("splits and trims comma-separated names, dropping empties", () => {
    assert.deepEqual(parseDeniedTools(" subagent , subagent_resume ,,bash "), [
      "subagent",
      "subagent_resume",
      "bash",
    ]);
  });

  it("returns an empty list when unset", () => {
    assert.deepEqual(parseDeniedTools(undefined), []);
  });
});

describe("subagent-done: .exit sidecar shapes (cross-extension contract)", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herder-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it('done writes exactly {"type":"done"}', () => {
    const sessionFile = makeSessionFile();
    writeExitSidecar(sessionFile, { type: "done" });
    assert.equal(readFileSync(`${sessionFile}.exit`, "utf8"), '{"type":"done"}');
  });

  it("ping writes type/name/message in reference byte order", () => {
    const sessionFile = makeSessionFile();
    writeExitSidecar(sessionFile, { type: "ping", name: "Worker", message: "need input" });
    assert.equal(
      readFileSync(`${sessionFile}.exit`, "utf8"),
      '{"type":"ping","name":"Worker","message":"need input"}',
    );
  });
});

describe("subagent-done: module", () => {
  it("loads standalone and exports a default extension factory", async () => {
    const mod = await import("../subagent-done.ts");
    assert.equal(typeof mod.default, "function");
  });
});
