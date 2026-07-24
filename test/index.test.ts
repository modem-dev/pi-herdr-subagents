import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import herdrSubagents, { __test__ } from "../index.ts";
import { getActiveSubagentCount } from "../src/runtime-state.ts";
import type { SubagentOutcome } from "../src/watcher.ts";

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

// ── env management ─────────────────────────────────────────────────────────
// These tests may themselves run inside herdr / a subagent — always set or
// delete every relevant key explicitly, and restore afterwards.

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

interface FakeToolInfo {
  name: string;
  sourceInfo?: { path: string };
}

function createFakePi(opts?: { allTools?: FakeToolInfo[] }) {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const renderers = new Map<string, unknown>();
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];
  let allTools: FakeToolInfo[] | null = opts?.allTools ?? null;

  const api: any = {
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
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
    getAllTools(): FakeToolInfo[] {
      if (allTools) return allTools;
      return registeredTools.map((t) => ({ name: t.name, sourceInfo: { path: INDEX_PATH } }));
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  return {
    api,
    registeredTools,
    commands,
    renderers,
    sent,
    sentUser,
    setAllTools(tools: FakeToolInfo[]) {
      allTools = tools;
    },
    toolNames(): string[] {
      return registeredTools.map((t) => t.name);
    },
    findTool(name: string) {
      return registeredTools.find((t) => t.name === name);
    },
    fire(event: string, eventObj: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(eventObj, ctx);
    },
  };
}

function makeFakeCtx(overrides?: {
  cwd?: string;
  sessionFile?: string | null;
  sessionDir?: string;
  sessionId?: string;
}) {
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
      getSessionFile: () =>
        overrides?.sessionFile !== undefined ? overrides.sessionFile : "/tmp/orch.jsonl",
      getSessionId: () => overrides?.sessionId ?? "orch-session-id",
      getSessionDir: () => overrides?.sessionDir ?? "/tmp/orch-sessions",
    },
  };
  return { ctx, notifications };
}

function makeFakeClient(overrides?: Partial<Record<string, Function>>) {
  return {
    async paneStart() {
      return { paneId: "w1:p9", terminalId: "term1", workspaceId: "w1", tabId: "t1" };
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

// ── fixture for real-launch-plan spawns ────────────────────────────────────

function makeSpawnFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-index-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent-config");
  mkdirSync(agentDir, { recursive: true });
  const sessionDir = join(root, "orch-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const parentSessionFile = join(sessionDir, "parent.jsonl");
  writeFileSync(parentSessionFile, JSON.stringify({ type: "session", version: 3, id: "p1" }) + "\n");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";

  const { ctx, notifications } = makeFakeCtx({
    cwd,
    sessionFile: parentSessionFile,
    sessionDir,
    sessionId: "orch-session-id",
  });
  return { root, cwd, agentDir, sessionDir, parentSessionFile, ctx, notifications };
}

// ── activation guard ───────────────────────────────────────────────────────

describe("index: activation guard", () => {
  it("not inside herdr → no tools registered at load", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.deepEqual(fake.toolNames(), []);
  });

  it("inside herdr → subagent tool registered at load", () => {
    envInsideHerdr();
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.toolNames().includes("subagent"));
  });

  it("outside herdr: session_start registers setup-hint stubs when no subagent tool exists", async () => {
    const fake = createFakePi({ allTools: [] });
    herdrSubagents(fake.api);
    assert.deepEqual(fake.toolNames(), []);

    const { ctx } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    const stub = fake.findTool("subagent");
    assert.ok(stub, "expected a subagent setup-hint stub");
    const result = await stub.execute("t1", { name: "X", task: "y" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /herdr/i);
    assert.equal(result.details.error, "not in herdr");
  });

  it("outside herdr: stays silent when another extension already provides subagent", () => {
    const fake = createFakePi({
      allTools: [{ name: "subagent", sourceInfo: { path: "/other/pi-interactive-subagents/index.ts" } }],
    });
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    assert.deepEqual(fake.toolNames(), []);
    assert.deepEqual(notifications, []);
  });

  it("PI_DENY_TOOLS=subagent suppresses registration inside herdr", () => {
    envInsideHerdr();
    process.env.PI_DENY_TOOLS = "subagent";
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(!fake.toolNames().includes("subagent"));
    // other spawning tools are gated individually, not as a block
    assert.ok(fake.toolNames().includes("subagent_interrupt"));
    assert.ok(fake.toolNames().includes("subagents_list"));
  });

  it("inside herdr but lost the registry race → visible session_start warning", () => {
    envInsideHerdr();
    __test__.setDeps({ client: makeFakeClient() });
    const fake = createFakePi();
    herdrSubagents(fake.api);

    fake.setAllTools([
      { name: "subagent", sourceInfo: { path: "/other/pi-interactive-subagents/index.ts" } },
    ]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    const warning = notifications.find((n) => n.type === "warning");
    assert.ok(warning, "expected a visible warning notify");
    assert.match(warning.message, /pi-herdr-subagents/);
    assert.match(warning.message, /before/i);
  });

  it("inside herdr and won the race → no warning", () => {
    envInsideHerdr();
    __test__.setDeps({ client: makeFakeClient() });
    const fake = createFakePi();
    herdrSubagents(fake.api);

    fake.setAllTools([{ name: "subagent", sourceInfo: { path: INDEX_PATH } }]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    assert.deepEqual(
      notifications.filter((n) => n.type === "warning"),
      [],
    );
  });

  it("inside herdr with unreachable socket → visible notify from session_start ping", async () => {
    envInsideHerdr();
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: false, version: null, protocol: null }),
      }),
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.length > 0);
    assert.match(notifications[0].message, /herdr/i);
  });
});

// ── subagent tool execute ──────────────────────────────────────────────────

describe("index: subagent tool", () => {
  function registerAndGetTool() {
    envInsideHerdr();
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const tool = fake.findTool("subagent");
    assert.ok(tool, "subagent tool must be registered");
    return { fake, tool };
  }

  it("self-spawn is blocked", async () => {
    const { tool } = registerAndGetTool();
    process.env.PI_SUBAGENT_AGENT = "worker";
    const { ctx } = makeFakeCtx();

    const result = await tool.execute(
      "t1",
      { name: "Worker 2", task: "do it", agent: "worker" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "self-spawn blocked");
    assert.match(result.content[0].text, /worker/);
  });

  it("requires a persistent session file", async () => {
    const { tool } = registerAndGetTool();
    const { ctx } = makeFakeCtx({ sessionFile: null });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "no session file");
  });

  it("spawn: writes plan files, starts herdr agent, returns fire-and-forget ack", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    const paneStartCalls: any[] = [];
    let watchedStream: unknown = null;
    const fakeStream = makeFakeStream();
    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async (p: any) => {
          paneStartCalls.push(p);
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (_running: any, deps: any): Promise<SubagentOutcome> => {
        watchedStream = deps.stream;
        return { kind: "completed", summary: "did the thing", exitCode: 0 };
      },
      createStream: () => fakeStream as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.paneId, "w1:p9");
    assert.equal(result.details.name, "Worker");
    assert.ok(result.details.sessionFile.endsWith(".jsonl"));
    assert.ok(existsSync(result.details.launchScriptFile), "launch script written to disk");
    assert.match(result.content[0].text, /launched and is now running/);

    // argv launch through the client
    assert.equal(paneStartCalls.length, 1);
    assert.deepEqual(paneStartCalls[0].argv, ["bash", result.details.launchScriptFile]);

    // watcher armed against the shared event stream
    await waitFor(() => watchedStream !== null);
    assert.equal(watchedStream, fakeStream);
  });

  it("outcome wiring: completed outcome → subagent_result steer wakes the orchestrator", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.context-usage`,
          JSON.stringify({
            version: 1,
            subagentId: running.id,
            tokens: 75_000,
            contextWindow: 200_000,
            percent: 37.5,
          }),
        );
        return {
          kind: "completed",
          summary: "did the thing",
          exitCode: 0,
        };
      },
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1);

    const { message, options } = fake.sent[0];
    assert.equal(message.customType, "subagent_result");
    assert.match(message.content, /completed/);
    assert.match(message.content, /did the thing/);
    assert.match(message.content, /Context: 75,000\/200,000 tokens/);
    assert.deepEqual(message.details.contextUsage, {
      version: 1,
      subagentId: result.details.id,
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
    assert.equal(
      existsSync(`${result.details.sessionFile}.context-usage`),
      false,
      "telemetry is consumed after the terminal outcome",
    );
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(__test__.runningSubagents.size, 0);
  });

  it("rejects and removes stale context usage from another resume id", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let telemetryPath = "";
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        telemetryPath = `${running.sessionFile}.context-usage`;
        writeFileSync(
          telemetryPath,
          JSON.stringify({
            version: 1,
            subagentId: "previous-launch-id",
            tokens: 90_000,
            contextWindow: 100_000,
            percent: 90,
          }),
        );
        return { kind: "completed", summary: "done", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => fake.sent.length === 1);

    assert.doesNotMatch(fake.sent[0].message.content, /Context:/);
    assert.equal("contextUsage" in fake.sent[0].message.details, false);
    assert.equal(existsSync(telemetryPath), false, "stale telemetry is consumed");
  });

  it("publishes the active watcher count for nested orchestrator auto-exit", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let settle!: (outcome: SubagentOutcome) => void;
    const pending = new Promise<SubagentOutcome>((resolve) => {
      settle = resolve;
    });
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async () => pending,
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    assert.equal(getActiveSubagentCount(), 1);

    settle({ kind: "completed", summary: "done", exitCode: 0 });
    await waitFor(() => __test__.runningSubagents.size === 0);
    assert.equal(getActiveSubagentCount(), 0);
  });

  it("cancelled outcome sends no steer message", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let watched = false;
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => {
        watched = true;
        return { kind: "cancelled" };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => watched && __test__.runningSubagents.size === 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.sent.length, 0);
  });

  it("paneStart failure returns an error result and registers nothing", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async () => {
          throw new Error("connection refused");
        },
      }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /connection refused/);
    assert.ok(result.details.error);
    assert.equal(__test__.runningSubagents.size, 0);
    assert.equal(fake.sent.length, 0);
  });

  it("unsupported cli agent def returns a clear error", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    mkdirSync(join(fx.agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(fx.agentDir, "agents", "claudey.md"),
      "---\nname: claudey\ncli: claude\n---\nBody\n",
    );

    __test__.setDeps({ client: makeFakeClient(), createStream: () => makeFakeStream() as any });

    const result = await tool.execute(
      "t1",
      { name: "C", task: "x", agent: "claudey" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /not supported/);
  });
});

// ── steer message renderers ────────────────────────────────────────────────

describe("index: renderers", () => {
  it("registers subagent_result and subagent_ping renderers", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.renderers.has("subagent_result"));
    assert.ok(fake.renderers.has("subagent_ping"));
  });
});
