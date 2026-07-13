// LaunchPlan builder — agent defs + tool params → artifacts + wrapper script + agent-start argv.
//
// Pure planning module: no herdr calls, no subprocesses. index.ts executes the
// plan (write plan.files, seed plan.seedSession, client.agentStart(plan.agentStart)).
// The only filesystem side effect here is getDefaultSessionDirFor() creating the
// child session directory (ported behavior from pi-interactive-subagents).
//
// Design (PLAN.md Key Decisions #4–#7):
// - The generated wrapper script is the single place env/wrapping/exit-capture
//   happens. herdr launches it as a direct argv process (`bash <script>`) — no
//   shell typing, no launch race, no verify/retry machinery.
// - Env correctness for direnv/devenv repos: the script exports the
//   orchestrator's PATH + curated PI_SUBAGENT_* vars (never a full env dump),
//   and wraps the pi invocation in `direnv exec '<cwd>'` when the target cwd
//   (or an ancestor) has an .envrc. Overrides: PI_HERDR_LAUNCH_PREFIX
//   (template, `{cwd}` interpolated, empty string disables), PI_HERDR_PI_BIN,
//   PI_HERDR_DIRENV=0.
// - Exit code via `<sessionFile>.exitcode` sidecar (pane.exited carries no exit
//   code and pane records vanish on exit). On startup crash (exit ≠ 0 within
//   PI_HERDR_HOLD_OPEN_SECS, default 15) the script holds the pane open for
//   post-mortem — the sidecar, not pane.exited, is the completion signal then.
//
// buildSubagentToolAllowlist / buildPiPromptArgs / shellEscape and artifact
// conventions ported from pi-interactive-subagents (MIT, HazAT)
// pi-extension/subagents/{index.ts,cmux.ts} @ fix/launch-verify-retry.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AgentDefaults,
  getAgentConfigDir,
  getDefaultSessionDirFor,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveSubagentPaths,
} from "./agents.ts";

/** `subagent` tool params consulted by launch planning. */
export interface SubagentLaunchParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  model?: string;
  tools?: string;
  skills?: string;
  systemPrompt?: string;
  fork?: boolean;
  interactive?: boolean;
}

export interface LaunchPlanContext {
  /** Orchestrator session directory (ctx.sessionManager.getSessionDir()). */
  sessionDir: string;
  /** Orchestrator session id (artifact dir key). */
  sessionId: string;
  /** Orchestrator session file (fork/lineage seeding source). */
  parentSessionFile: string;
  /** Orchestrator process cwd (ctx.cwd). */
  parentCwd: string;
  /** Environment snapshot — normally process.env. Injectable test seam. */
  env: Record<string, string | undefined>;
  /** Deterministic seams for tests. */
  now?: Date;
  id?: string;
  /** Override pi binary resolution (default: scan env.PATH for an executable `pi`). */
  resolvePiBin?: (env: Record<string, string | undefined>) => string;
  /** Override the child extension path (default: <package root>/subagent-done.ts). */
  subagentDonePath?: string;
}

export interface LaunchPlan {
  id: string;
  name: string;
  task: string;
  agent?: string;
  /** Effective working directory for the child (param > agent def > orchestrator cwd). */
  effectiveCwd: string;
  /** Deterministic child session file path. */
  sessionFile: string;
  launchScriptFile: string;
  taskArtifactFile: string | null;
  syspromptFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). Includes the launch script. */
  files: Array<{ path: string; content: string }>;
  /** Session seeding the executor must perform before launch (fork/lineage modes). */
  seedSession: {
    mode: "lineage-only" | "fork";
    parentSessionFile: string;
    childSessionFile: string;
    childCwd: string;
  } | null;
  /** Arguments for HerdrClient.agentStart(). */
  agentStart: {
    name: string;
    cwd: string;
    tabId?: string;
    split?: "right" | "down";
    argv: string[];
  };
  /** The unescaped pi invocation embedded in the wrapper script (piArgv[0] = binary). */
  piArgv: string[];
  interactive: boolean;
  autoExit: boolean;
  /** Startup crash hold-open window in seconds (0 = disabled). */
  holdOpenSecs: number;
}

/** Absolute path to the package root (src/ → package). */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DEFAULT_HOLD_OPEN_SECS = 15;

/** Ported from pi-interactive-subagents cmux.ts — the only thing taken from cmux.ts. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/** Artifact dir convention shared with pi-interactive-subagents: <sessionDir>/artifacts/<session-id>/ */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/** Ported safe-name normalization for artifact file names. */
function safeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/** Walk up from cwd looking for .envrc (direnv semantics). Stops at $HOME or filesystem root. */
function hasEnvrc(cwd: string): boolean {
  const home = homedir();
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, ".envrc"))) return true;
    if (dir === home) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Default pi binary resolution: first executable `pi` on env.PATH. Must be absolute. */
function defaultResolvePiBin(env: Record<string, string | undefined>): string {
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "pi");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning
    }
  }
  throw new Error(
    "Could not resolve an absolute path to `pi` on PATH. " +
      "Set PI_HERDR_PI_BIN to the pi binary (e.g. ~/.local/bin/pi).",
  );
}

/**
 * Resolve the launch-command wrapper prefix (raw shell text, "" = none).
 *
 * PI_HERDR_LAUNCH_PREFIX (if defined, even empty) replaces autodetection;
 * `{cwd}` is interpolated shell-escaped. Otherwise `direnv exec '<cwd>'` when
 * the effective cwd has an .envrc (disable with PI_HERDR_DIRENV=0).
 */
function resolveLaunchPrefix(env: Record<string, string | undefined>, cwd: string): string {
  const template = env.PI_HERDR_LAUNCH_PREFIX;
  if (template != null) {
    return template.replaceAll("{cwd}", shellEscape(cwd)).trim();
  }
  if (env.PI_HERDR_DIRENV === "0") return "";
  if (hasEnvrc(cwd)) return `direnv exec ${shellEscape(cwd)}`;
  return "";
}

function resolveHoldOpenSecs(env: Record<string, string | undefined>): number {
  const raw = env.PI_HERDR_HOLD_OPEN_SECS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_HOLD_OPEN_SECS;
}

/**
 * Assemble the wrapper-script body shared by spawn and resume launches:
 * curated exports → cd → (prefix-wrapped) pi invocation → exitcode sidecar →
 * startup-crash hold-open → exit passthrough.
 */
function buildWrapperScript(opts: {
  env: Record<string, string | undefined>;
  headerLines: string[];
  exports: string[];
  cwd: string;
  piArgv: string[];
  sessionFile: string;
}): { content: string; holdOpenSecs: number } {
  const launchPrefix = resolveLaunchPrefix(opts.env, opts.cwd);
  const holdOpenSecs = resolveHoldOpenSecs(opts.env);
  const piCommand =
    (launchPrefix ? `${launchPrefix} ` : "") + opts.piArgv.map((arg) => shellEscape(arg)).join(" ");

  const scriptLines = [
    "#!/usr/bin/env bash",
    "# Ignore SIGTSTP — argv-launched panes have no parent interactive shell",
    "# to resume from, so Ctrl+Z would leave the pane permanently stuck.",
    "trap '' TSTP",
    ...opts.headerLines,
    ...opts.exports,
    `cd ${shellEscape(opts.cwd)}`,
    piCommand,
    'code=$?',
    `echo "$code" > ${shellEscape(`${opts.sessionFile}.exitcode`)}`,
    ...(holdOpenSecs > 0
      ? [
          `if [ "$code" -ne 0 ] && [ "$SECONDS" -lt ${holdOpenSecs} ]; then`,
          `  echo "subagent crashed (exit $code) — press Enter to close"`,
          "  read -r",
          "fi",
        ]
      : []),
    'exit "$code"',
    "",
  ];
  return { content: scriptLines.join("\n"), holdOpenSecs };
}

export function buildLaunchPlan(
  params: SubagentLaunchParams,
  agentDefs: AgentDefaults | null,
  ctx: LaunchPlanContext,
): LaunchPlan {
  if (agentDefs?.cli && agentDefs.cli !== "pi") {
    throw new Error(
      `Agent "${params.agent ?? params.name}" uses cli: ${agentDefs.cli}, which is ` +
        "not supported by pi-herdr-subagents (pi children only).",
    );
  }

  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);

  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const interactive = resolveEffectiveInteractive(params, agentDefs);
  const autoExit = agentDefs?.autoExit ?? false;

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
    params,
    agentDefs,
  );
  const targetCwd = effectiveCwd ?? ctx.parentCwd;
  const childSessionDir = getDefaultSessionDirFor(targetCwd, effectiveAgentDir);

  // Deterministic child session file path — each launch knows exactly which
  // file is its child's, eliminating races between concurrent spawns.
  const sessionTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const sessionFile = join(childSessionDir, `${sessionTimestamp}_${uuid}.jsonl`);

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  const seedSession = launchBehavior.seededSessionMode
    ? {
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: ctx.parentSessionFile,
        childSessionFile: sessionFile,
        childCwd: targetCwd,
      }
    : null;

  // ── Task message (wrapper instructions only for blank-session modes) ──
  const modeHint = autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = Boolean(systemPromptMode && identity);
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = launchBehavior.inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  const files: Array<{ path: string; content: string }> = [];
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(params.name);

  // ── pi argv ──
  const piBin = env.PI_HERDR_PI_BIN ?? (ctx.resolvePiBin ?? defaultResolvePiBin)(env);
  const piArgv: string[] = [piBin, "--session", sessionFile];

  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  piArgv.push("-e", subagentDonePath);

  if (effectiveModel) {
    piArgv.push("--model", effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel);
  }

  // System prompt via file — pi's --system-prompt/--append-system-prompt
  // auto-detect file paths, avoiding shell escaping issues with multiline content.
  let syspromptFile: string | null = null;
  if (identityInSystemPrompt && identity) {
    syspromptFile = join(artifactDir, "context", `${name}-sysprompt-${artifactTimestamp}.md`);
    files.push({ path: syspromptFile, content: identity });
    piArgv.push(
      systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      syspromptFile,
    );
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    piArgv.push("--tools", toolAllowlist);
  }

  // Task delivery: fork inherits the conversation → direct arg; blank-session
  // modes get the artifact-backed handoff so wrapper instructions arrive as
  // the initial user message.
  let taskArtifactFile: string | null = null;
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    taskArtifactFile = join(artifactDir, "context", `${name}-${artifactTimestamp}.md`);
    files.push({ path: taskArtifactFile, content: fullTask });
    taskArg = `@${taskArtifactFile}`;
  }

  piArgv.push(
    ...buildPiPromptArgs({ effectiveSkills, taskDelivery: launchBehavior.taskDelivery, taskArg }),
  );

  // ── Curated env exports (never a full env dump) ──
  const exports: string[] = [];
  if (env.PATH) exports.push(`export PATH=${shellEscape(env.PATH)}`);
  if (localAgentDir && existsSync(localAgentDir)) {
    exports.push(`export PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (env.PI_CODING_AGENT_DIR) {
    exports.push(`export PI_CODING_AGENT_DIR=${shellEscape(env.PI_CODING_AGENT_DIR)}`);
  }
  const denySet = resolveDenyTools(agentDefs);
  if (denySet.size > 0) {
    exports.push(`export PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  exports.push(`export PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    exports.push(`export PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (autoExit) {
    exports.push("export PI_SUBAGENT_AUTO_EXIT=1");
  }
  exports.push(`export PI_SUBAGENT_SESSION=${shellEscape(sessionFile)}`);
  exports.push(`export PI_SUBAGENT_ID=${shellEscape(id)}`);
  // The pane id is only known inside the pane — forward herdr's injected env.
  exports.push('export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"');

  // ── Wrapper script ──
  const { content: scriptContent, holdOpenSecs } = buildWrapperScript({
    env,
    headerLines: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${now.toISOString()}`,
      `# Session: ${sessionFile}`,
    ],
    exports,
    cwd: targetCwd,
    piArgv,
    sessionFile,
  });

  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name}-${id}.sh`);
  files.push({ path: launchScriptFile, content: scriptContent });

  return {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    effectiveCwd: targetCwd,
    sessionFile,
    launchScriptFile,
    taskArtifactFile,
    syspromptFile,
    files,
    seedSession,
    agentStart: {
      name: params.name,
      cwd: targetCwd,
      tabId: env.HERDR_TAB_ID,
      split: "right",
      argv: ["bash", launchScriptFile],
    },
    piArgv,
    interactive,
    autoExit,
    holdOpenSecs,
  };
}

// ── resume launches ─────────────────────────────────────────────────────────

export interface ResumeLaunchParams {
  sessionPath: string;
  name?: string;
  message?: string;
  autoExit?: boolean;
}

/**
 * Ported from pi-interactive-subagents: resumed sessions default to
 * autonomous follow-up work (auto-exit, non-interactive); explicit
 * autoExit: false yields an interactive resumed session.
 */
export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export interface ResumeLaunchPlan {
  id: string;
  name: string;
  /** The existing child session file being resumed. */
  sessionFile: string;
  launchScriptFile: string;
  resumeMessageFile: string | null;
  /** Files the executor must write (mkdir -p dirname first). Includes the launch script. */
  files: Array<{ path: string; content: string }>;
  agentStart: {
    name: string;
    cwd: string;
    tabId?: string;
    split?: "right" | "down";
    argv: string[];
  };
  piArgv: string[];
  interactive: boolean;
  autoExit: boolean;
  holdOpenSecs: number;
}

/**
 * Plan a resume launch: pi --session <existing path> -e subagent-done.ts,
 * plus an optional @<artifact> follow-up message. Same wrapper-script
 * machinery (curated env, direnv wrap, exitcode sidecar, hold-open) as
 * buildLaunchPlan; the pane runs in the orchestrator's cwd.
 *
 * NOTE: the executor must rmSync <sessionPath>.exit and <sessionPath>.exitcode
 * (force: true) before launching — stale sidecars from the previous run would
 * otherwise complete the new watcher instantly.
 */
export function buildResumeLaunchPlan(
  params: ResumeLaunchParams,
  ctx: LaunchPlanContext,
): ResumeLaunchPlan {
  const env = ctx.env;
  const now = ctx.now ?? new Date();
  const id = ctx.id ?? Math.random().toString(16).slice(2, 10);
  const displayName = params.name ?? "Resume";
  const { autoExit, interactive } = resolveResumeLaunchBehavior(params);

  const artifactDir = getArtifactDir(ctx.sessionDir, ctx.sessionId);
  const artifactTimestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = safeName(displayName);
  const files: Array<{ path: string; content: string }> = [];

  // ── pi argv ──
  const piBin = env.PI_HERDR_PI_BIN ?? (ctx.resolvePiBin ?? defaultResolvePiBin)(env);
  const subagentDonePath = ctx.subagentDonePath ?? join(PACKAGE_ROOT, "subagent-done.ts");
  const piArgv: string[] = [piBin, "--session", params.sessionPath, "-e", subagentDonePath];

  let resumeMessageFile: string | null = null;
  if (params.message) {
    resumeMessageFile = join(artifactDir, "subagent-resume", `${name}-${artifactTimestamp}.md`);
    files.push({ path: resumeMessageFile, content: params.message });
    piArgv.push(`@${resumeMessageFile}`);
  }

  // ── Curated env exports (never a full env dump) ──
  const exports: string[] = [];
  if (env.PATH) exports.push(`export PATH=${shellEscape(env.PATH)}`);
  if (env.PI_CODING_AGENT_DIR) {
    exports.push(`export PI_CODING_AGENT_DIR=${shellEscape(env.PI_CODING_AGENT_DIR)}`);
  }
  exports.push(`export PI_SUBAGENT_NAME=${shellEscape(displayName)}`);
  if (autoExit) {
    exports.push("export PI_SUBAGENT_AUTO_EXIT=1");
  }
  exports.push(`export PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
  exports.push(`export PI_SUBAGENT_ID=${shellEscape(id)}`);
  exports.push('export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"');

  const { content: scriptContent, holdOpenSecs } = buildWrapperScript({
    env,
    headerLines: [
      `# Subagent resume script for ${displayName}`,
      `# Generated: ${now.toISOString()}`,
      `# Session: ${params.sessionPath}`,
      ...(resumeMessageFile ? [`# Resume message file: ${resumeMessageFile}`] : []),
    ],
    exports,
    cwd: ctx.parentCwd,
    piArgv,
    sessionFile: params.sessionPath,
  });

  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name}-resume-${id}.sh`);
  files.push({ path: launchScriptFile, content: scriptContent });

  return {
    id,
    name: displayName,
    sessionFile: params.sessionPath,
    launchScriptFile,
    resumeMessageFile,
    files,
    agentStart: {
      name: displayName,
      cwd: ctx.parentCwd,
      tabId: env.HERDR_TAB_ID,
      split: "right",
      argv: ["bash", launchScriptFile],
    },
    piArgv,
    interactive,
    autoExit,
    holdOpenSecs,
  };
}
