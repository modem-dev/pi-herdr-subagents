import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
  const handlers = new Map<string, Function[]>();
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
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
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
    fire(event: string, eventObj: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(eventObj, ctx);
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
    async paneStart() {
      return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
    },
    async paneRename() {},
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
    writeFileSync(
      `${sessionPath}.context-usage`,
      JSON.stringify({
        version: 1,
        subagentId: "previous-resume",
        tokens: 99,
        contextWindow: 100,
        percent: 99,
      }),
    );

    let sidecarsAtLaunch: boolean | null = null;
    let launchedArgv: string[] | null = null;
    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async (p: any) => {
          sidecarsAtLaunch =
            existsSync(`${sessionPath}.exit`) ||
            existsSync(`${sessionPath}.exitcode`) ||
            existsSync(`${sessionPath}.context-usage`);
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
    assert.ok(launchedArgv, "paneStart called");
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

// ── polished widget ─────────────────────────────────────────────────────────

describe("index tools: polished widget", () => {
  const now = new Date("2026-07-06T12:10:00Z").getTime();

  function assertLinesFitWidth(lines: string[], width: number): void {
    assert.ok(lines.length >= 2, "widget renders at least top and bottom borders");
    for (const line of lines) {
      assert.equal(line.length, width, `expected ${JSON.stringify(line)} to fit ${width} cols`);
      assert.ok(line.length <= width, `expected ${JSON.stringify(line)} not to exceed ${width} cols`);
    }
  }

  function renderCapturedWidget(widget: any, width: number): string[] {
    assert.equal(typeof widget, "function", "widget must be a width-aware renderer factory");
    const rendered = widget({}, {});
    assert.equal(typeof rendered.render, "function", "widget renderer must expose render(width)");
    return rendered.render(width);
  }

  async function captureRunningWidget() {
    const fake = registerAll();
    const fx = makeFixture();
    writeFileSync(
      join(fx.agentDir, "agents", "scout.md"),
      "---\nname: scout\nauto-exit: true\n---\nScout the codebase.\n",
    );
    const widgets: Array<{ id: string; widget: any; options: any }> = [];
    (fx.ctx as any).hasUI = true;
    (fx.ctx as any).ui.setWidget = (id: string, widget: any, options: any) => {
      widgets.push({ id, widget, options });
    };

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (_running: any, watchDeps: any): Promise<SubagentOutcome> =>
        new Promise((resolve) => {
          watchDeps.signal.addEventListener("abort", () => resolve({ kind: "cancelled" }), {
            once: true,
          });
        }),
      createStream: () => makeFakeStream() as any,
    });

    fake.fire("session_start", {}, fx.ctx);
    const tool = fake.findTool("subagent");
    await tool.execute(
      "t1",
      {
        name: "Count sheep with a long enough name to need truncation",
        task: "count sheep",
        agent: "scout",
      },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.ok(widgets.length > 0, "spawn publishes the status widget");
    return widgets.at(-1)!;
  }

  it("publishes a width-aware widget renderer that fits a 60-column terminal", async () => {
    const { id, widget } = await captureRunningWidget();

    assert.equal(id, "herdr-subagents");
    const lines = renderCapturedWidget(widget, 60);
    assertLinesFitWidth(lines, 60);
  });

  it("re-renders after resize from 80 to 60 columns without overflowing", async () => {
    const { widget } = await captureRunningWidget();

    assertLinesFitWidth(renderCapturedWidget(widget, 80), 80);
    assertLinesFitWidth(renderCapturedWidget(widget, 60), 60);
  });

  it("renders an adaptive boxed border with the running count in the header", () => {
    const lines = __test__.renderSubagentWidgetLines([], now, 44);

    assert.equal(lines.length, 2);
    assert.match(lines[0], /^╭─ Subagents ─+ 0 running ─╮$/);
    assert.equal(lines[1], `╰${"─".repeat(42)}╯`);
    assert.ok(lines.every((line) => line.length === 44));
  });

  it("renders rows with elapsed, name, agent, and right-aligned herdr status", () => {
    const lines = __test__.renderSubagentWidgetLines(
      [
        { ...makeRunning({ name: "A", agent: "scout", paneId: "p1", startTime: now - 5_000 }), agentStatus: "working" },
        { ...makeRunning({ name: "Database audit", agent: "worker", paneId: "p2", startTime: now - 65_000 }), agentStatus: "blocked" },
      ],
      now,
      64,
    );

    assert.equal(lines.length, 4);
    assert.match(lines[0], /^╭─ Subagents ─+ 2 running ─╮$/);
    assert.match(lines[1], /^│ 00:05  A \(scout\)\s+working · 00:05 │$/);
    assert.match(lines[2], /^│ 01:05  Database audit \(worker\)\s+blocked · 01:05 │$/);
    assert.equal(lines[3], `╰${"─".repeat(62)}╯`);
    assert.ok(lines.every((line) => line.length === 64));
  });

  it("adapts to narrow widths by truncating names while preserving right-aligned status", () => {
    const lines = __test__.renderSubagentWidgetLines(
      [
        {
          ...makeRunning({
            name: "Very long subagent display name that must fit",
            agent: "worker",
            paneId: "p3",
            startTime: now - 3_605_000,
          }),
          agentStatus: "done",
        },
      ],
      now,
      42,
    );

    assert.ok(lines.every((line) => line.length === 42));
    assert.match(lines[1], /^│ .+…\s+done · 60:05 │$/);
  });
});

// ── commands ────────────────────────────────────────────────────────────────

describe("index tools: commands", () => {
  const templateNames = ["worker.md", "planner.md", "scout.md", "reviewer.md"].sort();

  it("/subagents-init defaults to global and installs all four templates", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    const cmd = fake.findCommand("subagents-init");
    assert.ok(cmd, "expected /subagents-init to be registered");
    await cmd.handler("", fx.ctx);

    assert.deepEqual(readdirSync(join(fx.agentDir, "agents")).sort(), templateNames);
    assert.equal(fx.notifications.length, 1);
    assert.match(fx.notifications[0].message, /Installed.*worker\.md.*planner\.md.*scout\.md.*reviewer\.md/s);
  });

  it("/subagents-init global explicitly installs into PI_CODING_AGENT_DIR", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    await fake.findCommand("subagents-init")!.handler("global", fx.ctx);

    assert.deepEqual(readdirSync(join(fx.agentDir, "agents")).sort(), templateNames);
    assert.equal(existsSync(join(fx.cwd, ".pi", "agents")), false);
  });

  it("/subagents-init project installs only into the command cwd", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    await fake.findCommand("subagents-init")!.handler("project", fx.ctx);

    assert.deepEqual(readdirSync(join(fx.cwd, ".pi", "agents")).sort(), templateNames);
    assert.deepEqual(readdirSync(join(fx.agentDir, "agents")), []);
  });

  it("/subagents-init skips existing files and symlinks without modifying them", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const agentsDir = join(fx.agentDir, "agents");
    const workerPath = join(agentsDir, "worker.md");
    const reviewerPath = join(agentsDir, "reviewer.md");
    const symlinkTarget = join(fx.root, "custom-reviewer.md");
    writeFileSync(workerPath, "custom worker bytes\n");
    writeFileSync(symlinkTarget, "custom reviewer bytes\n");
    symlinkSync(symlinkTarget, reviewerPath);

    await fake.findCommand("subagents-init")!.handler("global", fx.ctx);

    assert.equal(readFileSync(workerPath, "utf8"), "custom worker bytes\n");
    assert.equal(readFileSync(symlinkTarget, "utf8"), "custom reviewer bytes\n");
    assert.match(fx.notifications[0].message, /Skipped.*worker\.md.*reviewer\.md/s);
    assert.deepEqual(readdirSync(agentsDir).sort(), templateNames);
  });

  it("/subagents-init is idempotent and reports all files skipped on the second run", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    const cmd = fake.findCommand("subagents-init")!;

    await cmd.handler("global", fx.ctx);
    const before = Object.fromEntries(
      templateNames.map((name) => [name, readFileSync(join(fx.agentDir, "agents", name), "utf8")]),
    );
    await cmd.handler("global", fx.ctx);

    const after = Object.fromEntries(
      templateNames.map((name) => [name, readFileSync(join(fx.agentDir, "agents", name), "utf8")]),
    );
    assert.deepEqual(after, before);
    assert.match(fx.notifications[1].message, /Skipped.*worker\.md.*planner\.md.*scout\.md.*reviewer\.md/s);
  });

  it("/subagents-init rejects invalid arguments without copying anything", async () => {
    const fake = registerAll();
    const fx = makeFixture();

    await fake.findCommand("subagents-init")!.handler("somewhere", fx.ctx);

    assert.deepEqual(readdirSync(join(fx.agentDir, "agents")), []);
    assert.equal(existsSync(join(fx.cwd, ".pi", "agents")), false);
    assert.deepEqual(fx.notifications, [
      { message: "Usage: /subagents-init [global|project]", type: "error" },
    ]);
  });

  it("/subagents-init autocomplete has exact labels and prefix filtering", () => {
    const fake = registerAll();
    const complete = fake.findCommand("subagents-init")!.getArgumentCompletions;
    const expected = [
      {
        value: "global",
        label: "global",
        description: "copy example agent defs to ~/.pi/agent/agents",
      },
      {
        value: "project",
        label: "project",
        description: "copy example agent defs to .pi/agents",
      },
    ];

    assert.deepEqual(complete(""), expected);
    assert.deepEqual(complete("g"), [expected[0]]);
    assert.deepEqual(complete("pro"), [expected[1]]);
    assert.equal(complete("x"), null);
  });

  it("subagent tool rejects an explicitly named missing agent before launch", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    let launchCount = 0;
    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async () => {
          launchCount += 1;
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
    });

    const result = await fake.findTool("subagent").execute(
      "t1",
      { name: "Missing", task: "do work", agent: "missing" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.error, "agent not found");
    assert.match(result.content[0].text, /Agent "missing" not found/);
    assert.match(result.content[0].text, /\.pi\/agents/);
    assert.equal(launchCount, 0);
  });

  it("subagent tool still permits a spawn with no agent", async () => {
    const fake = registerAll();
    const fx = makeFixture();
    let launchCount = 0;
    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async () => {
          launchCount += 1;
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (): Promise<SubagentOutcome> => ({ kind: "cancelled" }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await fake.findTool("subagent").execute(
      "t1",
      { name: "Generic", task: "do work" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(launchCount, 1);
  });

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
