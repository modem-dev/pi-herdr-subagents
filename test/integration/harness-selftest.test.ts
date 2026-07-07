/**
 * Harness self-tests — pure safety-interlock logic, runnable WITHOUT herdr,
 * tmux, or model auth (these must pass everywhere, including CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { assertIsolatedSocket, buildHerdrEnv } from "./harness.ts";

describe("harness safety interlocks", () => {
  it("buildHerdrEnv strips every ambient HERDR_* var and pins the session", () => {
    const env = buildHerdrEnv("herdr-subagents-test-x", {
      PATH: "/usr/bin",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/some/live/herdr.sock",
      HERDR_TAB_ID: "w1:t1",
      HERDR_WORKSPACE_ID: "w1",
      HERDR_SESSION: "the-users-live-session",
      UNRELATED: "kept",
    });
    assert.equal(env.HERDR_SESSION, "herdr-subagents-test-x");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.UNRELATED, "kept");
    for (const key of Object.keys(env)) {
      if (key === "HERDR_SESSION") continue;
      assert.ok(!key.startsWith("HERDR_"), `ambient ${key} must be stripped`);
    }
  });

  it("buildHerdrEnv refuses an empty session name", () => {
    assert.throws(() => buildHerdrEnv("", { PATH: "/usr/bin" }), /SAFETY/);
  });

  it("assertIsolatedSocket refuses the default-session socket", () => {
    const defaultSocket = join(homedir(), ".config", "herdr", "herdr.sock");
    assert.throws(() => assertIsolatedSocket(defaultSocket, "herdr-subagents-test-x"), /SAFETY/);
  });

  it("assertIsolatedSocket refuses another session's socket and empty paths", () => {
    const foreign = join(homedir(), ".config", "herdr", "sessions", "other-session", "herdr.sock");
    assert.throws(() => assertIsolatedSocket(foreign, "herdr-subagents-test-x"), /SAFETY/);
    assert.throws(() => assertIsolatedSocket("", "herdr-subagents-test-x"), /SAFETY/);
  });

  it("assertIsolatedSocket accepts the named test session's socket", () => {
    const own = join(
      homedir(),
      ".config",
      "herdr",
      "sessions",
      "herdr-subagents-test-x",
      "herdr.sock",
    );
    assertIsolatedSocket(own, "herdr-subagents-test-x");
  });
});
