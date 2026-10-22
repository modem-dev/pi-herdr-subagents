/**
 * Extension loaded into every subagent child pi (via `-e <this file>`).
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Provides a `caller_ping` tool to ask the parent orchestrator for help
 *
 * Ported from pi-interactive-subagents (MIT, HazAT)
 * pi-extension/subagents/subagent-done.ts @ fix/launch-verify-retry, with the
 * activity recorder stripped (stall detection is discarded in this design —
 * herdr's pane.exited gives truthful lifecycle instead).
 *
 * The `.exit` sidecar written here is a cross-extension contract: the
 * orchestrator's watcher (src/watcher.ts) classifies completion from exactly
 * these shapes — {"type":"done"}, {"type":"done","summary":...} and
 * {"type":"ping","name":...,"message":...}.
 *
 * The `summary` field is the handoff payload. Reading the child's transcript
 * for "the last assistant text" at sidecar time is racy and lossy: models with
 * extended thinking routinely compose the wrap-up in a thinking block, call
 * `subagent_done` in the same message with no text, and only then emit the
 * final prose — after the watcher has already resolved. Carrying the summary
 * in the sidecar makes the handoff explicit and independent of transcript
 * timing. Watchers that predate the field ignore it and fall back to the
 * transcript, so the two halves may be upgraded independently.
 *
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ContextUsage, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

import { writeContextUsageSidecar } from "./src/context-usage.ts";
import { getActiveSubagentCount } from "./src/runtime-state.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
  activeSubagentCount = 0,
): boolean {
  // A subagent can itself act as an orchestrator. Exiting its pi process here
  // would abort the nested watchers, so their eventual results would have no
  // live session to steer. Keep it open until every nested child has settled.
  if (activeSubagentCount > 0) return false;

  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  if (messages) {
    // A turn that ends at a user message produced no assistant reply — the
    // request errored / is retrying. This happens on resumed sessions whose
    // first request times out (verified live, pi 0.80.3): agent_end fires
    // while pi is "Retrying (1/3)"; walking backwards would find the
    // PREVIOUS conversation's assistant and shut pi down mid-retry.
    const last = messages[messages.length - 1];
    if (last?.role === "user") return false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        // Don't auto-exit on errors (timeouts, connection failures) — let pi retry.
        // Only exit on clean completions (stop, toolUse) or explicit abort.
        return msg.stopReason !== "aborted" && msg.stopReason !== "error";
      }
    }
  }

  return true;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export type ExitSidecarData =
  | { type: "done"; summary?: string }
  | { type: "ping"; name: string; message: string };

/**
 * Normalize a model-supplied summary: trimmed, or undefined when blank so an
 * empty argument degrades to the transcript fallback instead of delivering "".
 */
export function normalizeSummary(summary: unknown): string | undefined {
  if (typeof summary !== "string") return undefined;
  const trimmed = summary.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape must match pi-interactive-subagents exactly (key order included)
 * when no summary is carried, so older watchers keep classifying correctly:
 *   {"type":"done"}
 *   {"type":"done","summary":"..."}
 *   {"type":"ping","name":"...","message":"..."}
 */
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  let payload: Record<string, string>;
  if (data.type === "done") {
    payload = { type: "done" };
    const summary = normalizeSummary(data.summary);
    if (summary !== undefined) payload.summary = summary;
  } else {
    payload = { type: "ping", name: data.name, message: data.message };
  }
  writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";

  function renderWidget(ctx: { ui: { setWidget: Function } }) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let contextUsageWritten = false;
  let terminalSidecarWritten = false;

  function signalTerminalSidecar(data: ExitSidecarData): void {
    if (terminalSidecarWritten) return;
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!sessionFile) return;
    writeExitSidecar(sessionFile, data);
    terminalSidecarWritten = true;
  }

  function snapshotContextUsage(
    ctx: { getContextUsage?: () => ContextUsage | null | undefined },
    fallback = false,
  ): void {
    if (contextUsageWritten) return;

    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const id = process.env.PI_SUBAGENT_ID;
    if (!sessionFile || !id) return;

    let usage: ContextUsage | null | undefined;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      return;
    }
    if (usage == null) return;

    try {
      contextUsageWritten = writeContextUsageSidecar(sessionFile, id, usage, {
        overwrite: !fallback,
      });
    } catch {
      // Telemetry is best-effort and must never prevent terminal signaling.
    }
  }

  // Show widget on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx);
  });

  pi.on("input", () => {
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("agent_start", () => {
    agentStarted = true;
  });

  pi.on("agent_end", (event, ctx) => {
    const messages = (event as any).messages as any[] | undefined;
    const shouldExit =
      autoExit &&
      shouldAutoExitOnAgentEnd(userTookOver, messages, getActiveSubagentCount());

    if (shouldExit) {
      // Write the .exit sidecar so the watcher classifies this as a proper
      // completion, not a user close. Most models finish and stop talking
      // without explicitly calling subagent_done — a clean auto-exit IS a
      // completion.
      snapshotContextUsage(ctx);
      signalTerminalSidecar({ type: "done" });
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  // User-driven exits do not pass through a terminal tool or clean agent_end.
  // Do not overwrite a snapshot already published by another terminal path.
  pi.on("session_shutdown", (_event, ctx) => {
    snapshotContextUsage(ctx, true);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      snapshotContextUsage(ctx);
      signalTerminalSidecar({
        type: "ping",
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      });

      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Ping sent. Session will exit and parent will be notified." },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It closes this session and delivers `summary` to the caller as your result. " +
      "The caller does NOT see your conversation, thinking, or files you wrote — " +
      "`summary` is the entire handoff, so put the full report in it " +
      "(verdict, what you did, key findings, paths to any artifacts). " +
      "Do not announce the report in a separate message; pass it here.",
    parameters: Type.Object({
      summary: Type.String({
        description:
          "Your complete final report for the caller, in markdown. " +
          "This is the only thing the caller receives.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        snapshotContextUsage(ctx);
        signalTerminalSidecar({ type: "done", summary: normalizeSummary(params?.summary) });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
