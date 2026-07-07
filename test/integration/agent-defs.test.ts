/**
 * ISC-5 spot check — real agent defs in ~/.pi/agent/agents/ drive model/tools/
 * system-prompt semantics identically to pi-interactive-subagents.
 *
 * No LLM, no herdr, no tmux — pure filesystem reads (READ-ONLY toward ~/.pi).
 * Each real-def case skips individually when the file is absent, so this file
 * runs everywhere. The comparison re-parses the raw file text with independent
 * regexes (the reference's frontmatter semantics), importing nothing from the
 * reference repo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverAgentDefinitions,
  loadAgentDefaults,
  resolveDenyTools,
  SPAWNING_TOOLS,
} from "../../src/agents.ts";

const REAL_AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");
const SPOT_CHECK_AGENTS = ["worker", "planner", "reviewer"];

// Env hygiene: this suite may itself run inside a subagent with
// PI_CODING_AGENT_DIR set — the spot check must read the REAL global dir.
const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;
const savedEnv = new Map<string, string | undefined>();
let savedCwd: string;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  savedCwd = process.cwd();
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Independent frontmatter re-parse — the reference regex semantics. */
function rawFrontmatter(content: string): string {
  return content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
}

function rawValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

describe("agent-def compat spot check (ISC-5)", () => {
  for (const name of SPOT_CHECK_AGENTS) {
    const file = join(REAL_AGENTS_DIR, `${name}.md`);
    const present = existsSync(file);

    it(
      `loadAgentDefaults("${name}") matches a raw frontmatter re-parse`,
      { skip: present ? false : `${file} absent on this machine` },
      () => {
        // Run from a neutral cwd so no project-local .pi/agents/ shadows the
        // global def under test.
        const neutral = mkdtempSync(join(tmpdir(), "pi-herdr-agentdefs-"));
        try {
          process.chdir(neutral);
          const defs = loadAgentDefaults(name);
          assert.ok(defs, `loadAgentDefaults("${name}") should resolve`);

          const raw = readFileSync(file, "utf8");
          const fm = rawFrontmatter(raw);
          assert.ok(fm, `${file} should have frontmatter`);

          // Field-for-field against the raw text (undefined must match too).
          assert.equal(defs.model, rawValue(fm, "model"), "model");
          assert.equal(defs.tools, rawValue(fm, "tools"), "tools");
          assert.equal(defs.thinking, rawValue(fm, "thinking"), "thinking");
          assert.equal(defs.denyTools, rawValue(fm, "deny-tools"), "deny-tools");

          const rawAutoExit = rawValue(fm, "auto-exit");
          assert.equal(
            defs.autoExit,
            rawAutoExit != null ? rawAutoExit === "true" : undefined,
            "auto-exit",
          );

          const rawSessionMode = rawValue(fm, "session-mode");
          assert.equal(
            defs.sessionMode,
            rawSessionMode === "standalone" ||
              rawSessionMode === "lineage-only" ||
              rawSessionMode === "fork"
              ? rawSessionMode
              : undefined,
            "session-mode",
          );

          const rawSystemPrompt = rawValue(fm, "system-prompt");
          assert.equal(
            defs.systemPromptMode,
            rawSystemPrompt === "replace" || rawSystemPrompt === "append"
              ? rawSystemPrompt
              : undefined,
            "system-prompt mode",
          );

          // Body (identity/system prompt source) must be the post-frontmatter text.
          const rawBody = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
          assert.equal(defs.body, rawBody || undefined, "body");

          // spawning: false must gate all four spawning tool names.
          const denied = resolveDenyTools(defs);
          if (rawValue(fm, "spawning") === "false") {
            for (const tool of SPAWNING_TOOLS) {
              assert.ok(denied.has(tool), `spawning: false must deny ${tool}`);
            }
          }
          // deny-tools entries land in the set verbatim.
          for (const tool of (rawValue(fm, "deny-tools") ?? "").split(",")) {
            if (tool.trim()) assert.ok(denied.has(tool.trim()), `deny-tools must deny ${tool.trim()}`);
          }
        } finally {
          rmSync(neutral, { recursive: true, force: true });
        }
      },
    );
  }

  it(
    "discoverAgentDefinitions() includes the real global defs",
    {
      skip: SPOT_CHECK_AGENTS.some((name) => existsSync(join(REAL_AGENTS_DIR, `${name}.md`)))
        ? false
        : "no real agent defs on this machine",
    },
    () => {
      const neutral = mkdtempSync(join(tmpdir(), "pi-herdr-agentdefs-"));
      try {
        process.chdir(neutral);
        const discovered = new Map(discoverAgentDefinitions().map((agent) => [agent.name, agent]));
        for (const name of SPOT_CHECK_AGENTS) {
          if (!existsSync(join(REAL_AGENTS_DIR, `${name}.md`))) continue;
          const agent = discovered.get(name);
          assert.ok(agent, `discovery should include ${name}`);
          assert.equal(agent.source, "global");
        }
      } finally {
        rmSync(neutral, { recursive: true, force: true });
      }
    },
  );

  it("project-local .pi/agents/ overrides a global def of the same name", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-herdr-agentdefs-proj-"));
    try {
      // Give the "global" side a controlled temp dir so the test never depends
      // on (or writes near) the developer's real config.
      const globalDir = join(project, "fake-global");
      mkdirSync(join(globalDir, "agents"), { recursive: true });
      writeFileSync(
        join(globalDir, "agents", "override-probe.md"),
        "---\nname: override-probe\nmodel: global/model\n---\nGlobal body.\n",
        "utf8",
      );
      process.env.PI_CODING_AGENT_DIR = globalDir;

      mkdirSync(join(project, ".pi", "agents"), { recursive: true });
      writeFileSync(
        join(project, ".pi", "agents", "override-probe.md"),
        "---\nname: override-probe\nmodel: project/model\nauto-exit: true\n---\nProject body.\n",
        "utf8",
      );
      process.chdir(project);

      const defs = loadAgentDefaults("override-probe");
      assert.ok(defs);
      assert.equal(defs.model, "project/model", "project def must win");
      assert.equal(defs.autoExit, true);

      const listed = discoverAgentDefinitions().find((agent) => agent.name === "override-probe");
      assert.ok(listed);
      assert.equal(listed.source, "project");
      assert.equal(listed.model, "project/model");
    } finally {
      process.chdir(savedCwd);
      rmSync(project, { recursive: true, force: true });
    }
  });
});
