/**
 * Integration test harness — isolated named herdr session (Task 12).
 *
 * Bootstrap recipe (verified live against herdr 0.7.1 / protocol 14):
 *   1. Create a DEDICATED tmux session (the herdr client needs a TTY).
 *   2. Run `herdr --session <unique name>` in it — this starts an isolated
 *      server with its own socket under ~/.config/herdr/sessions/<name>/.
 *   3. Drive it headless: every CLI call runs with HERDR_SESSION=<name> and
 *      ambient HERDR_* pane vars stripped (this suite may itself run inside
 *      herdr or a pi subagent — never inherit the ambient socket).
 *   4. Teardown: `herdr session stop` + `session delete` + tmux kill-session
 *      + temp dirs, in after() AND on SIGINT. Teardown asserts zero residue.
 *
 * SAFETY INTERLOCKS (PLAN.md test strategy — normative):
 *   - refuse to run if the resolved socket is the default-session socket;
 *   - refuse to run if HERDR_SESSION is missing from the constructed env;
 *   - all pane operations go through the session-scoped client, which can
 *     structurally only see panes inside the session this harness created.
 *
 * Config isolation: orchestrator + children run with PI_CODING_AGENT_DIR
 * pointed at a temp dir, so the developer's global packages (including a live
 * pi-interactive-subagents) are never loaded. Model auth inside the temp dir:
 * copies of ~/.pi/agent/auth.json AND ~/.pi/agent/SYSTEM.md — both are
 * required (verified by probe: anthropic OAuth requests without this machine's
 * SYSTEM.md are rejected as "third-party app" usage). Read-only toward ~/.pi/.
 *
 * The extension under test is force-loaded from the working tree via
 * `pi -ne -e <abs index.ts>` (same rationale as the reference harness,
 * pi-interactive-subagents commit aa3d34b): never the installed package.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createHerdrClient, type ExecFn, type HerdrClient } from "../../src/herdr/client.ts";
import { shellEscape } from "../../src/launch.ts";

// ── paths & configuration ───────────────────────────────────────────────────

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");

/** Absolute path to the extension entry in the working tree (loaded via `pi -ne -e`). */
export const EXTENSION_SOURCE = join(PROJECT_ROOT, "index.ts");

/** Absolute herdr binary — tool-shell PATH may lack ~/.local/bin. */
export const HERDR_BIN = process.env.HERDR_BIN ?? join(homedir(), ".local", "bin", "herdr");

/** Model for orchestrator + children. Override with PI_TEST_MODEL. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "anthropic/claude-haiku-4-5";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

const DEFAULT_SOCKET = join(homedir(), ".config", "herdr", "herdr.sock");
const REAL_AGENT_DIR = join(homedir(), ".pi", "agent");

// ── prerequisites (CI-friendliness: skip, don't fail) ───────────────────────

export function integrationPrereqs(): { ok: boolean; reason?: string } {
  if (!existsSync(HERDR_BIN)) {
    return { ok: false, reason: `herdr binary not found at ${HERDR_BIN} (set HERDR_BIN)` };
  }
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe" });
  } catch {
    return { ok: false, reason: "tmux not available" };
  }
  if (!existsSync(join(REAL_AGENT_DIR, "auth.json"))) {
    return { ok: false, reason: `no model auth (${join(REAL_AGENT_DIR, "auth.json")} missing)` };
  }
  return { ok: true };
}

// ── pure interlock helpers (self-testable without herdr) ────────────────────

/**
 * Build the env for headless herdr CLI calls: strip every ambient HERDR_* pane
 * var (this process may run inside herdr / a pi subagent) and pin the session.
 */
export function buildHerdrEnv(
  sessionName: string,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!sessionName) throw new Error("SAFETY: refusing to build a herdr env without a session name");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null) continue;
    if (key.startsWith("HERDR_")) continue;
    env[key] = value;
  }
  env.HERDR_SESSION = sessionName;
  return env;
}

/**
 * SAFETY interlock: the socket we are about to drive must be the named test
 * session's socket — never the default session's.
 */
export function assertIsolatedSocket(socket: string, sessionName: string): void {
  if (!socket) throw new Error("SAFETY: herdr reported an empty socket path");
  if (socket === DEFAULT_SOCKET) {
    throw new Error(
      `SAFETY: resolved socket is the DEFAULT herdr session socket (${socket}) — refusing to run`,
    );
  }
  if (!socket.includes(`/sessions/${sessionName}/`)) {
    throw new Error(
      `SAFETY: resolved socket ${socket} does not belong to test session "${sessionName}"`,
    );
  }
}

// ── generic helpers ─────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Poll until a file exists (and optionally matches). Returns its content. */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
  debug?: () => Promise<string>,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(500);
  }
  const extra = debug ? `\n${await debug()}` : "";
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : "") +
      extra,
  );
}

/** Poll an async predicate until truthy. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeout?: number; label?: string; debug?: () => Promise<string> } = {},
): Promise<T> {
  const timeout = opts.timeout ?? PI_TIMEOUT;
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start >= timeout) {
      const extra = opts.debug ? `\n${await opts.debug()}` : "";
      throw new Error(`Timeout (${timeout}ms) waiting for ${opts.label ?? "condition"}${extra}`);
    }
    await sleep(500);
  }
}

// ── session-file assertions (steers are more reliable than screen text) ─────

export interface CustomMessageEntry {
  customType: string;
  content: string;
  details: Record<string, any>;
}

/** Parse a pi session jsonl for custom_message entries (steer messages). */
export function readCustomMessages(sessionFile: string, customType?: string): CustomMessageEntry[] {
  if (!existsSync(sessionFile)) return [];
  const out: CustomMessageEntry[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "custom_message") continue;
    if (customType && entry.customType !== customType) continue;
    out.push({
      customType: entry.customType,
      content: typeof entry.content === "string" ? entry.content : "",
      details: entry.details ?? {},
    });
  }
  return out;
}

export async function waitForSteer(
  sessionFile: string,
  opts: {
    customType?: string;
    match?: (entry: CustomMessageEntry) => boolean;
    count?: number;
    timeout?: number;
    debug?: () => Promise<string>;
  } = {},
): Promise<CustomMessageEntry[]> {
  const count = opts.count ?? 1;
  return waitFor(
    async () => {
      const entries = readCustomMessages(sessionFile, opts.customType).filter(
        (entry) => !opts.match || opts.match(entry),
      );
      return entries.length >= count ? entries : null;
    },
    {
      timeout: opts.timeout,
      label: `${count}× ${opts.customType ?? "custom_message"} steer in ${sessionFile}`,
      debug: opts.debug,
    },
  );
}

// ── the test session ────────────────────────────────────────────────────────

export interface TestSession {
  sessionName: string;
  tmuxSession: string;
  socketPath: string;
  /** Env for headless herdr CLI calls (HERDR_SESSION pinned, pane vars stripped). */
  herdrEnv: Record<string, string>;
  /** Session-scoped herdr client (absolute binary + env override). */
  client: HerdrClient;
  /** Temp PI_CODING_AGENT_DIR with test agent defs + auth.json + SYSTEM.md copies. */
  configDir: string;
  /** Temp scratch dir (markers, orchestrator scripts + session files). */
  tmpDir: string;
  /** Pane ids created by harness helpers (children spawned by the extension are not listed). */
  trackedPanes: string[];
  teardown(): Promise<void>;
}

function herdrExecEnv(env: Record<string, string>): ExecFn {
  return (cmd, args, opts) =>
    new Promise((res) => {
      execFile(
        cmd,
        args,
        { env, signal: opts?.signal, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          let code = 0;
          let stderrText = stderr ?? "";
          if (error) {
            const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            code = typeof errCode === "number" ? errCode : 1;
            if (!stderrText.trim() && !(stdout ?? "").trim()) stderrText = error.message;
          }
          res({ stdout: stdout ?? "", stderr: stderrText, code });
        },
      );
    });
}

function herdrJsonSync(env: Record<string, string>, args: string[]): any {
  const stdout = execFileSync(HERDR_BIN, args, { env, encoding: "utf8", stdio: "pipe" });
  return JSON.parse(stdout.trim());
}

function tmuxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null || key === "TMUX" || key.startsWith("HERDR_")) continue;
    env[key] = value;
  }
  return env;
}

function tmux(args: string[]): void {
  execFileSync("tmux", args, { env: tmuxEnv(), stdio: "pipe" });
}

function tmuxSessionExists(name: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", `=${name}`], { env: tmuxEnv(), stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ── test agent definitions ──────────────────────────────────────────────────

const TEST_ECHO_DEF = `---
name: test-echo
description: Integration test agent — completes simple file-writing tasks
model: ${TEST_MODEL}
tools: read, bash, write, edit
spawning: false
auto-exit: true
disable-model-invocation: true
---

You are a test agent. Complete the task given to you immediately. Be direct and concise.
When asked to write content to a file, do it right away using the bash tool.
Do not ask questions. Do not explain. Just execute the task.
When the task tells you to call the subagent_done tool, call it as your final action.
`;

const TEST_PING_DEF = `---
name: test-ping
description: Integration test agent — calls caller_ping instead of completing tasks
model: ${TEST_MODEL}
tools: read, bash
spawning: false
disable-model-invocation: true
---

You are a test agent. When given ANY task, you must call the caller_ping tool with the message
set to "PING: " followed by the task text you received.
Do NOT complete the task yourself. Do NOT use any other tools. ONLY call caller_ping.
`;

/** Add/overwrite an agent def in the test config dir (for per-test defs). */
export function writeAgentDef(ts: TestSession, name: string, content: string): void {
  writeFileSync(join(ts.configDir, "agents", `${name}.md`), content, "utf8");
}

// ── bootstrap ───────────────────────────────────────────────────────────────

let activeTeardowns: Array<() => void> = [];
let sigintInstalled = false;

function installSigintTeardown(): void {
  if (sigintInstalled) return;
  sigintInstalled = true;
  process.on("SIGINT", () => {
    for (const fn of activeTeardowns.splice(0)) {
      try {
        fn();
      } catch {}
    }
    process.exit(130);
  });
}

export async function createTestSession(): Promise<TestSession> {
  const prereqs = integrationPrereqs();
  if (!prereqs.ok) throw new Error(`integration prerequisites missing: ${prereqs.reason}`);

  const suffix = `${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const sessionName = `herder-subagents-test-${suffix}`;
  const tmuxSession = `herder-sub-itest-${suffix}`;
  const herdrEnv = buildHerdrEnv(sessionName);

  // SAFETY interlocks before any action.
  if (!herdrEnv.HERDR_SESSION) throw new Error("SAFETY: HERDR_SESSION missing from constructed env");
  const preStatus = herdrJsonSync(herdrEnv, ["status", "server", "--json"]);
  assertIsolatedSocket(preStatus.socket ?? "", sessionName);
  if (preStatus.running === true) {
    throw new Error(
      `SAFETY: a herdr server named ${sessionName} is already running — refusing to reuse it`,
    );
  }

  // Temp dirs: scratch + isolated pi config with auth + SYSTEM.md + agent defs.
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-herder-itest-"));
  const configDir = join(tmpDir, "pi-config");
  mkdirSync(join(configDir, "agents"), { recursive: true });
  copyFileSync(join(REAL_AGENT_DIR, "auth.json"), join(configDir, "auth.json"));
  const systemMd = join(REAL_AGENT_DIR, "SYSTEM.md");
  if (existsSync(systemMd)) copyFileSync(systemMd, join(configDir, "SYSTEM.md"));
  // Mirror the host's transport setting: pi's default HTTP transport produced
  // intermittent "Request timed out ×4 → retry failed" turns on this machine,
  // while the developer's daily-driver transport is reliable.
  let transport = "websocket-cached";
  try {
    const realSettings = JSON.parse(readFileSync(join(REAL_AGENT_DIR, "settings.json"), "utf8"));
    if (typeof realSettings.transport === "string") transport = realSettings.transport;
  } catch {}
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ transport }), "utf8");
  writeFileSync(join(configDir, "agents", "test-echo.md"), TEST_ECHO_DEF, "utf8");
  writeFileSync(join(configDir, "agents", "test-ping.md"), TEST_PING_DEF, "utf8");

  // Dedicated tmux session hosting the herdr client (needs a TTY).
  tmux(["new-session", "-d", "-s", tmuxSession, "-x", "220", "-y", "100"]);

  let toreDown = false;
  const teardownSync = () => {
    if (toreDown) return;
    toreDown = true;
    try {
      execFileSync(HERDR_BIN, ["session", "stop", sessionName, "--json"], {
        env: herdrEnv,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {}
    try {
      execFileSync(HERDR_BIN, ["session", "delete", sessionName, "--json"], {
        env: herdrEnv,
        stdio: "pipe",
        timeout: 10_000,
      });
    } catch {}
    try {
      if (tmuxSessionExists(tmuxSession)) tmux(["kill-session", "-t", `=${tmuxSession}`]);
    } catch {}
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

    // Zero-residue assertions (acceptance criteria).
    const sessionDir = join(homedir(), ".config", "herdr", "sessions", sessionName);
    if (existsSync(sessionDir)) {
      throw new Error(`teardown residue: herdr session dir still exists: ${sessionDir}`);
    }
    if (tmuxSessionExists(tmuxSession)) {
      throw new Error(`teardown residue: tmux session still exists: ${tmuxSession}`);
    }
  };
  activeTeardowns.push(teardownSync);
  installSigintTeardown();

  try {
    // Start the isolated herdr server via the client in the tmux pane.
    const startCmd =
      `exec env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_SOCKET_PATH -u HERDR_TAB_ID ` +
      `-u HERDR_WORKSPACE_ID ${shellEscape(HERDR_BIN)} --session ${shellEscape(sessionName)}`;
    // `=name:` = exact session match + its active window (plain `=name` is not
    // a valid pane target for send-keys on tmux 3.x).
    tmux(["send-keys", "-t", `=${tmuxSession}:`, startCmd, "Enter"]);

    // Poll until the isolated server is up (verified live: ~1s).
    const deadline = Date.now() + 15_000;
    let status: any;
    for (;;) {
      status = herdrJsonSync(herdrEnv, ["status", "server", "--json"]);
      if (status.running === true) break;
      if (Date.now() > deadline) {
        throw new Error(`herdr server for ${sessionName} did not start within 15s: ${JSON.stringify(status)}`);
      }
      await sleep(300);
    }
    assertIsolatedSocket(status.socket ?? "", sessionName);

    const client = createHerdrClient({ bin: HERDR_BIN, exec: herdrExecEnv(herdrEnv) });

    const ts: TestSession = {
      sessionName,
      tmuxSession,
      socketPath: status.socket,
      herdrEnv,
      client,
      configDir,
      tmpDir,
      trackedPanes: [],
      async teardown() {
        teardownSync();
        activeTeardowns = activeTeardowns.filter((fn) => fn !== teardownSync);
      },
    };
    return ts;
  } catch (error) {
    teardownSync();
    throw error;
  }
}

// ── orchestrator pi sessions ────────────────────────────────────────────────

export interface Orchestrator {
  paneId: string;
  /** The orchestrator's session jsonl (steer assertions read this). */
  sessionFile: string;
  launchScript: string;
}

function resolvePiBin(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "pi"))) return join(dir, "pi");
  }
  return join(homedir(), ".local", "bin", "pi");
}

/**
 * Start an orchestrator pi INSIDE the isolated herdr session, loaded with the
 * working-tree extension (`-ne -e`) and the temp config dir. The initial
 * prompt is passed as a positional message. Returns immediately.
 */
export async function startOrchestrator(
  ts: TestSession,
  opts: {
    prompt: string;
    name?: string;
    cwd?: string;
    /** Extra env exported in the launch script (e.g. PI_HERDER_DIRENV). */
    env?: Record<string, string>;
    model?: string;
  },
): Promise<Orchestrator> {
  const id = uniqueId();
  const name = opts.name ?? `orch-${id}`;
  const cwd = opts.cwd ?? ts.tmpDir;
  const piBin = resolvePiBin();
  const sessionFile = join(ts.tmpDir, "orch-sessions", `${name}.jsonl`);
  mkdirSync(dirname(sessionFile), { recursive: true });

  const extraExports = Object.entries(opts.env ?? {}).map(
    ([key, value]) => `export ${key}=${shellEscape(value)}`,
  );

  const script = [
    "#!/usr/bin/env bash",
    `# Orchestrator launch script (integration harness) — ${name}`,
    // The herdr server env may leak PI_SUBAGENT_*/PI_HERDER_* from wherever the
    // developer ran the tests; the orchestrator must start clean.
    "unset PI_SUBAGENT_NAME PI_SUBAGENT_AGENT PI_SUBAGENT_ID PI_SUBAGENT_SESSION \\",
    "  PI_SUBAGENT_AUTO_EXIT PI_SUBAGENT_PANE PI_DENY_TOOLS \\",
    "  PI_HERDER_LAUNCH_PREFIX PI_HERDER_DIRENV PI_HERDER_HOLD_OPEN_SECS",
    `export PATH=${shellEscape(process.env.PATH ?? "")}`,
    `export PI_CODING_AGENT_DIR=${shellEscape(ts.configDir)}`,
    `export PI_HERDER_PI_BIN=${shellEscape(piBin)}`,
    `export HERDR_BIN=${shellEscape(HERDR_BIN)}`,
    ...extraExports,
    `cd ${shellEscape(cwd)}`,
    [
      shellEscape(piBin),
      "-ne",
      "-e",
      shellEscape(EXTENSION_SOURCE),
      "--session",
      shellEscape(sessionFile),
      "--model",
      shellEscape(opts.model ?? TEST_MODEL),
      shellEscape(opts.prompt),
    ].join(" "),
    'echo "__ORCH_EXIT_$?__"',
    "read -r", // hold the pane for post-mortem reads; teardown closes it
    "",
  ].join("\n");

  const launchScript = join(ts.tmpDir, "orch-scripts", `${name}.sh`);
  mkdirSync(dirname(launchScript), { recursive: true });
  writeFileSync(launchScript, script, "utf8");

  const started = await ts.client.agentStart({
    name,
    cwd,
    argv: ["bash", launchScript],
  });
  ts.trackedPanes.push(started.paneId);
  return { paneId: started.paneId, sessionFile, launchScript };
}

// ── pane helpers ────────────────────────────────────────────────────────────

/** Read a pane's recent screen content (debug dumps for assertion messages). */
export async function paneRead(ts: TestSession, paneId: string, lines = 60): Promise<string> {
  const exec = herdrExecEnv(ts.herdrEnv);
  const result = await exec(HERDR_BIN, [
    "pane",
    "read",
    paneId,
    "--source",
    "recent",
    "--lines",
    String(lines),
  ]);
  if (result.code !== 0) return `<pane read ${paneId} failed: ${result.stderr.trim()}>`;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return parsed?.result?.text ?? result.stdout;
  } catch {
    return result.stdout;
  }
}

export async function paneExists(ts: TestSession, paneId: string): Promise<boolean> {
  return (await ts.client.paneGet(paneId)) !== null;
}

/** Debug dump: screens of the given panes (or all panes in the session). */
export async function dumpPanes(ts: TestSession, paneIds?: string[]): Promise<string> {
  let ids = paneIds;
  try {
    if (!ids) ids = (await ts.client.paneList()).map((pane) => pane.pane_id);
  } catch (error: any) {
    return `<pane list failed: ${error?.message ?? error}>`;
  }
  const chunks: string[] = [];
  for (const paneId of ids) {
    chunks.push(`── pane ${paneId} ──\n${await paneRead(ts, paneId)}`);
  }
  return chunks.join("\n") || "<no panes>";
}

/**
 * Type a follow-up prompt into a running pi pane (send-text + Enter).
 * Text must be a single line — pi's editor treats newlines as submission
 * boundaries anyway.
 */
export async function sendPrompt(ts: TestSession, paneId: string, text: string): Promise<void> {
  if (text.includes("\n")) throw new Error("sendPrompt: single-line text only");
  const exec = herdrExecEnv(ts.herdrEnv);
  const sent = await exec(HERDR_BIN, ["pane", "send-text", paneId, text]);
  if (sent.code !== 0) throw new Error(`pane send-text failed: ${sent.stderr}`);
  await sleep(300); // let the editor ingest the text before submitting
  const entered = await exec(HERDR_BIN, ["pane", "send-keys", paneId, "enter"]);
  if (entered.code !== 0) throw new Error(`pane send-keys enter failed: ${entered.stderr}`);
}
