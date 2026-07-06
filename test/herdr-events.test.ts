import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHerdrEventStream, type HerdrEventStream } from "../src/herdr/events.ts";

interface FakeConn {
  socket: net.Socket;
  requests: Array<Record<string, unknown>>;
  push(event: Record<string, unknown>): void;
  pushRaw(text: string): void;
  destroy(): void;
}

class FakeHerdrServer {
  readonly path: string;
  readonly connections: FakeConn[] = [];
  private readonly server: net.Server;
  private readonly tmpDir: string;
  private waiters: Array<(conn: FakeConn) => void> = [];

  private constructor(tmpDir: string, server: net.Server) {
    this.tmpDir = tmpDir;
    this.path = join(tmpDir, "test.sock");
    this.server = server;
  }

  static async start(): Promise<FakeHerdrServer> {
    const tmpDir = mkdtempSync(join(tmpdir(), "herder-ev-"));
    const server = net.createServer();
    const fake = new FakeHerdrServer(tmpDir, server);
    server.on("connection", (socket) => {
      const conn: FakeConn = {
        socket,
        requests: [],
        push(event) {
          socket.write(`${JSON.stringify(event)}\n`);
        },
        pushRaw(text) {
          socket.write(text);
        },
        destroy() {
          socket.destroy();
        },
      };
      fake.connections.push(conn);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          const request = JSON.parse(line) as Record<string, unknown>;
          conn.requests.push(request);
          if (request.method === "events.subscribe") {
            socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
            const waiter = fake.waiters.shift();
            if (waiter) waiter(conn);
          }
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(fake.path, resolve));
    return fake;
  }

  /** Resolves when the next connection has sent events.subscribe (and been acked). */
  nextSubscribed(): Promise<FakeConn> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async close(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HerdrEventStream", () => {
  let server: FakeHerdrServer | null = null;
  let stream: HerdrEventStream | null = null;
  let controller: AbortController | null = null;

  afterEach(async () => {
    stream?.close();
    stream = null;
    controller = null;
    await server?.close();
    server = null;
  });

  async function connect(backoffMs: number[] = [10]) {
    server = await FakeHerdrServer.start();
    controller = new AbortController();
    const subscribed = server.nextSubscribed();
    stream = createHerdrEventStream({
      socketPath: server.path,
      signal: controller.signal,
      backoffMs,
    });
    const conn = await subscribed;
    return { server, stream, controller, conn };
  }

  it("subscribes and receives ack", async () => {
    const { stream, conn } = await connect();
    await waitFor(() => stream.connected);

    assert.equal(conn.requests.length, 1);
    const request = conn.requests[0];
    assert.equal(request.method, "events.subscribe");
    assert.ok(request.id);
    assert.deepEqual(request.params, {
      subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }],
    });
  });

  it("dispatches pane_exited to registered listener by pane_id", async () => {
    const { stream, conn } = await connect();
    await waitFor(() => stream.connected);

    const received: Array<{ event: string; paneId: string }> = [];
    stream.watch("w1:p4", (ev) => received.push(ev));

    conn.push({
      data: { pane_id: "w1:p4", type: "pane_exited", workspace_id: "w1" },
      event: "pane_exited",
    });

    await waitFor(() => received.length > 0);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { event: "pane_exited", paneId: "w1:p4" });
  });

  it("event for unwatched pane is ignored", async () => {
    const { stream, conn } = await connect();
    await waitFor(() => stream.connected);

    const received: unknown[] = [];
    stream.watch("w1:p4", (ev) => received.push(ev));

    conn.push({
      data: { pane_id: "w1:p9", type: "pane_exited", workspace_id: "w1" },
      event: "pane_exited",
    });
    // follow with a watched-pane event to prove the stream survived and ordering held
    conn.push({
      data: { pane_id: "w1:p4", type: "pane_closed", workspace_id: "w1" },
      event: "pane_closed",
    });

    await waitFor(() => received.length > 0);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { event: "pane_closed", paneId: "w1:p4" });
  });

  it("partial lines are buffered", async () => {
    const { stream, conn } = await connect();
    await waitFor(() => stream.connected);

    const received: Array<{ event: string; paneId: string }> = [];
    stream.watch("w1:p4", (ev) => received.push(ev));

    const line = `${JSON.stringify({
      data: { pane_id: "w1:p4", type: "pane_exited", workspace_id: "w1" },
      event: "pane_exited",
    })}\n`;
    const splitAt = Math.floor(line.length / 2);
    conn.pushRaw(line.slice(0, splitAt));
    await sleep(20);
    assert.equal(received.length, 0, "half a line must not dispatch");
    conn.pushRaw(line.slice(splitAt));

    await waitFor(() => received.length > 0);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { event: "pane_exited", paneId: "w1:p4" });
  });

  it("reconnects after disconnect and calls onReconcile", async () => {
    const { server, stream, conn } = await connect([10, 10]);
    await waitFor(() => stream.connected);

    let reconciles = 0;
    stream.onReconcile(() => reconciles++);

    const resubscribed = server.nextSubscribed();
    conn.destroy();
    const conn2 = await resubscribed;
    await waitFor(() => stream.connected);
    await waitFor(() => reconciles > 0);
    assert.equal(reconciles, 1);

    // listeners survive the reconnect
    const received: Array<{ event: string; paneId: string }> = [];
    stream.watch("w1:p4", (ev) => received.push(ev));
    conn2.push({
      data: { pane_id: "w1:p4", type: "pane_exited", workspace_id: "w1" },
      event: "pane_exited",
    });
    await waitFor(() => received.length > 0);
    assert.equal(received[0].event, "pane_exited");
  });

  it("onReconcile returns an unsubscribe function", async () => {
    const { server, stream, conn } = await connect([10, 10]);
    await waitFor(() => stream.connected);

    let kept = 0;
    let removed = 0;
    stream.onReconcile(() => kept++);
    const off = stream.onReconcile(() => removed++);
    off();

    const resubscribed = server.nextSubscribed();
    conn.destroy();
    await resubscribed;
    await waitFor(() => kept > 0);
    assert.equal(kept, 1);
    assert.equal(removed, 0, "unsubscribed callback must not fire");
  });

  it("abort signal closes socket and stops reconnecting", async () => {
    const { server, stream, controller } = await connect([10, 10]);
    await waitFor(() => stream.connected);
    const connectionsBefore = server.connections.length;

    controller.abort();
    await waitFor(() => !stream.connected);

    // give any (buggy) reconnect attempts time to happen
    await sleep(100);
    assert.equal(server.connections.length, connectionsBefore, "no new connections after abort");
  });

  it("unwatch stops dispatch", async () => {
    const { stream, conn } = await connect();
    await waitFor(() => stream.connected);

    const received: unknown[] = [];
    const unwatch = stream.watch("w1:p4", (ev) => received.push(ev));
    unwatch();

    const witnessed: unknown[] = [];
    stream.watch("w1:p5", (ev) => witnessed.push(ev));

    conn.push({ data: { pane_id: "w1:p4", type: "pane_exited" }, event: "pane_exited" });
    conn.push({ data: { pane_id: "w1:p5", type: "pane_exited" }, event: "pane_exited" });

    await waitFor(() => witnessed.length > 0);
    assert.equal(received.length, 0);
  });
});
