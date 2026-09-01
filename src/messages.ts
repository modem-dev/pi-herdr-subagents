// Steer message builders + renderers — SubagentOutcome → subagent_result /
// subagent_ping payloads (PLAN.md Key Decision #10).
//
// Presentation helpers and the Box/Text renderers are ported from
// pi-interactive-subagents (MIT, HazAT) pi-extension/subagents/index.ts
// @ fix/launch-verify-retry, adapted for herdr panes and the outcome kinds
// of src/watcher.ts. The customType strings "subagent_result" and
// "subagent_ping" are load-bearing — downstream tooling and session greps
// rely on them; do not rename.
//
// Refinements over the reference (plan §10):
//   (a) exit-0-without-subagent_done gets distinct honest phrasing
//       ("closed by user, no subagent_done") instead of a generic "completed";
//   (b) pane-killed / gap-exit still deliver the last assistant message from
//       the child session file (written incrementally) + the session path so
//       the orchestrator can resume.
//
// Tool descriptions/promptSnippets are NOT here (Task 10) — outcome→message only.
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";

import type { ContextUsageSnapshot } from "./context-usage.ts";
import type { RunningSubagent, SubagentOutcome } from "./watcher.ts";

export interface SubagentSteerMessage {
  customType: "subagent_result" | "subagent_ping";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function sessionRef(sessionFile: string | undefined): string {
  return sessionFile ? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}` : "";
}

function contextUsageLine(usage: ContextUsageSnapshot | null | undefined): string {
  if (usage?.tokens == null || usage.percent == null || usage.contextWindow <= 0) return "";

  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  return (
    `\n\nContext: ${usage.tokens.toLocaleString("en-US")}/${usage.contextWindow.toLocaleString("en-US")} tokens ` +
    `(${usage.percent}% used, ${remaining.toLocaleString("en-US")} remaining).`
  );
}

/** Ported: completed/failed presentation with Session:/Resume: block. */
export function resolveResultPresentation(
  result: { exitCode: number; elapsed: number; summary: string; sessionFile?: string },
  name: string,
): string {
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef(result.sessionFile)}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef(result.sessionFile)}`;
}

/**
 * Convert a terminal SubagentOutcome into a steer message payload for
 * pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" }).
 * Returns null for "cancelled" (orchestrator shutdown/interrupt — no steer).
 */
export function buildOutcomeMessage(
  running: RunningSubagent,
  outcome: SubagentOutcome,
  opts?: { now?: () => number; contextUsage?: ContextUsageSnapshot | null },
): SubagentSteerMessage | null {
  const now = opts?.now ?? Date.now;
  const elapsed = Math.max(0, Math.floor((now() - running.startTime) / 1000));
  const usageSuffix = contextUsageLine(opts?.contextUsage);

  const baseDetails: Record<string, unknown> = {
    name: running.name,
    task: running.task,
    agent: running.agent,
    elapsed,
    sessionFile: running.sessionFile,
    paneId: running.paneId,
    disposition: outcome.kind,
    ...(opts?.contextUsage ? { contextUsage: opts.contextUsage } : {}),
  };

  switch (outcome.kind) {
    case "cancelled":
      return null;

    case "ping":
      return {
        customType: "subagent_ping",
        content:
          `Sub-agent "${outcome.name}" needs help (${formatElapsed(elapsed)}):\n\n` +
          `${outcome.message}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, name: outcome.name, message: outcome.message },
      };

    case "completed":
      return {
        customType: "subagent_result",
        content:
          resolveResultPresentation(
            { exitCode: 0, elapsed, summary: outcome.summary, sessionFile: running.sessionFile },
            running.name,
          ) + usageSuffix,
        display: true,
        details: { ...baseDetails, exitCode: 0, summary: outcome.summary },
      };

    case "completed-user-exit":
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" exited (session closed by user, no subagent_done) ` +
          `after ${formatElapsed(elapsed)} — last message:\n\n` +
          `${outcome.summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, exitCode: 0, summary: outcome.summary },
      };

    case "launch-failed": {
      const lines = [
        `Sub-agent "${running.name}" failed to launch (exit code ${outcome.exitCode}).`,
        "",
        `Pane: ${running.paneId} (herdr)`,
        `Launch script: ${running.launchScriptFile}`,
        "",
        ...(outcome.heldOpen ? ["The pane was left open for post-mortem."] : []),
        "To retry manually, run in that pane (or any shell):",
        `  bash '${running.launchScriptFile}'`,
      ];
      return {
        customType: "subagent_result",
        content: lines.join("\n") + usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          exitCode: outcome.exitCode,
          error: "launch-failed",
          heldOpen: outcome.heldOpen,
          launchScriptFile: running.launchScriptFile,
        },
      };
    }

    case "crashed": {
      const summary = outcome.summary ?? `Sub-agent exited with code ${outcome.exitCode}`;
      return {
        customType: "subagent_result",
        content:
          resolveResultPresentation(
            { exitCode: outcome.exitCode, elapsed, summary, sessionFile: running.sessionFile },
            running.name,
          ) + usageSuffix,
        display: true,
        details: {
          ...baseDetails,
          exitCode: outcome.exitCode,
          error: "crashed",
          summary: outcome.summary,
        },
      };
    }

    case "pane-killed": {
      const summary = outcome.summary ?? "No assistant output captured.";
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" failed: herdr pane ${running.paneId} was ` +
          `closed before completion (killed externally, no exit recorded) — last message:\n\n` +
          `${summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: { ...baseDetails, error: "pane-killed", summary: outcome.summary },
      };
    }

    case "gap-exit": {
      const summary = outcome.summary ?? "No assistant output captured.";
      return {
        customType: "subagent_result",
        content:
          `Sub-agent "${running.name}" ended while the event stream was down ` +
          `(herdr pane ${running.paneId} is gone; no exit sidecars found) — last message:\n\n` +
          `${summary}${sessionRef(running.sessionFile)}${usageSuffix}`,
        display: true,
        details: {
          ...baseDetails,
          ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
          error: "gap-exit",
          summary: outcome.summary,
        },
      };
    }
  }
}

// ── renderers (register via pi.registerMessageRenderer in index.ts) ──────

type Theme = {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
};
type RenderOptions = { expanded: boolean };
type RenderedMessage = { render(width: number): string[] } | undefined;
type SteerLike = { content?: unknown; details?: unknown };

/** keyHint needs pi's initialized theme; fall back to plain text headless (unit tests). */
function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "expand for more";
  }
}

function statusText(disposition: string | undefined, exitCode: number): string {
  switch (disposition) {
    case "completed":
      return "completed";
    case "completed-user-exit":
      return "closed by user (no subagent_done)";
    case "launch-failed":
      return `failed to launch (exit ${exitCode})`;
    case "pane-killed":
      return "pane closed externally";
    case "gap-exit":
      return "ended (event-stream gap)";
    default:
      return exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
  }
}

/** Renderer for `subagent_result` steer messages. */
export function renderSubagentResult(
  message: SteerLike,
  options: RenderOptions,
  theme: Theme,
): RenderedMessage {
  const details = message.details as Record<string, any> | undefined;
  if (!details) return undefined;

  return {
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const exitCode = typeof details.exitCode === "number" ? details.exitCode : 1;
      const disposition = typeof details.disposition === "string" ? details.disposition : undefined;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const ok =
        disposition === "completed" ||
        disposition === "completed-user-exit" ||
        (disposition === undefined && exitCode === 0);
      const bgFn = ok
        ? (text: string) => theme.bg("toolSuccessBg", text)
        : (text: string) => theme.bg("toolErrorBg", text);
      const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const status = statusText(disposition, exitCode);
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;

      // Prefer the structured summary; fall back to the content with the
      // Session:/Resume: block and leading label stripped (ported regexes).
      const rawContent = typeof message.content === "string" ? message.content : "";
      const summary =
        typeof details.summary === "string"
          ? details.summary
          : rawContent
              .replace(/\n\nSession: .+\nResume: .+$/, "")
              .replace(/^Sub-agent "[^"]*" [^\n]*\n\n/, "");

      const contentLines = [header];
      const usageLine = contextUsageLine(details.contextUsage).trim();
      if (usageLine) contentLines.push(theme.fg("dim", usageLine));
      // NOTE: deliberately not width-truncated. These lines exist to be
      // copy-pasted; a clipped path is useless. Session paths exceed typical
      // terminal widths, so let the box wrap them instead.
      if (details.sessionFile) {
        contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
        contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
      }

      if (options.expanded) {
        if (summary) {
          for (const line of summary.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        }
      } else {
        if (summary) {
          const previewLines = summary.split("\n").slice(0, 5);
          for (const line of previewLines) {
            contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
          }
          const totalLines = summary.split("\n").length;
          if (totalLines > 5) {
            contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
          }
        }
        contentLines.push(theme.fg("muted", expandHint()));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

/** Renderer for `subagent_ping` steer messages. */
export function renderSubagentPing(
  message: SteerLike,
  options: RenderOptions,
  theme: Theme,
): RenderedMessage {
  const details = message.details as Record<string, any> | undefined;
  if (!details) return undefined;

  return {
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
      const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

      const icon = theme.fg("accent", "?");
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

      const contentLines = [header];
      const usageLine = contextUsageLine(details.contextUsage).trim();
      if (usageLine) contentLines.push(theme.fg("dim", usageLine));
      // NOTE: deliberately not width-truncated (see renderSubagentResult).
      if (details.sessionFile) {
        contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
        contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
      }

      if (options.expanded) {
        contentLines.push("");
        contentLines.push(details.message ?? "");
      } else {
        const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
        contentLines.push(theme.fg("dim", preview));
        contentLines.push(theme.fg("muted", expandHint()));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}
