/**
 * HerdrClient — typed request/response wrapper over the `herdr` CLI.
 *
 * The ONLY module that shells out to herdr for request/response operations.
 * Event subscription lives in ./events.ts (raw socket); waits/polling belong
 * to the watcher, not here.
 *
 * Envelope parsing pattern adapted from pi-herdr (ogulcancelik/pi-extensions, MIT).
 */
import { execFile } from "node:child_process";

export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface PaneInfo {
  pane_id: string;
  terminal_id?: string;
  workspace_id?: string;
  tab_id?: string;
  focused?: boolean;
  agent_status?: string;
  [key: string]: unknown;
}

export interface AgentStartResult {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
}

export interface PingResult {
  ok: boolean;
  version?: string | null;
  protocol?: number | null;
}

export interface HerdrClient {
  agentStart(p: {
    name: string;
    cwd: string;
    tabId?: string;
    split?: "right" | "down";
    env?: Record<string, string>;
    argv: string[];
  }): Promise<AgentStartResult>;
  paneGet(paneId: string): Promise<PaneInfo | null>;
  paneList(): Promise<PaneInfo[]>;
  paneClose(paneId: string): Promise<void>;
  paneSendKeys(paneId: string, keys: string[]): Promise<void>;
  ping(): Promise<PingResult>;
}

interface HerdrJsonEnvelope {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

class HerdrError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

function parseEnvelope(output: string): HerdrJsonEnvelope | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as HerdrJsonEnvelope;
  } catch {
    return null;
  }
}

function extractError(output: string): { code?: string; message: string } | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const envelope = parseEnvelope(trimmed);
  if (envelope?.error) {
    return {
      code: envelope.error.code,
      message: envelope.error.message || envelope.error.code || trimmed,
    };
  }
  if (envelope) return null; // valid JSON but not an error envelope
  return { message: trimmed }; // raw non-JSON text (e.g. stderr)
}

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { signal: opts?.signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      let code = 0;
      let stderrText = stderr ?? "";
      if (error) {
        const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        code = typeof errCode === "number" ? errCode : 1;
        // Spawn failures (ENOENT etc.) produce no stderr; surface the error message.
        if (!stderrText.trim() && !(stdout ?? "").trim()) stderrText = error.message;
      }
      resolve({ stdout: stdout ?? "", stderr: stderrText, code });
    });
  });

export function createHerdrClient(opts?: { exec?: ExecFn; bin?: string }): HerdrClient {
  const exec = opts?.exec ?? defaultExec;

  function resolveBin(): string {
    return opts?.bin ?? process.env.HERDR_BIN ?? "herdr";
  }

  async function execHerdr(args: string[], signal?: AbortSignal) {
    const result = await exec(resolveBin(), args, { signal });
    if (result.code !== 0) {
      const err =
        extractError(result.stdout) ??
        extractError(result.stderr) ?? {
          message: `herdr ${args.join(" ")} failed with exit code ${result.code}`,
        };
      throw new HerdrError(
        err.code ? `${err.code}: ${err.message}` : err.message,
        err.code,
      );
    }
    return result;
  }

  async function execHerdrJson<T extends Record<string, unknown>>(
    args: string[],
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await execHerdr(args, signal);
    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new HerdrError(`Expected JSON output from herdr ${args.join(" ")}`);
    }
    const envelope = parseEnvelope(stdout);
    if (!envelope) {
      throw new HerdrError(`Failed to parse JSON from herdr ${args.join(" ")}: ${stdout}`);
    }
    if (envelope.error) {
      throw new HerdrError(
        envelope.error.code
          ? `${envelope.error.code}: ${envelope.error.message || envelope.error.code}`
          : envelope.error.message || `herdr ${args.join(" ")} failed`,
        envelope.error.code,
      );
    }
    return (envelope.result ?? {}) as T;
  }

  return {
    async agentStart(p) {
      const args = ["agent", "start", p.name, "--cwd", p.cwd];
      if (p.tabId) args.push("--tab", p.tabId);
      if (p.split) args.push("--split", p.split);
      for (const [key, value] of Object.entries(p.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--no-focus", "--", ...p.argv);

      const result = await execHerdrJson<{ agent?: Record<string, unknown> }>(args);
      const agent = result.agent as
        | { pane_id?: string; terminal_id?: string; workspace_id?: string; tab_id?: string }
        | undefined;
      if (!agent?.pane_id) {
        throw new HerdrError(`herdr agent start returned no pane id: ${JSON.stringify(result)}`);
      }
      return {
        paneId: agent.pane_id,
        terminalId: agent.terminal_id ?? "",
        workspaceId: agent.workspace_id ?? "",
        tabId: agent.tab_id ?? "",
      };
    },

    async paneGet(paneId) {
      try {
        const result = await execHerdrJson<{ pane?: PaneInfo }>(["pane", "get", paneId]);
        return result.pane ?? null;
      } catch (error) {
        if (error instanceof HerdrError && error.code === "pane_not_found") return null;
        throw error;
      }
    },

    async paneList() {
      const result = await execHerdrJson<{ panes?: PaneInfo[] }>(["pane", "list"]);
      return result.panes ?? [];
    },

    async paneClose(paneId) {
      await execHerdrJson(["pane", "close", paneId]);
    },

    async paneSendKeys(paneId, keys) {
      // Unlike the other pane commands, `pane send-keys` prints NOTHING on
      // success (verified live against herdr 0.7.1) — only demand exit 0;
      // failures still surface via the error envelope + nonzero exit.
      await execHerdr(["pane", "send-keys", paneId, ...keys]);
    },

    async ping() {
      // `herdr status server --json` exits 0 whether or not a server is running
      // and prints a plain JSON object (not an id/result envelope).
      const result = await execHerdr(["status", "server", "--json"]);
      const stdout = result.stdout.trim();
      let status: { running?: boolean; version?: string | null; protocol?: number | null };
      try {
        status = JSON.parse(stdout) as typeof status;
      } catch {
        throw new HerdrError(`Failed to parse herdr status output: ${stdout}`);
      }
      return { ok: status.running === true, version: status.version, protocol: status.protocol };
    },
  };
}
