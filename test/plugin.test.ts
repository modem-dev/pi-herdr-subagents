import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pluginDir = resolve("herdr-plugin");
const dispatcher = join(pluginDir, "dispatch.sh");

describe("Herdr plugin dispatcher", () => {
  it("declares the fixed subagent pane entrypoint", () => {
    const manifest = readFileSync(join(pluginDir, "herdr-plugin.toml"), "utf8");
    assert.match(manifest, /^id = "pi-herdr-subagents"$/m);
    assert.match(manifest, /^min_herdr_version = "0\.8\.2"$/m);
    assert.match(manifest, /^id = "subagent"$/m);
    assert.match(
      manifest,
      /^command = \["bash", "-c", "exec bash \\"\$HERDR_PLUGIN_ROOT\/dispatch\.sh\\""\]$/m,
    );
  });

  it("fails clearly when the launch script env is unset or unreadable", () => {
    const unset = spawnSync(dispatcher, [], { env: {}, encoding: "utf8" });
    assert.equal(unset.status, 64);
    assert.match(unset.stderr, /PI_SUBAGENT_LAUNCH_SCRIPT is unset/);

    const unreadable = spawnSync(dispatcher, [], {
      env: { PI_SUBAGENT_LAUNCH_SCRIPT: "/definitely/missing/launch.sh" },
      encoding: "utf8",
    });
    assert.equal(unreadable.status, 66);
    assert.match(unreadable.stderr, /launch script is not readable/);
  });

  it("executes the selected launch script with bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-herdr-dispatch-"));
    try {
      const launchScript = join(dir, "launch.sh");
      writeFileSync(launchScript, 'printf "dispatched\\n"\nexit 7\n');
      const result = spawnSync(dispatcher, [], {
        env: { PI_SUBAGENT_LAUNCH_SCRIPT: launchScript },
        encoding: "utf8",
      });
      assert.equal(result.status, 7);
      assert.equal(result.stdout, "dispatched\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
