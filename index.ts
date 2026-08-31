/**
 * pi-herdr-subagents — interactive subagent orchestration built natively on herdr.
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
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverAgentDefinitions,
  getAgentConfigDir,
  loadAgentDefaults,
} from "./src/agents.ts";
import {
  createHerdrClient,
  HERDR_PLUGIN_ID,
  MIN_HERDR_VERSION,
  type HerdrClient,
} from "./src/herdr/client.ts";
import { createHerdrEventStream } from "./src/herdr/events.ts";
import { consumeContextUsageSidecar, contextUsagePath } from "./src/context-usage.ts";
import {
  buildLaunchPlan,
  buildResumeLaunchPlan,
  resolveResumeLaunchBehavior,
} from "./src/launch.ts";
import {
  buildOutcomeMessage,
  renderSubagentPing,
  renderSubagentResult,
} from "./src/messages.ts";
import { markSubagentActive, markSubagentInactive } from "./src/runtime-state.ts";
import { findLastAssistantMessage, getNewEntries, seedSubagentSessionFile } from "./src/session.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
  type WatcherDeps,
} from "./src/watcher.ts";

/** Absolute path of this module — used to detect losing the tool-registry race. */
const MODULE_PATH = fileURLToPath(import.meta.url);
const HERDR_PLUGIN_DIR = join(dirname(MODULE_PATH), "herdr-plugin");

// ── /reload safety ──────────────────────────────────────────────────────────
// /reload re-imports this file, giving fresh module-level state, but closures
// from the old module keep running. Abort the previous module's controllers and
// close its event stream on re-import (pattern from the reference, issue #5).

const ABORT_KEY = Symbol.for("pi-herdr-subagents/abort-controller");
const STREAM_KEY = Symbol.for("pi-herdr-subagents/event-stream");
const WIDGET_INTERVAL_KEY = Symbol.for("pi-herdr-subagents/widget-interval");

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
let capabilityCheck: Promise<string | null> | null = null;

function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (value: string): number[] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let i = 0; i < 3; i += 1) {
    if (actualParts[i] !== minimumParts[i]) return actualParts[i] > minimumParts[i];
  }
  return true;
}

async function checkHerdrCapability(): Promise<string | null> {
  const status = await deps.client.ping();
  if (!status.ok) {
    return (
      "the herdr server is not reachable from this pane. " +
      "Is the herdr session still running?"
    );
  }
  if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
    return (
      `herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes ` +
      `(found ${status.version ?? "unknown"}). Update herdr, then restart its session.`
    );
  }

  const plugin = await deps.client.pluginGet(HERDR_PLUGIN_ID);
  if (!plugin) {
    return (
      `the Herdr plugin is not linked. Run: herdr plugin link "${HERDR_PLUGIN_DIR}" --enabled`
    );
  }
  if (!plugin.enabled) {
    return `the Herdr plugin is disabled. Run: herdr plugin enable ${HERDR_PLUGIN_ID}`;
  }
  return null;
}

async function ensureHerdrCapability(): Promise<string | null> {
  const check = capabilityCheck ??= checkHerdrCapability();
  try {
    const message = await check;
    // Allow an in-place setup fix (link/enable/update) to be detected by the
    // next attempt without requiring a pi reload. Successful checks stay cached.
    if (message && capabilityCheck === check) capabilityCheck = null;
    return message;
  } catch (error) {
    if (capabilityCheck === check) capabilityCheck = null;
    throw error;
  }
}

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

/** Last herdr agent_status seen per pane; refreshed opportunistically for the widget. */
const latestAgentStatuses = new Map<string, string>();

export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

// ── polished widget (boxed, width-aware running-subagent status) ────────────

type WidgetAgent = Pick<RunningSubagent, "name" | "agent" | "paneId" | "startTime"> & {
  agentStatus?: string;
};

function formatElapsedMMSS(startTime: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function truncateToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 0) return "";
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function normalizeWidgetWidth(width: number): number {
  if (!Number.isFinite(width)) return process.stdout.columns ?? 80;
  return Math.max(0, Math.floor(width));
}

function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "│";

  const innerWidth = Math.max(0, width - 2);
  const rightWidth = right.length;

  if (rightWidth >= innerWidth) {
    return `│${truncateToWidth(right, innerWidth).padEnd(innerWidth)}│`;
  }

  const truncatedLeft = truncateToWidth(left, innerWidth - rightWidth);
  const gap = " ".repeat(Math.max(0, innerWidth - truncatedLeft.length - rightWidth));
  return `│${truncatedLeft}${gap}${right}│`;
}

function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";

  const innerWidth = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, innerWidth - titlePart.length - infoPart.length));
  const inner = `${titlePart}${fill}${infoPart}`.slice(0, innerWidth).padEnd(innerWidth, "─");
  return `╭${inner}╮`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

export function renderSubagentWidgetLines(
  agents: WidgetAgent[],
  now = Date.now(),
  width = process.stdout.columns ?? 80,
): string[] {
  const widgetWidth = normalizeWidgetWidth(width);
  const lines = [borderTop("Subagents", `${agents.length} running`, widgetWidth)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime, now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag}`;
    const status = agent.agentStatus?.trim() || "working";
    const right = ` ${status} · ${elapsed} `;
    lines.push(borderLine(left, right, widgetWidth));
  }

  lines.push(borderBottom(widgetWidth));
  return lines;
}

function stopWidgetRefresh(): void {
  const interval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (interval) clearInterval(interval);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
}

function getWidgetAgents(): WidgetAgent[] {
  return [...runningSubagents.values()].map((agent) => ({
    ...agent,
    agentStatus: latestAgentStatuses.get(agent.paneId),
  }));
}

function setWidgetFromCurrentState(): void {
  latestCtx?.ui.setWidget(
    "herdr-subagents",
    (_tui: unknown, _theme: unknown) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderSubagentWidgetLines(getWidgetAgents(), Date.now(), width);
      },
    }),
    { placement: "aboveEditor" },
  );
}

async function refreshWidgetStatuses(): Promise<void> {
  try {
    const panes = await deps.client.paneList();
    latestAgentStatuses.clear();
    for (const pane of panes) {
      if (typeof pane.agent_status === "string" && pane.agent_status.trim()) {
        latestAgentStatuses.set(pane.pane_id, pane.agent_status.trim());
      }
    }
    if (runningSubagents.size > 0 && latestCtx?.hasUI) setWidgetFromCurrentState();
  } catch {
    // The widget is best-effort; watcher reconciliation remains the source of truth.
  }
}

function updateWidget(): void {
  if (runningSubagents.size === 0) {
    stopWidgetRefresh();
    latestAgentStatuses.clear();
    if (latestCtx?.hasUI) latestCtx.ui.setWidget("herdr-subagents", undefined);
    return;
  }
  if (!latestCtx?.hasUI) return;
  setWidgetFromCurrentState();
  void refreshWidgetStatuses();
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
  markSubagentActive(running.id);
  startWidgetRefresh();

  void deps
    .watch(running, {
      client: deps.client,
      stream: getEventStream(),
      signal: watcherAbort.signal,
    })
    .then((outcome) => {
      runningSubagents.delete(running.id);
      markSubagentInactive(running.id);
      updateWidget();
      const contextUsage =
        outcome.kind === "cancelled"
          ? null
          : consumeContextUsageSidecar(running.sessionFile, running.id);
      const message = buildOutcomeMessage(
        running,
        mapOutcome ? mapOutcome(outcome) : outcome,
        { contextUsage },
      );
      if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
    })
    .catch((err: any) => {
      runningSubagents.delete(running.id);
      markSubagentInactive(running.id);
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
  `Subagents require herdr >= ${MIN_HERDR_VERSION} and the bundled Herdr plugin. ` +
  `Link it with: herdr plugin link "${HERDR_PLUGIN_DIR}" --enabled; ` +
  `then run: herdr plugin enable ${HERDR_PLUGIN_ID}. ` +
  "Start herdr, open a pane, and run pi there — herdr injects HERDR_ENV, HERDR_PANE_ID, " +
  "and HERDR_SOCKET_PATH, which this extension needs to launch and observe subagents.";

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

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (params.agent && !agentDefs) {
    const projectPath = join(process.cwd(), ".pi", "agents", `${params.agent}.md`);
    const globalPath = join(getAgentConfigDir(), "agents", `${params.agent}.md`);
    return errorResult(
      `Agent "${params.agent}" not found. Searched ${projectPath} and ${globalPath}.`,
      "agent not found",
    );
  }

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    return errorResult(
      "Error: no session file. Start pi with a persistent session to use subagents.",
      "no session file",
    );
  }

  let setupError: string | null;
  try {
    setupError = await ensureHerdrCapability();
  } catch (error: any) {
    setupError = `capability check failed: ${error?.message ?? String(error)}`;
  }
  if (setupError) {
    return errorResult(
      `Cannot start subagent: ${setupError}`,
      "herdr setup incomplete",
    );
  }

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
  writePlanFiles(plan.files);
  if (plan.seedSession) {
    seedSubagentSessionFile(plan.seedSession);
  }

  let started;
  try {
    started = await deps.client.paneStart(plan.paneStart);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to start herdr pane for "${params.name}": ${message}`, message);
  }
  // Best-effort sidebar label; the pane is already running the subagent.
  await deps.client.paneRename(started.paneId, params.name).catch(() => {});

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

function writePlanFiles(files: Array<{ path: string; content: string }>): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
  }
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

// ── subagent_resume ─────────────────────────────────────────────────────────

function safeGetNewEntries(sessionFile: string, afterLine: number) {
  try {
    return getNewEntries(sessionFile, afterLine);
  } catch {
    return [];
  }
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch (ported reference behavior): the pre-existing conversation
 * must not masquerade as new output. Launch failures and pings pass through
 * untouched — their payloads are already truthful.
 */
function resolveResumeOutcome(
  outcome: SubagentOutcome,
  sessionPath: string,
  entryCountBefore: number,
): SubagentOutcome {
  const newSummary = () =>
    findLastAssistantMessage(safeGetNewEntries(sessionPath, entryCountBefore));

  switch (outcome.kind) {
    case "completed":
    case "completed-user-exit":
      return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
    case "crashed":
    case "pane-killed":
    case "gap-exit":
      return { ...outcome, summary: newSummary() };
    default:
      return outcome;
  }
}

const RESUME_DESCRIPTION =
  "Resume a previous sub-agent session in a new herdr pane. " +
  "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
  "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
  "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
  "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
  "Use when a sub-agent was cancelled or needs follow-up work.";

async function executeSubagentResume(
  pi: ExtensionAPI,
  params: { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
  ctx: {
    cwd: string;
    sessionManager: {
      getSessionFile(): string | null;
      getSessionId(): string;
      getSessionDir(): string;
    };
  },
) {
  if (!existsSync(params.sessionPath)) {
    return errorResult(
      `Error: session file not found: ${params.sessionPath}`,
      "session not found",
    );
  }

  let setupError: string | null;
  try {
    setupError = await ensureHerdrCapability();
  } catch (error: any) {
    setupError = `capability check failed: ${error?.message ?? String(error)}`;
  }
  if (setupError) {
    return errorResult(
      `Cannot resume subagent: ${setupError}`,
      "herdr setup incomplete",
    );
  }

  // Record entry count before resuming so we can extract only new messages.
  const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;

  let plan;
  try {
    plan = buildResumeLaunchPlan(params, {
      sessionDir: ctx.sessionManager.getSessionDir(),
      sessionId: ctx.sessionManager.getSessionId(),
      parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
      parentCwd: ctx.cwd,
      env: process.env,
    });
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to plan resume launch: ${message}`, message);
  }

  // Stale-sidecar belt & braces: completion signals from the previous run
  // would resolve the new watcher instantly.
  rmSync(`${params.sessionPath}.exit`, { force: true });
  rmSync(`${params.sessionPath}.exitcode`, { force: true });
  rmSync(contextUsagePath(params.sessionPath), { force: true });

  writePlanFiles(plan.files);

  let started;
  try {
    started = await deps.client.paneStart(plan.paneStart);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    return errorResult(`Failed to start herdr pane for "${plan.name}": ${message}`, message);
  }
  // Best-effort sidebar label; the pane is already running the subagent.
  await deps.client.paneRename(started.paneId, plan.name).catch(() => {});

  const running: RunningSubagent = {
    id: plan.id,
    name: plan.name,
    task: params.message ?? "resumed session",
    paneId: started.paneId,
    startTime: Date.now(),
    sessionFile: params.sessionPath,
    launchScriptFile: plan.launchScriptFile,
    interactive: plan.interactive,
    autoExit: plan.autoExit,
  };
  armWatcher(pi, running, (outcome) =>
    resolveResumeOutcome(outcome, params.sessionPath, entryCountBefore),
  );

  return {
    content: [{ type: "text" as const, text: `Session "${plan.name}" resumed.` }],
    details: {
      id: running.id,
      name: plan.name,
      paneId: running.paneId,
      sessionPath: params.sessionPath,
      launchScriptFile: plan.launchScriptFile,
      status: "started",
    },
  };
}

function registerResumeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_resume",
    label: "Resume Subagent",
    description: RESUME_DESCRIPTION,
    promptSnippet: RESUME_DESCRIPTION,
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
      name: Type.Optional(
        Type.String({ description: "Display name for the herdr pane. Default: 'Resume'" }),
      ),
      message: Type.Optional(
        Type.String({
          description: "Optional message to send after resuming (e.g. follow-up instructions)",
        }),
      ),
      autoExit: Type.Optional(
        Type.Boolean({
          description:
            "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeSubagentResume(pi, params, ctx as any);
    },

    renderCall(args, theme) {
      const name = (args as any).name ?? "Resume";
      return new Text(
        "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "Resume";

      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(name)) +
            theme.fg("dim", " — resumed"),
          0,
          0,
        );
      }

      const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagent_interrupt ──────────────────────────────────────────────────────

export function resolveInterruptTarget(params: {
  id?: string;
  name?: string;
}): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter(
    (running) => running.name === requestedName,
  );
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

async function handleSubagentInterrupt(params: { id?: string; name?: string }) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return errorResult(resolved.error, resolved.error);
  }

  const running = resolved.running;
  try {
    // "esc" is herdr key-combo syntax (src/input/parse.rs maps it to KeyCode::Esc).
    await deps.client.paneSendKeys(running.paneId, ["esc"]);
  } catch (error: any) {
    const message =
      `Failed to send Escape to subagent "${running.name}" via herdr: ` +
      `${error?.message ?? String(error)}`;
    return {
      content: [{ type: "text" as const, text: message }],
      details: { error: error?.message ?? String(error), id: running.id, name: running.name },
    };
  }

  return {
    content: [
      { type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
    ],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

const INTERRUPT_DESCRIPTION =
  "Send Escape to the active turn of a currently running subagent. " +
  "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
  "and does not emit a subagent_result solely because of this request.";

function registerInterruptTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Subagent",
    description: INTERRUPT_DESCRIPTION,
    promptSnippet: INTERRUPT_DESCRIPTION,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
      name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
    }),

    async execute(_toolCallId, params) {
      return handleSubagentInterrupt(params);
    },

    renderCall(args, theme) {
      const target = (args as any).id ? `${(args as any).id}` : ((args as any).name ?? "(unknown)");
      return new Text(
        theme.fg("accent", "▸") +
          " " +
          theme.fg("toolTitle", theme.bold(target)) +
          theme.fg("dim", " — interrupt turn"),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      if (details?.status === "interrupt_requested") {
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
            theme.fg("dim", " — interrupt requested"),
          0,
          0,
        );
      }

      const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });
}

// ── subagents_list ──────────────────────────────────────────────────────────

const LIST_DESCRIPTION =
  "List all available subagent definitions. " +
  "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
  "Project-local agents override global ones with the same name.";

function registerListTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description: LIST_DESCRIPTION,
    promptSnippet: LIST_DESCRIPTION,
    parameters: Type.Object({}),

    async execute() {
      const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

      if (list.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No subagent definitions found." }],
          details: { agents: [] },
        };
      }

      const lines = list.map((a) => {
        const badge = a.source === "project" ? " (project)" : "";
        const desc = a.description ? ` — ${a.description}` : "";
        const model = a.model ? ` [${a.model}]` : "";
        return `• ${a.name}${badge}${model}${desc}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: list },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const agents = details?.agents ?? [];
      if (agents.length === 0) {
        return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
      }
      const lines = agents.map((a: any) => {
        const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
        const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
        const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
        return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

// ── commands ────────────────────────────────────────────────────────────────

const AGENT_TEMPLATE_FILES = ["worker.md", "planner.md", "scout.md", "reviewer.md"];

function registerCommands(pi: ExtensionAPI): void {
  // /subagents-init — copy package examples into user-owned config
  pi.registerCommand("subagents-init", {
    description: "Copy example subagent definitions: /subagents-init [global|project]",
    getArgumentCompletions: (prefix) => {
      const options = [
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
      const filtered = options.filter(({ value }) => value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const scope = args.trim() || "global";
      if (scope !== "global" && scope !== "project") {
        ctx.ui.notify("Usage: /subagents-init [global|project]", "error");
        return;
      }

      const targetDir =
        scope === "global"
          ? join(getAgentConfigDir(), "agents")
          : join(ctx.cwd, ".pi", "agents");
      const sourceDir = join(dirname(MODULE_PATH), "agents");
      const installed: string[] = [];
      const skipped: string[] = [];
      mkdirSync(targetDir, { recursive: true });

      for (const filename of AGENT_TEMPLATE_FILES) {
        try {
          copyFileSync(
            join(sourceDir, filename),
            join(targetDir, filename),
            fsConstants.COPYFILE_EXCL,
          );
          installed.push(filename);
        } catch (error: any) {
          if (error?.code === "EEXIST") {
            skipped.push(filename);
            continue;
          }
          ctx.ui.notify(
            `Failed to install ${filename} in ${targetDir}: ${error?.message ?? String(error)}`,
            "error",
          );
          return;
        }
      }

      ctx.ui.notify(
        [
          `Installed: ${installed.length > 0 ? installed.join(", ") : "none"}`,
          `Skipped existing: ${skipped.length > 0 ? skipped.join(", ") : "none"}`,
          `Target: ${targetDir}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // /iterate — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });
}

// ── extension entry ─────────────────────────────────────────────────────────

export default function herdrSubagents(pi: ExtensionAPI) {
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
    if (shouldRegister("subagent_resume")) registerResumeTool(pi);
    if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
    if (shouldRegister("subagents_list")) registerListTool(pi);
    registerCommands(pi);
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
          `pi-herdr-subagents: another extension's "subagent" tool won the registry race ` +
            `(${winner.sourceInfo.path}). List pi-herdr-subagents BEFORE pi-interactive-subagents ` +
            `in your packages to use the herdr-native tools.`,
          "warning",
        );
      }
    }

    // Cheap, asynchronous readiness check. Import stays side-effect free; tool
    // execution awaits the same promise so setup failures stop before artifacts
    // or panes are created.
    capabilityCheck = null;
    void ensureHerdrCapability()
      .then((message) => {
        if (message) {
          ctx.ui.notify(`pi-herdr-subagents: ${message}`, "warning");
        }
      })
      .catch((error: any) => {
        ctx.ui.notify(
          `pi-herdr-subagents: capability check failed: ${error?.message ?? String(error)}`,
          "warning",
        );
      });
  });

  pi.on("session_shutdown", () => {
    stopWidgetRefresh();
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
      markSubagentInactive(running.id);
    }
    runningSubagents.clear();
    latestAgentStatuses.clear();
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
  resolveInterruptTarget,
  resolveResumeLaunchBehavior,
  resolveResumeOutcome,
  setDeps(overrides: Partial<RuntimeDeps>): void {
    deps = { ...deps, ...overrides };
  },
  reset(): void {
    deps = defaultDeps();
    capabilityCheck = null;
    for (const running of runningSubagents.values()) {
      running.abortController?.abort();
      markSubagentInactive(running.id);
    }
    runningSubagents.clear();
    latestAgentStatuses.clear();
    latestCtx = null;
    stopWidgetRefresh();
    const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
    if (stream) stream.close();
    (globalThis as any)[STREAM_KEY] = null;
    ((globalThis as any)[ABORT_KEY] as AbortController).abort();
    (globalThis as any)[ABORT_KEY] = new AbortController();
  },
};
