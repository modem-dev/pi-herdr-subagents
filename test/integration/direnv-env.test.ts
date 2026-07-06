/**
 * direnv/devenv/varlock env-chain integration tests (ISC-1 env chain,
 * docs/PROJECT-BRIEF.md hard requirement 5).
 *
 *   1. synthetic direnv (portable): temp dir with an allowed .envrc → the
 *      generated wrapper script wraps pi in `direnv exec` and the child's
 *      bash subprocesses see the .envrc-exported var
 *   2. real devenv checkout (machine-specific, auto-skip): spawning with
 *      cwd $PI_ITEST_DEVENV_DIR survives the full chain — direnv exec →
 *      devenv PATH (nix pnpm, GREET=devenv) → pi wrapper → varlock — with
 *      zero launch-race mitigation code. STRICTLY READ-ONLY toward the
 *      checkout: the child only runs `which`/`echo`; markers + session
 *      files live in temp dirs. Devenv cold eval can take minutes; bound
 *      by PI_TEST_TIMEOUT_DIRENV (default 300000 ms).
 *   3. PI_HERDER_DIRENV=0 escape hatch: same synthetic setup, wrapping
 *      suppressed → no `direnv exec` in the script, var invisible to child
 *
 * No launch-race probing (delays/retries) anywhere: if a child dies we
 * assert the truthful failure steer instead of retrying.
 *
 * Costs real (cheap) model tokens. Skips when herdr/tmux/auth are missing;
 * case 1 additionally needs `direnv` on PATH, case 2 needs PI_ITEST_DEVENV_DIR + the
 * ~/.local/bin/pi wrapper.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  createTestSession,
  dumpPanes,
  integrationPrereqs,
  PI_TIMEOUT,
  startOrchestrator,
  trustFolder,
  type Orchestrator,
  type TestSession,
  uniqueId,
  waitForFile,
  waitForSteer,
} from "./harness.ts";

const prereqs = integrationPrereqs();

/** Devenv cold eval can take minutes — generous, overridable bound for case 2. */
const DIRENV_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT_DIRENV ?? "300000");

const DEVENV_DIR = process.env.PI_ITEST_DEVENV_DIR ?? "";
const PI_WRAPPER = process.env.PI_ITEST_PI_WRAPPER ?? join(homedir(), ".local", "bin", "pi");

function direnvAvailable(): boolean {
  try {
    execFileSync("direnv", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const hasDirenv = prereqs.ok && direnvAvailable();
const hasDevenvDir = hasDirenv && DEVENV_DIR !== "" && existsSync(join(DEVENV_DIR, ".envrc")) && existsSync(PI_WRAPPER);

/** Recursively collect generated subagent launch scripts for diagnostics/assertions. */
function findLaunchScripts(...roots: string[]): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.includes("subagent-scripts") && full.endsWith(".sh")) {
        out.push({ path: full, content: readFileSync(full, "utf8") });
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

describe(
  "direnv/devenv env chain (integration)",
  { skip: prereqs.ok ? false : prereqs.reason, timeout: DIRENV_TIMEOUT + PI_TIMEOUT * 4 },
  () => {
    let ts: TestSession;
    const envrcDirs: string[] = [];

    /** Temp dir (inside ts.tmpDir → removed at teardown) with an .envrc. */
    function makeEnvrcDir(tag: string, allow: boolean): string {
      const dir = join(ts.tmpDir, `envrc-${tag}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".envrc"), "export HERDER_ITEST_VAR=hello\n", "utf8");
      if (allow) {
        execFileSync("direnv", ["allow", dir], { stdio: "pipe" });
        envrcDirs.push(dir);
      }
      return dir;
    }

    function scriptsDebug(orch: Orchestrator): () => Promise<string> {
      return async () => {
        const scripts = findLaunchScripts(ts.tmpDir, ts.configDir, dirname(orch.sessionFile))
          .map((s) => `── launch script ${s.path} ──\n${s.content}`)
          .join("\n");
        return `${await dumpPanes(ts)}\n${scripts || "<no launch scripts found>"}`;
      };
    }

    before(async () => {
      ts = await createTestSession();
      // The devenv checkout may have a .pi/ dir — without a trust record the child pi blocks on
      // the interactive "Trust project folder?" dialog (live-found).
      if (hasDevenvDir) trustFolder(ts, DEVENV_DIR);
    });

    after(async () => {
      // Revoke the allow records this suite created (zero residue in
      // ~/.local/share/direnv); the dirs themselves die with ts.tmpDir.
      for (const dir of envrcDirs.splice(0)) {
        try {
          execFileSync("direnv", ["deny", dir], { stdio: "pipe" });
        } catch {}
      }
      await ts?.teardown();
    });

    // ── case 1: synthetic direnv dir → wrap fires, var reaches child bash ──

    it(
      "synthetic .envrc cwd → direnv exec wrap → var visible to child subprocesses",
      { skip: hasDirenv ? false : "direnv binary not on PATH" },
      async () => {
        const id = uniqueId();
        const cwd = makeEnvrcDir(`on-${id}`, true);
        const marker = join(ts.tmpDir, `direnv-on-${id}.txt`);

        const prompt = [
          `Call the subagent tool exactly once with these EXACT parameters:`,
          `name: "Direnv-${id}"`,
          `agent: "test-echo"`,
          `cwd: "${cwd}"`,
          `task: "Use the bash tool to run: echo VAL=$HERDER_ITEST_VAR > ${marker} — then call the subagent_done tool."`,
          `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
        ].join("\n");

        const orch = await startOrchestrator(ts, { prompt });
        const debug = scriptsDebug(orch);

        const content = await waitForFile(marker, PI_TIMEOUT, /VAL=/, debug);
        assert.equal(
          content.trim(),
          "VAL=hello",
          `child bash should inherit the .envrc var via direnv exec, got: ${content}`,
        );

        const [steer] = await waitForSteer(orch.sessionFile, {
          customType: "subagent_result",
          match: (entry) => entry.details.name === `Direnv-${id}`,
          timeout: PI_TIMEOUT,
          debug,
        });
        assert.equal(steer.details.disposition, "completed", steer.content);

        // The wrap is in the generated script, not incidental ambient env.
        const scripts = findLaunchScripts(ts.tmpDir, ts.configDir, dirname(orch.sessionFile)).filter(
          (s) => s.content.includes(cwd),
        );
        assert.ok(scripts.length > 0, "launch script for the direnv cwd should exist");
        assert.ok(
          scripts.some((s) => s.content.includes(`direnv exec '${cwd}'`)),
          `launch script should wrap pi in direnv exec:\n${scripts.map((s) => s.content).join("\n")}`,
        );
      },
    );

    // ── case 2: real devenv checkout (devenv + varlock pi wrapper) ──

    it(
      "devenv checkout cwd → full chain: direnv exec → devenv PATH → pi wrapper/varlock (READ-ONLY)",
      { skip: hasDevenvDir ? false : `needs PI_ITEST_DEVENV_DIR + ${PI_WRAPPER} + direnv` },
      async () => {
        const id = uniqueId();
        const marker = join(ts.tmpDir, `devenv-${id}.txt`);

        const prompt = [
          `Call the subagent tool exactly once with these EXACT parameters:`,
          `name: "Devenv-${id}"`,
          `agent: "test-echo"`,
          `cwd: "${DEVENV_DIR}"`,
          `task: "Use the bash tool to run: which pnpm > ${marker} && echo GREET=$GREET >> ${marker} — then call the subagent_done tool."`,
          `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
        ].join("\n");

        // Force the real pi wrapper (the varlock path under test).
        const orch = await startOrchestrator(ts, {
          prompt,
          env: { PI_HERDER_PI_BIN: PI_WRAPPER },
        });
        const debug = scriptsDebug(orch);

        // The pre-fix failure mode was instant child death (varlock/devenv env
        // missing). A completed steer — not a launch-failed one — proves the
        // chain end-to-end.
        const [steer] = await waitForSteer(orch.sessionFile, {
          customType: "subagent_result",
          match: (entry) => entry.details.name === `Devenv-${id}`,
          timeout: DIRENV_TIMEOUT,
          debug,
        });
        assert.equal(
          steer.details.disposition,
          "completed",
          `child should survive the devenv/varlock launch chain, got: ${steer.content}`,
        );
        assert.equal(steer.details.exitCode, 0, steer.content);

        const content = await waitForFile(marker, 10_000, /GREET=/, debug);
        const [pnpmLine, greetLine] = content.trim().split("\n");
        assert.match(
          pnpmLine ?? "",
          /pnpm/,
          `first marker line should be the pnpm path, got: ${content}`,
        );
        assert.match(
          pnpmLine ?? "",
          /\/nix\/store\/|\.devenv\//,
          `pnpm should resolve to a nix/devenv path (devenv PATH materialized), got: ${pnpmLine}`,
        );
        assert.equal(
          greetLine?.trim(),
          "GREET=devenv",
          `GREET from the checkout's devenv.nix should be visible, got: ${content}`,
        );

        // Child session lives under the ISOLATED config dir with real entries
        // (varlock did not kill the launch) — never inside the checkout.
        const childSession = steer.details.sessionFile as string;
        assert.ok(childSession && existsSync(childSession), `child session should exist: ${childSession}`);
        assert.ok(
          childSession.startsWith(ts.configDir),
          `child session must live under the temp config dir, got: ${childSession}`,
        );
        assert.ok(!childSession.startsWith(DEVENV_DIR), "nothing written inside the devenv checkout");
        const lines = readFileSync(childSession, "utf8").split("\n").filter((l) => l.trim());
        assert.ok(lines.length > 1, `child session should have entries beyond the header (${lines.length})`);
      },
    );

    // ── case 3: PI_HERDER_DIRENV=0 reaches script generation ──

    it(
      "PI_HERDER_DIRENV=0 → no direnv exec wrap, var invisible to child",
      { skip: hasDirenv ? false : "direnv binary not on PATH" },
      async () => {
        const id = uniqueId();
        // Same synthetic setup as case 1 — allowed .envrc, so the ONLY
        // difference is the off switch. (If the switch failed to propagate,
        // case-1 behavior would make the marker show VAL=hello.)
        const cwd = makeEnvrcDir(`off-${id}`, true);
        const marker = join(ts.tmpDir, `direnv-off-${id}.txt`);

        const prompt = [
          `Call the subagent tool exactly once with these EXACT parameters:`,
          `name: "NoDirenv-${id}"`,
          `agent: "test-echo"`,
          `cwd: "${cwd}"`,
          `task: "Use the bash tool to run: echo VAL=$HERDER_ITEST_VAR > ${marker} — then call the subagent_done tool."`,
          `Do nothing else. When a result arrives later, do NOT retry — reply NOTED.`,
        ].join("\n");

        const orch = await startOrchestrator(ts, {
          prompt,
          env: { PI_HERDER_DIRENV: "0" },
        });
        const debug = scriptsDebug(orch);

        const content = await waitForFile(marker, PI_TIMEOUT, /VAL=/, debug);
        assert.equal(
          content.trim(),
          "VAL=",
          `with PI_HERDER_DIRENV=0 the .envrc var must NOT reach the child, got: ${content}`,
        );

        const [steer] = await waitForSteer(orch.sessionFile, {
          customType: "subagent_result",
          match: (entry) => entry.details.name === `NoDirenv-${id}`,
          timeout: PI_TIMEOUT,
          debug,
        });
        assert.equal(steer.details.disposition, "completed", steer.content);

        const scripts = findLaunchScripts(ts.tmpDir, ts.configDir, dirname(orch.sessionFile)).filter(
          (s) => s.content.includes(cwd),
        );
        assert.ok(scripts.length > 0, "launch script for the no-direnv cwd should exist");
        for (const script of scripts) {
          assert.ok(
            !script.content.includes("direnv exec"),
            `PI_HERDER_DIRENV=0 must suppress the wrap in ${script.path}:\n${script.content}`,
          );
        }
      },
    );
  },
);
