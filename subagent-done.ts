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
 * these shapes — {"type":"done"} and {"type":"ping","name":...,"message":...}.
 * Keep this file dependency-light: it loads into EVERY child.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
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
  | { type: "done" }
  | { type: "ping"; name: string; message: string };

/**
 * Write the completion sidecar the orchestrator's watcher classifies from.
 * Byte-shape must match pi-interactive-subagents exactly (key order included):
 *   {"type":"done"}
 *   {"type":"ping","name":"...","message":"..."}
 */
export function writeExitSidecar(sessionFile: string, data: ExitSidecarData): void {
  const payload =
    data.type === "done"
      ? { type: "done" as const }
      : { type: "ping" as const, name: data.name, message: data.message };
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
    const shouldExit = autoExit && shouldAutoExitOnAgentEnd(userTookOver, messages);

    if (shouldExit) {
      ctx.shutdown();
      return;
    }

    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
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

      writeExitSidecar(sessionFile, {
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
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (sessionFile) {
        writeExitSidecar(sessionFile, { type: "done" });
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
