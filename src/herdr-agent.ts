// Drives a non-pi coding agent (claude, codex, gemini, … — any kind herdr
// detects) through one task, using herdr's generic agent layer:
//
//   wait until herdr reports the pane's agent idle/done (a trust, update or
//   permission prompt shows as "blocked" — the user answers it in the pane)
//   → `herdr agent prompt --wait` with a one-line pointer to the task file
//   → read the report the agent was asked to write (pane text as fallback)
//   → append it as a `result` line to the session file + write the `.exit`
//     done sidecar, so the ordinary watcher classifies the completion
//   → close the pane (auto-exit) or leave it for the user.
//
// A turn that subagent_interrupt ended is not the end of the task: the driver
// waits for the next turn (the orchestrator's steer) instead of reporting.
// Failures append the reason as the result line and write a nonzero exitcode
// sidecar, so the watcher reports them as a crash with that reason.
import { accessSync, appendFileSync, constants, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PaneInfo } from "./herdr/client.ts";

/** Agent kinds herdr 0.9.1 detects (`herdr agent start --help`). pi children use the native path. */
export const HERDR_AGENT_KINDS = new Set([
  "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode",
  "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo",
  "qodercli", "qwen", "letta", "maki", "muse",
]);

/** Session-file suffix for herdr-driven agents: our result line, not a resumable pi session. */
export const HERDR_AGENT_SESSION_SUFFIX = ".agent.jsonl";

/** Herdr agent kinds whose executable (the kind name) is on PATH. */
export function installedHerdrAgentKinds(path = process.env.PATH ?? ""): string[] {
  const dirs = path.split(":").filter(Boolean);
  return [...HERDR_AGENT_KINDS].filter((kind) =>
    dirs.some((dir) => {
      try {
        accessSync(join(dir, kind), constants.X_OK);
        return statSync(join(dir, kind)).isFile();
      } catch {
        return false;
      }
    }),
  );
}

export function isHerdrAgentSessionFile(sessionFile: string): boolean {
  return sessionFile.endsWith(HERDR_AGENT_SESSION_SUFFIX);
}

type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgentRun {
  id: string;
  kind: string;
  paneId: string;
  sessionFile: string;
  /** One-line prompt pointing the agent at its task file. */
  promptText: string;
  /** Where the agent was asked to write its final report. */
  resultFile: string;
  autoExit: boolean;
  /** Returns true (once) if subagent_interrupt was sent since the last call. */
  takeInterrupt?: () => boolean;
}

export interface HerdrAgentDeps {
  client: {
    paneGet(paneId: string): Promise<PaneInfo | null>;
    paneRead(paneId: string, lines: number): Promise<string | null>;
    paneClose(paneId: string): Promise<void>;
    agentPromptAndWait(paneId: string, text: string, signal?: AbortSignal): Promise<void>;
    agentWait(paneId: string, until: AgentStatus[], signal?: AbortSignal): Promise<void>;
  };
  signal: AbortSignal;
  pollMs?: number;
  /** Give up if herdr has not detected the agent at all by then (default 60s). */
  detectTimeoutMs?: number;
  now?: () => number;
}

const PROMPT_ATTEMPTS = 3;

export async function driveHerdrAgent(run: HerdrAgentRun, deps: HerdrAgentDeps): Promise<void> {
  const pollMs = deps.pollMs ?? 1_000;
  const detectTimeoutMs = deps.detectTimeoutMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const paneGone = async () => (await deps.client.paneGet(run.paneId).catch(() => undefined)) === null;
  const readResult = () => {
    try {
      return readFileSync(run.resultFile, "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  /** Returns false when the watcher already settled — then don't touch sidecars or the pane. */
  const finish = (summary: string, exitCode: number): boolean => {
    if (deps.signal.aborted) return false;
    appendFileSync(run.sessionFile, JSON.stringify({ type: "result", result: summary }) + "\n");
    if (exitCode === 0) writeFileSync(`${run.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    else writeFileSync(`${run.sessionFile}.exitcode`, `${exitCode} ${run.id}`);
    return true;
  };
  const fail = async (reason: string) => {
    if (finish(reason, 70)) await deps.client.paneClose(run.paneId).catch(() => {});
  };

  /** Poll until the agent can take a prompt. Returns false when the run should stop. */
  const waitReady = async (): Promise<boolean> => {
    const startedAt = now();
    for (;;) {
      if (deps.signal.aborted) return false;
      const pane = await deps.client.paneGet(run.paneId).catch(() => undefined);
      if (pane === null) return false; // pane gone — the watcher classifies the exit
      const status = pane?.agent_status;
      if (status === "idle" || status === "done") return true;
      if (!pane?.agent && now() - startedAt > detectTimeoutMs) {
        await fail(`herdr never detected a ${run.kind} agent in the pane (is \`${run.kind}\` installed?).`);
        return false;
      }
      await sleep(pollMs);
    }
  };

  /** Did the pane receive the prompt? TUIs echo it; wrapping splits it, so compare without whitespace. */
  const promptVisible = async () => {
    const text = (await deps.client.paneRead(run.paneId, 60).catch(() => null)) ?? "";
    const squash = (s: string) => s.replace(/\s+/g, "");
    return squash(text).includes(squash(run.promptText));
  };

  // ── 1. one prompted turn ──
  for (let attempt = 1; ; ) {
    if (!(await waitReady())) return;
    try {
      await deps.client.agentPromptAndWait(run.paneId, run.promptText, deps.signal);
      break;
    } catch (error: any) {
      if (deps.signal.aborted || (await paneGone())) return;
      // A dialog appeared between the readiness check and the prompt: wait it out.
      if (error?.code === "agent_blocked") continue;
      // ponytail: a TUI that just turned idle can drop the first submission (seen
      // live with claude); herdr reports agent_prompt_stalled. Resend only when
      // the prompt is not on screen, so a fast turn is not submitted twice.
      if (error?.code === "agent_prompt_stalled" && attempt++ < PROMPT_ATTEMPTS) {
        if (await promptVisible()) {
          // The agent got it; wait for that turn instead of resending.
          await deps.client.agentWait(run.paneId, ["idle", "done"], deps.signal).catch(() => {});
          break;
        }
        await sleep(2_000);
        continue;
      }
      return fail(`Failed to prompt the ${run.kind} agent: ${error?.message ?? String(error)}`);
    }
  }

  // ── 2. an interrupted turn is not the end: wait for the steered follow-up turn ──
  while (!readResult() && run.takeInterrupt?.()) {
    try {
      await deps.client.agentWait(run.paneId, ["working"], deps.signal);
      await deps.client.agentWait(run.paneId, ["idle", "done"], deps.signal);
    } catch {
      return; // aborted or pane gone — the watcher classifies it
    }
  }

  // ── 3. report ──
  let summary = readResult();
  summary ??= (await deps.client.paneRead(run.paneId, 60).catch(() => null))?.trim() || null;
  // The .exit sidecar settles the watcher, which aborts deps.signal — so decide
  // on closing from finish()'s result, not from the signal afterwards.
  if (finish(summary ?? `${run.kind} agent finished without output`, 0) && run.autoExit) {
    await deps.client.paneClose(run.paneId).catch(() => {});
  }
}
