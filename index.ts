/**
 * pi-herder-subagents — interactive subagent orchestration built natively on herdr.
 *
 * Extension entry: activation guard, tool registration, outcome→steer wiring,
 * slim widget, /subagent + /iterate commands.
 *
 * Activation strategy (PLAN.md Key Decision #3 — tool names collide with
 * pi-interactive-subagents by design, and pi resolves duplicates
 * first-loaded-extension-wins, silently):
 *   - inside herdr (HERDR_ENV=1 + pane id + socket path): register real tools
 *     at load; `session_start` pings the socket and warns visibly if this
 *     extension lost the registry race to another `subagent` provider.
 *   - outside herdr: register nothing at load; on `session_start`, register
 *     setup-hint stubs only when no other extension provides `subagent`.
 *
 * Tool skeletons, descriptions/promptSnippets, self-spawn block, and command
 * handlers ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/index.ts @ fix/launch-verify-retry, adapted for herdr
 * (argv launch via src/launch.ts + herdr client, no mux/screen-scrape code).
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentDefaults } from "./src/agents.ts";
import { createHerdrClient, type HerdrClient } from "./src/herdr/client.ts";
import { createHerdrEventStream } from "./src/herdr/events.ts";
import { buildLaunchPlan } from "./src/launch.ts";
import {
  buildOutcomeMessage,
  renderSubagentPing,
  renderSubagentResult,
} from "./src/messages.ts";
import { seedSubagentSessionFile } from "./src/session.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
  type WatcherDeps,
} from "./src/watcher.ts";

/** Absolute path of this module — used to detect losing the tool-registry race. */
const MODULE_PATH = fileURLToPath(import.meta.url);

// ── /reload safety ──────────────────────────────────────────────────────────
// /reload re-imports this file, giving fresh module-level state, but closures
// from the old module keep running. Abort the previous module's controllers and
// close its event stream on re-import (pattern from the reference, issue #5).

const ABORT_KEY = Symbol.for("pi-herder-subagents/abort-controller");
const STREAM_KEY = Symbol.for("pi-herder-subagents/event-stream");
const WIDGET_INTERVAL_KEY = Symbol.for("pi-herder-subagents/widget-interval");

{
  const prevAbort = (globalThis as any)[ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[ABORT_KEY] = new AbortController();

  const prevStream = (globalThis as any)[STREAM_KEY] as { close(): void } | undefined;
  if (prevStream) prevStream.close();
  (globalThis as any)[STREAM_KEY] = null;

  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) clearInterval(prevInterval);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[ABORT_KEY] as AbortController).signal;
}

// ── injectable runtime deps (unit-test seam) ────────────────────────────────

type WatcherStream = WatcherDeps["stream"] & { close(): void };

interface RuntimeDeps {
  client: HerdrClient;
  watch: typeof watchSubagent;
  createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

function defaultDeps(): RuntimeDeps {
  return {
    client: createHerdrClient(),
    watch: watchSubagent,
    createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
  };
}

let deps: RuntimeDeps = defaultDeps();

/**
 * One shared HerdrEventStream per pi process (PLAN.md Key Decision #8),
 * created lazily on first spawn — no persistent socket while zero subagents
 * have ever run. Closed via the module AbortController on /reload + shutdown.
 */
function getEventStream(): WatcherStream {
  let stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
  if (!stream) {
    stream = deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal());
    (globalThis as any)[STREAM_KEY] = stream;
  }
  return stream;
}

// ── shared module state ─────────────────────────────────────────────────────

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

// ── slim widget (PLAN.md Key Decision #9: name/agent/elapsed/count only) ────

function formatElapsedMMSS(startTime: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderSubagentWidgetLines(
  agents: Array<Pick<RunningSubagent, "name" | "agent" | "paneId" | "startTime">>,
  now = Date.now(),
): string[] {
  const lines = [`Subagents — ${agents.length} running`];
  for (const agent of agents) {
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    lines.push(`  ${formatElapsedMMSS(agent.startTime, now)}  ${agent.name}${agentTag} — pane ${agent.paneId}`);
  }
  return lines;
}

function stopWidgetRefresh(): void {
  const interval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (interval) clearInterval(interval);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

function updateWidget(): void {
  if (runningSubagents.size === 0) {
    stopWidgetRefresh();
    if (latestCtx?.hasUI) latestCtx.ui.setWidget("herder-subagents", undefined);
    return;
  }
  if (!latestCtx?.hasUI) return;
  latestCtx.ui.setWidget(
    "herder-subagents",
    renderSubagentWidgetLines([...runningSubagents.values()]),
    { placement: "aboveEditor" },
  );
}

/** 1s refresh only while subagents are running; cleared at zero / shutdown / reload. */
function startWidgetRefresh(): void {
  updateWidget();
  if ((globalThis as any)[WIDGET_INTERVAL_KEY] || runningSubagents.size === 0) return;
  (globalThis as any)[WIDGET_INTERVAL_KEY] = setInterval(updateWidget, 1000);
}

// ── watcher arming + outcome→steer wiring ───────────────────────────────────

function armWatcher(
  pi: ExtensionAPI,
  running: RunningSubagent,
  mapOutcome?: (outcome: SubagentOutcome) => SubagentOutcome,
): void {
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  const moduleSignal = getModuleAbortSignal();
  const onModuleAbort = () => watcherAbort.abort();
  moduleSignal.addEventListener("abort", onModuleAbort, { once: true });

  runningSubagents.set(running.id, running);
  startWidgetRefresh();

  void deps
    .watch(running, {
      client: deps.client,
      stream: getEventStream(),
      signal: watcherAbort.signal,
    })
    .then((outcome) => {
      runningSubagents.delete(running.id);
      updateWidget();
      const message = buildOutcomeMessage(running, mapOutcome ? mapOutcome(outcome) : outcome);
      if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    })
    .catch((err: any) => {
      runningSubagents.delete(running.id);
      updateWidget();
      pi.sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message ?? String(err) },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .finally(() => {
      moduleSignal.removeEventListener("abort", onModuleAbort);
    });
}

// ── tool parameter schema (ported, minus Claude-only resumeSessionId) ───────

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
    }),
  ),
});

const SUBAGENT_DESCRIPTION =
  "Spawn a sub-agent in a dedicated herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate, assume, or summarize results after calling this tool. " +
  "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";

// ── setup-hint stubs (outside herdr, no other subagent provider) ────────────

const SETUP_HINT =
  "Subagents require pi to run inside a herdr pane (https://github.com/ogulcancelik/herdr). " +
  "Start herdr in your terminal, open a pane, and run pi there — herdr injects HERDR_ENV, " +
  "HERDR_PANE_ID, and HERDR_SOCKET_PATH into every pane, which this extension needs to " +
  "launch and observe subagents. Install herdr ≥ 0.7.1 and restart pi inside it.";

const SPAWN_TOOL_NAMES = ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"];

function registerSetupHintStubs(pi: ExtensionAPI, shouldRegister: (name: string) => boolean): void {
  for (const name of SPAWN_TOOL_NAMES) {
    if (!shouldRegister(name)) continue;
    pi.registerTool({
      name,
      label: "Subagents (setup required)",
      description: SETUP_HINT,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute() {
        return {
          content: [{ type: "text", text: SETUP_HINT }],
          details: { error: "not in herdr" },
        };
      },
    });
  }
}

// ── subagent spawn ──────────────────────────────────────────────────────────

function errorResult(text: string, error: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error },
  };
}

async function executeSubagentSpawn(
  pi: ExtensionAPI,
  params: typeof SubagentParams.static,
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
  },
) {
  // Prevent self-spawning (e.g. planner spawning another planner)
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  if (params.agent && currentAgent && params.agent === currentAgent) {
    return errorResult(
      `You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
        `You were spawned to do this work yourself. Complete the task directly.`,
      "self-spawn blocked",
    );
  }

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    return errorResult(
      "Error: no session file. Start pi with a persistent session to use subagents.",
      "no session file",
    );
  }

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;

  let plan;
  try {
    plan = buildLaunchPlan(params, agentDefs, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile,
      parentCwd: ctx.cwd,
      env: process.env,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan subagent launch: ${message}`, message);
  }

  // Execute the plan: write artifacts, seed the child session, start the pane.
  for (const file of plan.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
  }
  if (plan.seedSession) {
    seedSubagentSessionFile(plan.seedSession);
  }

  let started;
  try {
    started = await deps.client.agentStart(plan.agentStart);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to start herdr pane for "${params.name}": ${message}`, message);
  }

  const running: RunningSubagent = {
    id: plan.id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    paneId: started.paneId,
    startTime: Date.now(),
    sessionFile: plan.sessionFile,
    launchScriptFile: plan.launchScriptFile,
    interactive: plan.interactive,
    autoExit: plan.autoExit,
  };
  armWatcher(pi, running);

  return {
    content: [
      {
        type: "text" as const,
        text:
          `Sub-agent "${params.name}" launched and is now running in the background. ` +
          `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
          `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
          `Until then, move on to other work or tell the user you're waiting.`,
      },
    ],
    details: {
      id: running.id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      paneId: running.paneId,
      sessionFile: running.sessionFile,
      launchScriptFile: running.launchScriptFile,
      status: "started",
    },
  };
}

function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: SUBAGENT_DESCRIPTION,
    promptSnippet: SUBAGENT_DESCRIPTION,
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentSpawn(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const partialArgs = args as Record<string, unknown>;
      const name =
        typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
      const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
      const agent =
        typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
      const cwdHint =
        typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
      let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

      // Show a one-line task preview. renderCall is called repeatedly as the
      // LLM generates tool arguments, so args.task grows token by token.
      if (task) {
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview);
        }
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";

      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — started"),
          0,
          0,
        );
      }

      const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── extension entry ─────────────────────────────────────────────────────────

export default function herderSubagents(pi: ExtensionAPI) {
  const inHerdr = isInsideHerdr();

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const shouldRegister = (name: string) => !deniedTools.has(name);

  let registeredRealTools = false;
  if (inHerdr) {
    if (shouldRegister("subagent")) registerSubagentTool(pi);
    registeredRealTools = true;
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;

    if (!inHerdr) {
      // Defer: only provide setup-hint stubs when nothing else provides
      // `subagent` (i.e. pi-interactive-subagents is not loaded).
      const hasSubagent = pi.getAllTools().some((tool) => tool.name === "subagent");
      if (!hasSubagent) registerSetupHintStubs(pi, shouldRegister);
      return;
    }

    // Inside herdr but lost the registry race (loaded after another provider):
    // warn visibly — never fail silently (PLAN.md Key Decision #3).
    if (registeredRealTools && shouldRegister("subagent")) {
      const winner = pi.getAllTools().find((tool) => tool.name === "subagent");
      if (winner?.sourceInfo?.path && winner.sourceInfo.path !== MODULE_PATH) {
        ctx.ui.notify(
          `pi-herder-subagents: another extension's "subagent" tool won the registry race ` +
            `(${winner.sourceInfo.path}). List pi-herder-subagents BEFORE pi-interactive-subagents ` +
            `in your packages to use the herdr-native tools.`,
          "warning",
        );
      }
    }

    // Socket reachability check (async; visible notify on failure).
    void deps.client
      .ping()
      .then((res) => {
        if (!res.ok) {
          ctx.ui.notify(
            "pi-herder-subagents: the herdr server is not reachable from this pane — " +
              "subagent spawns will fail. Is the herdr session still running?",
            "warning",
          );
        }
      })
      .catch((error: any) => {
        ctx.ui.notify(
          `pi-herder-subagents: herdr ping failed: ${error?.message ?? String(error)}`,
          "warning",
        );
      });
  });

  pi.on("session_shutdown", () => {
    stopWidgetRefresh();
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
    }
    runningSubagents.clear();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
  });

  // Steer message renderers (registered regardless of activation so past
  // session entries still render outside herdr).
  pi.registerMessageRenderer("subagent_result", (message, options, theme) =>
    renderSubagentResult(message as any, options, theme as any),
  );
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) =>
    renderSubagentPing(message as any, options, theme as any),
  );
}

// ── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
  isInsideHerdr,
  runningSubagents,
  renderSubagentWidgetLines,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
    }
    runningSubagents.clear();
    latestCtx = null;
    stopWidgetRefresh();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
    (globalThis as any)[ABORT_KEY] = new AbortController();
  },
};
