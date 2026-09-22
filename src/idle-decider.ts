/**
 * Idle decision shared by the orchestrator's /subagent-decider command and the
 * child extension (subagent-done.ts): should a subagent whose turn just ended
 * exit as done, or stay open for the user?
 *
 * Modes (persisted in ~/.pi/subagent-decider/mode, read by children on every decision):
 *   jev — TypeSafe Jev, given the brief + final reply + last-turn tool summary.
 *   off — no classifier; the agent's auto-exit flag decides.
 * Without a key, or when Jev doesn't answer, the auto-exit flag decides too.
 *
 * Benchmarked on ~200 replayed subagent sessions plus hand-written edge cases:
 * AUC 0.993, no finished report kept open on the held-out split.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DeciderMode = "jev" | "off";
export const DECIDER_MODES: DeciderMode[] = ["jev", "off"];

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
// Jev's p(finished) separates cleanly around here; fit with a wrong keep-open
// costing 5x a wrong exit (the parent can resume a subagent that exited early).
export const JEV_THRESHOLD = 0.065;

// Lazily resolved so tests can point HOME elsewhere.
const deciderDir = () => join(homedir(), ".pi", "subagent-decider");

export function readDeciderMode(): DeciderMode {
  try {
    const mode = readFileSync(join(deciderDir(), "mode"), "utf8").trim();
    if ((DECIDER_MODES as string[]).includes(mode)) return mode as DeciderMode;
  } catch {}
  return "jev";
}

export function writeDeciderMode(mode: DeciderMode): void {
  mkdirSync(deciderDir(), { recursive: true });
  writeFileSync(join(deciderDir(), "mode"), mode + "\n");
}

/**
 * Children don't get the orchestrator's full env, so besides the env vars the
 * key can live in ~/.pi/subagent-decider/typesafe-key (chmod 600).
 */
export const jevKeyFile = () => join(deciderDir(), "typesafe-key");

/** Owner-only: agents running as you can still read it, but no one else can. */
export function saveJevKey(key: string): void {
  mkdirSync(deciderDir(), { recursive: true, mode: 0o700 });
  writeFileSync(jevKeyFile(), key + "\n", { mode: 0o600 });
  chmodSync(jevKeyFile(), 0o600); // mode above only applies when the file is created
}

/** One real, tiny Jev call to tell a bad key from a network problem. */
export async function checkJevKey(key: string, url = JEV_URL): Promise<"ok" | "rejected" | "unreachable"> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: "Key check.",
        questions: { q: { type: "noul", instructions: "Is this a key check?" } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return "ok";
    return res.status === 401 || res.status === 403 ? "rejected" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export function savedJevKey(): string | undefined {
  try {
    return readFileSync(jevKeyFile(), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function readJevKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || savedJevKey();
}

// String content as-is, part lists joined and trimmed — as in the benchmark data.
function messageText(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  return (msg?.content ?? [])
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n")
    .trim();
}

/** The brief: text of the first user message in the session. */
export function firstUserText(messages: any[] | undefined): string {
  const first = messages?.find((m) => m?.role === "user");
  return first ? messageText(first) : "";
}

/**
 * Tool outcomes of the latest turn, in words — the model can't compare numbers.
 * Wording is what the benchmark used; changing it invalidates JEV_THRESHOLD.
 */
export function lastTurnSummary(messages: any[] | undefined): string {
  const results: any[] = [];
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const msg = messages![i];
    if (msg?.role === "user") break;
    if (msg?.role === "toolResult") results.unshift(msg);
  }
  if (results.length === 0) return "The final turn used no tools.";
  const failed = results.filter((r) => r.isError).length;
  const last = results[results.length - 1];
  return (
    `The final turn ran ${results.length} tool calls and ${failed || "none"} failed. ` +
    `The last tool call (${last.toolName}) ${last.isError ? "failed" : "succeeded"}.`
  );
}

const JEV_QUESTION = {
  type: "choice",
  instructions:
    "The author was given the task below. What state is their work in at the end of their final message?",
  criteria: {
    finished: "the task as given is done, including tasks that only asked for a report, review or options",
    blocked: "the work stopped, waiting for the reader's answer, decision, approval or missing information",
    unsure: "the result may be wrong or incomplete and the reader should check it",
  },
};

/**
 * Ask Jev whether the subagent is finished. null = no answer (network, auth,
 * timeout) — the caller falls back to the auto-exit flag.
 */
export async function jevDecide(
  key: string,
  input: { finalMessage: string; lastTurn: string; task: string },
  url = JEV_URL,
): Promise<boolean | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        // Field order and truncation as benchmarked.
        state: {
          final_message: input.finalMessage.slice(-1500),
          last_turn: input.lastTurn,
          task: input.task.slice(0, 1000),
        },
        questions: { q: JEV_QUESTION },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const p = (await res.json())?.answers?.q?.probabilities?.finished;
    return typeof p === "number" ? p >= JEV_THRESHOLD : null;
  } catch {
    return null;
  }
}
