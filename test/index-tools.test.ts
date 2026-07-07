import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import herdrSubagents, { __test__ } from "../index.ts";
import type { RunningSubagent, SubagentOutcome } from "../src/watcher.ts";

// ── env management (same discipline as index.test.ts) ──────────────────────

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_HERDR_PI_BIN",
  "PI_CODING_AGENT_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();
const cleanups: Array<() => void> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  __test__.reset();
  while (cleanups.length > 0) cleanups.pop()!();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function envInsideHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr-test.sock";
}

// ── fakes ──────────────────────────────────────────────────────────────────

function createFakePi() {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];

  const api: any = {
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    registerMessageRenderer() {},
    registerShortcut() {},
    on() {},
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    sendUserMessage(text: string) {
      sentUser.push(text);
    },
    getAllTools() {
      return registeredTools.map((t) => ({ name: t.name }));
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  return {
    api,
    registeredTools,
    commands,
    sent,
    sentUser,
    findTool(name: string) {
      return registeredTools.find((t) => t.name === name);
    },
    findCommand(name: string) {
      return commands.find((c) => c.name === name);
    },
  };
}

function makeFakeCtx(overrides?: { cwd?: string; sessionDir?: string }) {
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    hasUI: false,
    cwd: overrides?.cwd ?? "/tmp",
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      setWidget() {},
    },
    sessionManager: {
      getSessionFile: () => "/tmp/orch.jsonl",
      getSessionId: () => "orch-session-id",
      getSessionDir: () => overrides?.sessionDir ?? "/tmp/orch-sessions",
    },
  };
  return { ctx, notifications };
}

function makeFakeClient(overrides?: Partial<Record<string, Function>>) {
  return {
    async agentStart() {
      return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
    },
    async paneGet() {
      return null;
    },
    async paneList() {
      return [];
    },
    async paneClose() {},
    async paneSendKeys() {},
    async ping() {
      return { ok: true, version: "0.7.1", protocol: 14 };
    },
    ...overrides,
  } as any;
}

function makeFakeStream() {
  return {
    watch() {
      return () => {};
    },
    onReconcile() {
      return () => {};
    },
    close() {},
    connected: false,
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-tools-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent-config");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  const sessionDir = join(root, "orch-sessions");
  mkdirSync(sessionDir, { recursive: true });

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";

  const { ctx, notifications } = makeFakeCtx({ cwd, sessionDir });
  return { root, cwd, agentDir, sessionDir, ctx, notifications };
}

function makeRunning(overrides?: Partial<RunningSubagent>): RunningSubagent {
  return {
    id: "a1",
    name: "Worker",
    task: "do it",
    paneId: "w1:p4",
    startTime: Date.now(),
    sessionFile: "/tmp/a1.jsonl",
    launchScriptFile: "/tmp/a1.sh",
    interactive: false,
    autoExit: true,
    ...overrides,
  };
}

function writeChildSession(sessionFile: string, assistantText: string): void {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/tmp" }),
    JSON.stringify({
      type: "message",
      id: "m1",
      message: { role: "user", content: [{ type: "text", text: "task" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "m2",
      message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
    }),
  ];
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

function appendAssistantEntry(sessionFile: string, text: string): void {
  appendFileSync(
    sessionFile,
    JSON.stringify({
      type: "message",
      id: `m${Math.random().toString(16).slice(2, 6)}`,
      message: { role: "assistant", content: [{ type: "text", text }] },
    }) + "\n",
  );
}

function registerAll() {
  envInsideHerdr();
  const fake = createFakePi();
  herdrSubagents(fake.api);
  return fake;
}

// ── registration surface ────────────────────────────────────────────────────

describe("index tools: registration", () => {
  it("registers all four orchestrator tools inside herdr", () => {
    const fake = registerAll();
    const names = fake.registeredTools.map((t) => t.name);
    for (const name of ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"]) {
      assert.ok(names.includes(name), `expected ${name} to be registered`);
    }
  });

  it("registers /subagent and /iterate commands inside herdr", () => {
    const fake = registerAll();
    assert.ok(fake.findCommand("subagent"));
    assert.ok(fake.findCommand("iterate"));
  });
});

// ── subagent_interrupt ──────────────────────────────────────────────────────

describe("index tools: subagent_interrupt", () => {
  it("resolveInterruptTarget resolves by exact id and reports ambiguity/missing", () => {
    const map = __test__.runningSubagents;
    map.clear();
    try {
      map.set("a1", makeRunning({ id: "a1", name: "Worker" }));
      map.set("b2", makeRunning({ id: "b2", name: "Worker" }));
      map.set("c3", makeRunning({ id: "c3", name: "Scout" }));

      const byId = __test__.resolveInterruptTarget({ id: "c3", name: "Worker" }) as any;
      assert.equal(byId.running.id, "c3");

      const byName = __test__.resolveInterruptTarget({ name: "Scout" }) as any;
      assert.equal(byName.running.id, "c3");

      const ambiguous = __test__.resolveInterruptTarget({ name: "Worker" }) as any;
      assert.match(ambiguous.error, /Ambiguous subagent name/);

      const missingId = __test__.resolveInterruptTarget({ id: "zz" }) as any;
      assert.match(missingId.error, /No running subagent with id/);

      const missingName = __test__.resolveInterruptTarget({ name: "Nope" }) as any;
      assert.match(missingName.error, /No running subagent named/);

      const noParams = __test__.resolveInterruptTarget({}) as any;
      assert.match(noParams.error, /id or exact display name/);
    } finally {
      map.clear();
    }
  });

  it("interrupt sends Escape via herdr send-keys and keeps the entry alive", async () => {
    const fake = registerAll();
    const sendKeysCalls: Array<{ paneId: string; keys: string[] }> = [];
    __test__.setDeps({
      client: makeFakeClient({
        paneSendKeys: async (paneId: string, keys: string[]) => {
          sendKeysCalls.push({ paneId, keys });
        },
      }),
    });
    __test__.runningSubagents.set("a1", makeRunning({ id: "a1", paneId: "w1:p4" }));

    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "a1" }, undefined, undefined, makeFakeCtx().ctx);

    assert.equal(result.details.status, "interrupt_requested");
    assert.deepEqual(sendKeysCalls, [{ paneId: "w1:p4", keys: ["esc"] }]);
    assert.ok(__test__.runningSubagents.has("a1"), "entry stays alive (ack-only semantics)");
    assert.equal(fake.sent.length, 0, "no steer emitted for an interrupt");
  });

  it("interrupt with unknown id returns an error result", async () => {
    const fake = registerAll();
    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "nope" }, undefined, undefined, makeFakeCtx().ctx);
    assert.match(result.details.error, /No running subagent with id/);
  });

  it("Escape delivery failure returns an explicit error", async () => {
    const fake = registerAll();
    __test__.setDeps({
      client: makeFakeClient({
        paneSendKeys: async () => {
          throw new Error("socket write failed");
        },
      }),
    });
    __test__.runningSubagents.set("a1", makeRunning({ id: "a1" }));

    const tool = fake.findTool("subagent_interrupt");
    const result = await tool.execute("t1", { id: "a1" }, undefined, undefined, makeFakeCtx().ctx);

    assert.match(result.details.error, /socket write failed/);
    assert.match(result.content[0].text, /Failed to send Escape/);
  });
});

// ── subagent_resume ─────────────────────────────────────────────────────────

describe("index tools: subagent_resume", () => {
  it("resolveResumeLaunchBehavior defaults to auto-exit, non-interactive", () => {
    assert.deepEqual(__test__.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(__test__.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("rejects a missing session file", async () => {
    const fake = registerAll();
    makeFixture();
    const tool = fake.findTool("subagent_resume");
    const result = await tool.execute(
      "t1",
      { sessionPath: "/nonexistent/child.jsonl" },
      undefined,
      undefined,
      makeFakeCtx().ctx,
    );
    assert.equal(result.details.error, "session not found");
    assert.match(result.content[0].text, /session file not found/);
  });

  it("clears stale sidecars, launches via argv, and extracts only NEW entries for the summary", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    const sessionPath = join(fx.root, "child.jsonl");
    writeChildSession(sessionPath, "old summary");
    // stale sidecars from the previous run — must be gone before launch
    writeFileSync(`${sessionPath}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(`${sessionPath}.exitcode`, "0\n");

    let sidecarsAtLaunch: boolean | null = null;
    let launchedArgv: string[] | null = null;
    __test__.setDeps({
      client: makeFakeClient({
        agentStart: async (p: any) => {
          sidecarsAtLaunch =
            existsSync(`${sessionPath}.exit`) || existsSync(`${sessionPath}.exitcode`);
          launchedArgv = p.argv;
          return { paneId: "w1:p7", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (): Promise<SubagentOutcome> => {
        // the resumed child writes new entries, then completes
        appendAssistantEntry(sessionPath, "new summary");
        return { kind: "completed", summary: "old summary", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    const tool = fake.findTool("subagent_resume");
    const result = await tool.execute(
      "t1",
      { sessionPath, name: "Retry", message: "keep going" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.paneId, "w1:p7");
    assert.equal(sidecarsAtLaunch, false, "stale sidecars removed before launch");
    assert.ok(launchedArgv, "agentStart called");
    assert.equal(launchedArgv![0], "bash");

    const script = readFileSync(launchedArgv![1], "utf8");
    assert.match(script, /--session/);
    assert.ok(script.includes(sessionPath), "script resumes the given session");
    assert.match(script, /@.*subagent-resume/, "resume message delivered via @artifact");
    assert.match(script, /PI_SUBAGENT_AUTO_EXIT=1/, "auto-exit defaults to true");

    await waitFor(() => fake.sent.length === 1);
    const { message, options } = fake.sent[0];
    assert.equal(message.customType, "subagent_result");
    assert.match(message.content, /new summary/);
    assert.ok(!message.content.includes("old summary"), "pre-resume entries are excluded");
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  });

  it("reports 'no new output' when the resumed session gained no entries", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const sessionPath = join(fx.root, "child.jsonl");
    writeChildSession(sessionPath, "old summary");

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => ({
        kind: "completed",
        summary: "old summary",
        exitCode: 0,
      }),
      createStream: () => makeFakeStream() as any,
    });

    const tool = fake.findTool("subagent_resume");
    await tool.execute("t1", { sessionPath }, undefined, undefined, fx.ctx);

    await waitFor(() => fake.sent.length === 1);
    assert.match(fake.sent[0].message.content, /without new output/);
  });
});

// ── subagents_list ──────────────────────────────────────────────────────────

describe("index tools: subagents_list", () => {
  it("lists discoverable defs, hiding disable-model-invocation agents", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    writeFileSync(
      join(fx.agentDir, "agents", "worker.md"),
      "---\nname: worker\ndescription: Implements tasks\nmodel: anthropic/claude-sonnet-4-5\n---\nBody\n",
    );
    writeFileSync(
      join(fx.agentDir, "agents", "hidden.md"),
      "---\nname: hidden\ndisable-model-invocation: true\n---\nBody\n",
    );

    const tool = fake.findTool("subagents_list");
    const result = await tool.execute("t1", {}, undefined, undefined, fx.ctx);

    const text = result.content[0].text;
    assert.match(text, /• worker \[anthropic\/claude-sonnet-4-5\] — Implements tasks/);
    assert.ok(!text.includes("hidden"), "disable-model-invocation agents are hidden");
    assert.equal(result.details.agents.length, 1);
  });
});

// ── slim widget ─────────────────────────────────────────────────────────────

describe("index tools: slim widget", () => {
  const now = new Date("2026-07-06T12:10:00Z").getTime();

  it("renders header only with zero agents", () => {
    assert.deepEqual(__test__.renderSubagentWidgetLines([], now), ["Subagents — 0 running"]);
  });

  it("renders one line per agent: elapsed, name, agent, pane", () => {
    const lines = __test__.renderSubagentWidgetLines(
      [makeRunning({ name: "Worker", agent: "worker", paneId: "w1:p4", startTime: now - 75_000 })],
      now,
    );
    assert.deepEqual(lines, [
      "Subagents — 1 running",
      "  01:15  Worker (worker) — pane w1:p4",
    ]);
  });

  it("renders three agents without status labels", () => {
    const lines = __test__.renderSubagentWidgetLines(
      [
        makeRunning({ name: "A", agent: undefined, paneId: "p1", startTime: now - 5_000 }),
        makeRunning({ name: "B", agent: "scout", paneId: "p2", startTime: now - 65_000 }),
        makeRunning({ name: "C", agent: "worker", paneId: "p3", startTime: now - 3_605_000 }),
      ],
      now,
    );
    assert.equal(lines.length, 4);
    assert.equal(lines[0], "Subagents — 3 running");
    assert.equal(lines[1], "  00:05  A — pane p1");
    assert.equal(lines[2], "  01:05  B (scout) — pane p2");
    assert.equal(lines[3], "  60:05  C (worker) — pane p3");
    for (const line of lines) {
      assert.ok(!/stalled|starting|running…|active/.test(line), "no status labels in slim widget");
    }
  });
});

// ── commands ────────────────────────────────────────────────────────────────

describe("index tools: commands", () => {
  it("/iterate always emits a full-context fork tool call", async () => {
    const fake = registerAll();
    const iterate = fake.findCommand("iterate");
    await iterate!.handler("Fix the bug", makeFakeCtx().ctx);

    assert.equal(fake.sentUser.length, 1);
    assert.match(fake.sentUser[0], /fork: true/);
    assert.match(fake.sentUser[0], /name: "Iterate"/);
    assert.match(fake.sentUser[0], /Fix the bug/);
  });

  it("/subagent spawns a named agent with the given task", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    writeFileSync(
      join(fx.agentDir, "agents", "scout.md"),
      "---\nname: scout\nmodel: anthropic/claude-haiku-4-5\n---\nYou scout.\n",
    );

    const cmd = fake.findCommand("subagent");
    await cmd!.handler("scout find the bug", fx.ctx);

    assert.equal(fake.sentUser.length, 1);
    assert.match(fake.sentUser[0], /agent: "scout"/);
    assert.match(fake.sentUser[0], /find the bug/);
  });

  it("/subagent with an unknown agent notifies an error", async () => {
    const fake = registerAll();
    makeFixture();
    const { ctx, notifications } = makeFakeCtx();

    const cmd = fake.findCommand("subagent");
    await cmd!.handler("nonexistent-agent do stuff", ctx);

    assert.equal(fake.sentUser.length, 0);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].message, /not found/);
  });
});
