import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createHerdrClient, type ExecFn } from "../src/herdr/client.ts";

interface ExecCall {
  cmd: string;
  args: string[];
}

function fakeExec(responses: Array<{ stdout?: string; stderr?: string; code?: number }>): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const queue = [...responses];
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    const next = queue.shift();
    if (!next) throw new Error("fakeExec: no more scripted responses");
    return { stdout: next.stdout ?? "", stderr: next.stderr ?? "", code: next.code ?? 0 };
  };
  return { exec, calls };
}

const paneSplitEnvelope = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: {
      pane_id: "w1:p2",
      terminal_id: "term_abc123",
      workspace_id: "w1",
      tab_id: "w1:t1",
    },
    type: "pane_info",
  },
});

describe("HerdrClient", () => {
  it("paneStart builds correct argv", async () => {
    const { exec, calls } = fakeExec([{ stdout: paneSplitEnvelope }]);
    const client = createHerdrClient({ exec });

    const result = await client.paneStart({
      name: "worker-1",
      cwd: "/tmp/project",
      targetPaneId: "w1:p1",
      direction: "right",
      argv: ["bash", "/tmp/launch.sh"],
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "herdr");
    assert.deepEqual(calls[0].args, [
      "pane",
      "split",
      "--pane",
      "w1:p1",
      "--direction",
      "right",
      "--cwd",
      "/tmp/project",
      "--no-focus",
      "--",
      "bash",
      "/tmp/launch.sh",
    ]);
    assert.deepEqual(result, {
      paneId: "w1:p2",
      terminalId: "term_abc123",
      workspaceId: "w1",
      tabId: "w1:t1",
    });
  });

  it("paneStart defaults direction right and omits --pane without a target", async () => {
    const { exec, calls } = fakeExec([{ stdout: paneSplitEnvelope }]);
    const client = createHerdrClient({ exec });

    await client.paneStart({
      name: "worker-1",
      cwd: "/tmp/project",
      argv: ["bash", "/tmp/launch.sh"],
    });

    const args = calls[0].args;
    assert.equal(args.indexOf("--pane"), -1);
    assert.equal(args[args.indexOf("--direction") + 1], "right");
  });

  it("paneStart passes env vars as --env flags", async () => {
    const { exec, calls } = fakeExec([{ stdout: paneSplitEnvelope }]);
    const client = createHerdrClient({ exec });

    await client.paneStart({
      name: "worker-1",
      cwd: "/tmp/project",
      env: { PI_SUBAGENT_ID: "abc", FOO: "bar" },
      argv: ["bash", "/tmp/launch.sh"],
    });

    const args = calls[0].args;
    const envIdx = args.indexOf("--env");
    assert.notEqual(envIdx, -1);
    assert.equal(args[envIdx + 1], "PI_SUBAGENT_ID=abc");
    assert.equal(args[envIdx + 2], "--env");
    assert.equal(args[envIdx + 3], "FOO=bar");
    // env flags must come before the -- argv separator
    assert.ok(envIdx < args.indexOf("--"));
  });

  it("paneRename shells out to pane rename and only demands exit 0", async () => {
    const { exec, calls } = fakeExec([{ stdout: "" }]);
    const client = createHerdrClient({ exec });

    await client.paneRename("w1:p2", "Worker");

    assert.deepEqual(calls[0].args, ["pane", "rename", "w1:p2", "Worker"]);
  });

  it("error envelope surfaces code+message", async () => {
    const errorEnvelope = JSON.stringify({
      error: { code: "pane_not_found", message: "pane w1:p4 not found" },
      id: "x",
    });

    // exit 0 with error envelope on stdout
    {
      const { exec } = fakeExec([{ stdout: errorEnvelope, code: 0 }]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneClose("w1:p4"),
        (err: Error) =>
          err.message.includes("pane_not_found") || err.message.includes("pane w1:p4 not found"),
      );
    }

    // nonzero exit with error envelope on stderr
    {
      const { exec } = fakeExec([{ stderr: errorEnvelope, code: 1 }]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneClose("w1:p4"),
        (err: Error) =>
          err.message.includes("pane_not_found") || err.message.includes("pane w1:p4 not found"),
      );
    }
  });

  it("nonzero exit with non-JSON stderr", async () => {
    const { exec } = fakeExec([{ stderr: "herdr: connection refused", code: 1 }]);
    const client = createHerdrClient({ exec });
    await assert.rejects(
      () => client.paneList(),
      (err: Error) => err.message.includes("herdr: connection refused"),
    );
  });

  it("paneGet returns null for pane_not_found, throws for other errors", async () => {
    const notFound = JSON.stringify({
      error: { code: "pane_not_found", message: "pane w1:p9 not found" },
      id: "x",
    });
    {
      const { exec } = fakeExec([{ stdout: notFound, code: 1 }]);
      const client = createHerdrClient({ exec });
      assert.equal(await client.paneGet("w1:p9"), null);
    }
    {
      const { exec } = fakeExec([
        {
          stdout: JSON.stringify({ error: { code: "internal_error", message: "boom" }, id: "x" }),
          code: 1,
        },
      ]);
      const client = createHerdrClient({ exec });
      await assert.rejects(
        () => client.paneGet("w1:p9"),
        (err: Error) => err.message.includes("boom") || err.message.includes("internal_error"),
      );
    }
    // success case parses the pane record
    {
      const paneEnvelope = JSON.stringify({
        id: "x",
        result: {
          type: "pane_info",
          pane: { pane_id: "w1:p2", terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1" },
        },
      });
      const { exec, calls } = fakeExec([{ stdout: paneEnvelope }]);
      const client = createHerdrClient({ exec });
      const pane = await client.paneGet("w1:p2");
      assert.deepEqual(calls[0].args, ["pane", "get", "w1:p2"]);
      assert.equal(pane?.pane_id, "w1:p2");
    }
  });

  it("paneList returns panes array", async () => {
    const envelope = JSON.stringify({
      id: "x",
      result: {
        type: "pane_list",
        panes: [{ pane_id: "w1:p1" }, { pane_id: "w1:p2" }],
      },
    });
    const { exec, calls } = fakeExec([{ stdout: envelope }]);
    const client = createHerdrClient({ exec });
    const panes = await client.paneList();
    assert.deepEqual(calls[0].args, ["pane", "list"]);
    assert.deepEqual(
      panes.map((p) => p.pane_id),
      ["w1:p1", "w1:p2"],
    );
  });

  it("paneClose issues pane close", async () => {
    const { exec, calls } = fakeExec([
      { stdout: JSON.stringify({ id: "x", result: { type: "pane_closed" } }) },
    ]);
    const client = createHerdrClient({ exec });
    await client.paneClose("w1:p3");
    assert.deepEqual(calls[0].args, ["pane", "close", "w1:p3"]);
  });

  it("paneSendKeys sends keys — success prints NOTHING (verified live, herdr 0.7.1)", async () => {
    const { exec, calls } = fakeExec([{ stdout: "" }]);
    const client = createHerdrClient({ exec });
    await client.paneSendKeys("w1:p3", ["escape"]);
    assert.deepEqual(calls[0].args, ["pane", "send-keys", "w1:p3", "escape"]);
  });

  it("paneSendKeys surfaces the error envelope on failure", async () => {
    const { exec } = fakeExec([
      {
        stdout: JSON.stringify({
          error: { code: "pane_not_found", message: "pane w1:p3 not found" },
          id: "cli:request",
        }),
        code: 1,
      },
    ]);
    const client = createHerdrClient({ exec });
    await assert.rejects(() => client.paneSendKeys("w1:p3", ["esc"]), /pane_not_found/);
  });

  it("ping returns protocol/version info", async () => {
    const statusJson = JSON.stringify({
      status: "running",
      running: true,
      version: "0.7.1",
      protocol: 14,
      socket: "/tmp/herdr.sock",
    });
    {
      const { exec, calls } = fakeExec([{ stdout: statusJson }]);
      const client = createHerdrClient({ exec });
      const ping = await client.ping();
      assert.deepEqual(calls[0].args, ["status", "server", "--json"]);
      assert.equal(ping.ok, true);
      assert.equal(ping.version, "0.7.1");
      assert.equal(ping.protocol, 14);
    }
    // not running → ok: false, no throw
    {
      const { exec } = fakeExec([
        {
          stdout: JSON.stringify({
            status: "not_running",
            running: false,
            version: null,
            protocol: null,
          }),
        },
      ]);
      const client = createHerdrClient({ exec });
      const ping = await client.ping();
      assert.equal(ping.ok, false);
    }
  });

  it("herdr binary resolution", async () => {
    const envelope = JSON.stringify({ id: "x", result: { type: "pane_list", panes: [] } });

    // default: "herdr"
    {
      const prev = process.env.HERDR_BIN;
      delete process.env.HERDR_BIN;
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec }).paneList();
        assert.equal(calls[0].cmd, "herdr");
      } finally {
        if (prev !== undefined) process.env.HERDR_BIN = prev;
      }
    }

    // HERDR_BIN env override
    {
      const prev = process.env.HERDR_BIN;
      process.env.HERDR_BIN = "/opt/custom/herdr";
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec }).paneList();
        assert.equal(calls[0].cmd, "/opt/custom/herdr");
      } finally {
        if (prev === undefined) delete process.env.HERDR_BIN;
        else process.env.HERDR_BIN = prev;
      }
    }

    // constructor opt wins over env
    {
      const prev = process.env.HERDR_BIN;
      process.env.HERDR_BIN = "/opt/custom/herdr";
      try {
        const { exec, calls } = fakeExec([{ stdout: envelope }]);
        await createHerdrClient({ exec, bin: "/opt/explicit/bin/herdr" }).paneList();
        assert.equal(calls[0].cmd, "/opt/explicit/bin/herdr");
      } finally {
        if (prev === undefined) delete process.env.HERDR_BIN;
        else process.env.HERDR_BIN = prev;
      }
    }
  });
});
