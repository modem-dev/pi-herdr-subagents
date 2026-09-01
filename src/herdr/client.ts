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

export interface PaneStartResult {
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

export interface PluginInfo {
  plugin_id: string;
  enabled: boolean;
  [key: string]: unknown;
}

export const HERDR_PLUGIN_ID = "pi-herdr-subagents";
export const HERDR_PLUGIN_ENTRYPOINT = "subagent";
export const HERDR_PLUGIN_ARGV_ENTRYPOINT = "argv";
export const MIN_HERDR_VERSION = "0.8.2";

export interface HerdrClient {
  /**
   * Split a plugin-owned pane beside the orchestrator and dispatch one generated
   * launch script through the plugin's fixed argv entrypoint. No shell typing,
   * launch race, or per-call argv support is required from Herdr.
   */
  paneStart(p: {
    name: string;
    cwd: string;
    targetPaneId?: string;
    direction?: "right" | "down";
    env?: Record<string, string>;
    launchScriptFile: string;
  }): Promise<PaneStartResult>;
  paneRename(paneId: string, label: string): Promise<void>;
  paneGet(paneId: string): Promise<PaneInfo | null>;
  paneRead(paneId: string, lines: number, signal?: AbortSignal): Promise<string | null>;
  paneList(): Promise<PaneInfo[]>;
  paneClose(paneId: string): Promise<void>;
  paneSendKeys(paneId: string, keys: string[]): Promise<void>;
  ping(): Promise<PingResult>;
  pluginGet(pluginId: string): Promise<PluginInfo | null>;
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
    async paneStart(p) {
      const args = [
        "plugin",
        "pane",
        "open",
        "--plugin",
        HERDR_PLUGIN_ID,
        "--entrypoint",
        HERDR_PLUGIN_ENTRYPOINT,
        "--placement",
        "split",
      ];
      if (p.targetPaneId) args.push("--target-pane", p.targetPaneId);
      args.push("--direction", p.direction ?? "right");
      args.push("--cwd", p.cwd);
      for (const [key, value] of Object.entries({
        ...p.env,
        PI_HERDR_LAUNCH_SCRIPT: p.launchScriptFile,
      })) {
        args.push("--env", `${key}=${value}`);
      }
      args.push("--no-focus");

      const result = await execHerdrJson<{
        plugin_pane?: { pane?: Record<string, unknown> };
      }>(args);
      const pane = result.plugin_pane?.pane as
        | { pane_id?: string; terminal_id?: string; workspace_id?: string; tab_id?: string }
        | undefined;
      if (!pane?.pane_id) {
        throw new HerdrError(
          `herdr plugin pane open returned no pane id: ${JSON.stringify(result)}`,
        );
      }
      return {
        paneId: pane.pane_id,
        terminalId: pane.terminal_id ?? "",
        workspaceId: pane.workspace_id ?? "",
        tabId: pane.tab_id ?? "",
      };
    },

    async paneRename(paneId, label) {
      // Best-effort sidebar label; success is exit 0 (output shape is not
      // relied upon so this stays compatible across herdr versions).
      await execHerdr(["pane", "rename", paneId, label]);
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

    async paneRead(paneId, lines, signal) {
      try {
        const result = await execHerdr(
          [
            "pane",
            "read",
            paneId,
            "--lines",
            String(lines),
            "--source",
            "visible",
            "--format",
            "text",
          ],
          signal,
        );
        return result.stdout;
      } catch (error) {
        // Diagnostic capture is best-effort. In particular, panes can vanish
        // between lifecycle classification and this read.
        if (error instanceof HerdrError && error.code === "pane_not_found") return null;
        return null;
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

    async pluginGet(pluginId) {
      const result = await execHerdrJson<{ plugins?: PluginInfo[] }>([
        "plugin",
        "list",
        "--plugin",
        pluginId,
        "--json",
      ]);
      return result.plugins?.find((plugin) => plugin.plugin_id === pluginId) ?? null;
    },
  };
}
