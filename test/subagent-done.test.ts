import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseDeniedTools,
  shouldAutoExitOnAgentEnd,
  shouldMarkUserTookOver,
  writeExitSidecar,
} from "../subagent-done.ts";
import { writeContextUsageSidecar } from "../src/context-usage.ts";
import {
  clearActiveSubagents,
  markSubagentActive,
} from "../src/runtime-state.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearActiveSubagents();
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

  it("stays open on API errors (timeout, connection failure) so pi can retry", () => {
    const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
  });

  it("stays open on connection errors so pi can retry", () => {
    const messages = [{ role: "assistant", stopReason: "error", errorMessage: "Connection error: WebSocket error" }];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
  });

  it("defaults to exiting when no messages are available", () => {
    assert.equal(shouldAutoExitOnAgentEnd(false, undefined), true);
  });

  it("stays open when the turn produced no new assistant message (errored/retrying turn)", () => {
    // Resumed-session failure mode (verified live, pi 0.80.3): the resume
    // message is delivered, the first request times out, pi schedules a retry,
    // and agent_end fires with the conversation ending at the just-delivered
    // USER message. Walking backwards would find the PREVIOUS conversation's
    // assistant (stopReason "stop") and shut pi down mid-retry.
    const messages = [
      { role: "assistant", stopReason: "stop" }, // stale: pre-resume history
      { role: "user" }, // the resume message — no reply yet
    ];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
  });

  it("still auto-exits when a completed turn follows a resumed conversation", () => {
    const messages = [
      { role: "assistant", stopReason: "stop" },
      { role: "user" },
      { role: "assistant", stopReason: "toolUse" },
      { role: "toolResult" },
      { role: "assistant", stopReason: "stop" },
    ];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
  });

  it("stays open while nested subagents are still running", () => {
    const messages = [{ role: "assistant", stopReason: "stop" }];
    assert.equal(shouldAutoExitOnAgentEnd(false, messages, 2), false);
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
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
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

  it("publishes context usage atomically with version and subagent id", () => {
    const sessionFile = makeSessionFile();
    assert.equal(
      writeContextUsageSidecar(sessionFile, "child-1", {
        tokens: 75_000,
        contextWindow: 200_000,
        percent: 37.5,
      }),
      true,
    );
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-1",
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
    assert.deepEqual(
      readdirSync(join(sessionFile, "..")),
      ["child.jsonl.context-usage"],
      "the temporary file is renamed away",
    );
  });
});

describe("subagent-done: module", () => {
  it("loads standalone and exports a default extension factory", async () => {
    const mod = await import("../subagent-done.ts");
    assert.equal(typeof mod.default, "function");
  });
});

describe("subagent-done: subagent_done tool writes sidecar and shuts down", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("does not recreate a consumed sidecar when agent_end follows subagent_done", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    });

    const handlers: Record<string, Function> = {};
    const registeredTools: Record<string, any> = {};
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: (tool: any) => { registeredTools[tool.name] = tool; },
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => {},
      getContextUsage: () => undefined,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);
    await registeredTools.subagent_done.execute("call-1", {}, null, () => {}, fakeCtx);
    assert.equal(existsSync(`${sessionFile}.exit`), true, "tool writes the terminal sidecar");

    rmSync(`${sessionFile}.exit`);
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );
    assert.equal(
      existsSync(`${sessionFile}.exit`),
      false,
      "agent_end must not recreate a sidecar already consumed by the watcher",
    );
  });

  it("writes usage before the exact done sidecar and shuts down", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origId !== undefined) process.env.PI_SUBAGENT_ID = origId;
      else delete process.env.PI_SUBAGENT_ID;
    });

    const registeredTools: Record<string, any> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: () => {},
      registerTool: (tool: any) => { registeredTools[tool.name] = tool; },
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => {
        assert.ok(existsSync(`${sessionFile}.context-usage`), "usage is published before shutdown");
        assert.ok(existsSync(`${sessionFile}.exit`), "terminal signal is published before shutdown");
        shutdownCalled = true;
      },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 200_000, percent: 37.5 }),
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);

    assert.ok(registeredTools.subagent_done, "subagent_done tool should be registered");
    await registeredTools.subagent_done.execute("call-1", {}, null, () => {}, fakeCtx);

    assert.equal(shutdownCalled, true, "should have called shutdown");
    const sidecar = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(sidecar, '{"type":"done"}', "should write done sidecar");
    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-1",
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
  });
});

describe("subagent-done: user close without subagent_done leaves no sidecar", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("no sidecar written when agent_end fires after abort (user Escape)", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);

    handlers.session_start?.({}, fakeCtx);
    handlers.agent_start?.();
    // User aborts — should NOT auto-exit, no sidecar
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      fakeCtx,
    );

    assert.equal(shutdownCalled, false, "should NOT shutdown on abort");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "should NOT write sidecar on user abort");
  });
});

describe("subagent-done: session_shutdown context usage fallback", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("writes once on user shutdown and does not overwrite the first valid snapshot", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-shutdown";
    cleanups.push(() => {
      if (origSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
      else process.env.PI_SUBAGENT_SESSION = origSession;
      if (origId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = origId;
    });

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    let usage = { tokens: 10, contextWindow: 100, percent: 10 };
    const fakeCtx = {
      getContextUsage: () => usage,
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);
    handlers.session_shutdown?.({}, fakeCtx);
    usage = { tokens: 90, contextWindow: 100, percent: 90 };
    handlers.session_shutdown?.({}, fakeCtx);

    assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.context-usage`, "utf8")), {
      version: 1,
      subagentId: "child-shutdown",
      tokens: 10,
      contextWindow: 100,
      percent: 10,
    });
    assert.equal(existsSync(`${sessionFile}.exit`), false, "fallback does not alter terminal signals");
  });

  it("skips unavailable usage without throwing", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origId = process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_ID = "child-unknown";
    cleanups.push(() => {
      if (origSession === undefined) delete process.env.PI_SUBAGENT_SESSION;
      else process.env.PI_SUBAGENT_SESSION = origSession;
      if (origId === undefined) delete process.env.PI_SUBAGENT_ID;
      else process.env.PI_SUBAGENT_ID = origId;
    });

    const handlers: Record<string, Function> = {};
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);

    assert.doesNotThrow(() => handlers.session_shutdown?.({}, { getContextUsage: () => undefined }));
    assert.equal(existsSync(`${sessionFile}.context-usage`), false);
  });
});

describe("subagent-done: agent_end writes .exit sidecar on clean auto-exit", () => {
  function makeSessionFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "herdr-done-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, "child.jsonl");
  }

  it("writes done sidecar when agent_end triggers auto-exit", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);

    // Simulate session_start to initialize
    handlers.session_start?.({}, fakeCtx);
    // Simulate agent_start so agentStarted = true
    handlers.agent_start?.();
    // Simulate agent_end with a clean completion
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );

    assert.equal(shutdownCalled, true, "should have called shutdown");
    const sidecar = readFileSync(`${sessionFile}.exit`, "utf8");
    assert.equal(sidecar, '{"type":"done"}', "should write done sidecar on auto-exit");
  });

  it("does NOT write done sidecar when agent_end is an error (retry)", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);

    handlers.session_start?.({}, fakeCtx);
    handlers.agent_start?.();
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }] },
      fakeCtx,
    );

    assert.equal(shutdownCalled, false, "should NOT shutdown on error");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "should NOT write sidecar on error");
  });

  it("does NOT auto-exit an orchestrator while nested subagents are running", async () => {
    const sessionFile = makeSessionFile();
    const origSession = process.env.PI_SUBAGENT_SESSION;
    const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    markSubagentActive("nested-1");
    markSubagentActive("nested-2");
    cleanups.push(() => {
      if (origSession !== undefined) process.env.PI_SUBAGENT_SESSION = origSession;
      else delete process.env.PI_SUBAGENT_SESSION;
      if (origAutoExit !== undefined) process.env.PI_SUBAGENT_AUTO_EXIT = origAutoExit;
      else delete process.env.PI_SUBAGENT_AUTO_EXIT;
    });

    const handlers: Record<string, Function> = {};
    let shutdownCalled = false;
    const fakePi = {
      on: (event: string, handler: Function) => { handlers[event] = handler; },
      registerTool: () => {},
      registerShortcut: () => {},
      getAllTools: () => [],
    };
    const fakeCtx = {
      shutdown: () => { shutdownCalled = true; },
      ui: { setWidget: () => {} },
    };

    const mod = await import("../subagent-done.ts");
    mod.default(fakePi as any);
    handlers.agent_end?.(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      fakeCtx,
    );

    assert.equal(shutdownCalled, false, "should keep the nested orchestrator alive");
    let sidecarExists = false;
    try { readFileSync(`${sessionFile}.exit`); sidecarExists = true; } catch {}
    assert.equal(sidecarExists, false, "must not signal completion before children settle");
  });
});
