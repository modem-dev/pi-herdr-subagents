/**
 * HerdrEventStream — persistent ndJSON unix-socket client for herdr's
 * events.subscribe API. One global subscription to pane.exited + pane.closed,
 * dispatched locally to per-pane listeners.
 *
 * The ONLY raw-socket code in v1. Request/response ops go through the CLI
 * client (./client.ts); polling/reconcile logic belongs to the watcher — this
 * module only exposes the reconcile *hook* (fired after a resubscribe, since
 * events.subscribe has no replay and events may have been missed in the gap).
 *
 * Verified protocol (herdr 0.7.1):
 *   → {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"}]}}\n
 *   ← {"id":"sub1","result":{"type":"subscription_started"}}
 *   ← {"data":{"pane_id":"w1:p4","type":"pane_exited","workspace_id":"w1"},"event":"pane_exited"}
 * Note: pane.exited carries NO exit code (sidecar file covers that).
 */
import net from "node:net";

export interface HerdrPaneEvent {
  event: "pane_exited" | "pane_closed";
  paneId: string;
}

export interface HerdrEventStream {
  /** Register a listener for a pane. Returns an unwatch function. */
  watch(paneId: string, listener: (ev: HerdrPaneEvent) => void): () => void;
  /**
   * Called after every successful re-subscribe (events may have been missed).
   * Returns an unsubscribe function (watchers must unregister on completion).
   */
  onReconcile(cb: () => void): () => void;
  close(): void;
  /** True while subscribed (ack received, socket open). Diagnostic/test seam. */
  readonly connected: boolean;
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];

export function createHerdrEventStream(opts: {
  socketPath: string;
  signal: AbortSignal;
  backoffMs?: number[];
}): HerdrEventStream {
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const listeners = new Map<string, Set<(ev: HerdrPaneEvent) => void>>();
  const reconcileCallbacks: Array<() => void> = [];

  let socket: net.Socket | null = null;
  let closed = false;
  let connected = false;
  let everSubscribed = false;
  let attempt = 0;
  let requestCounter = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function handleLine(line: string, subscribeId: string): void {
    if (!line.trim()) return;
    let msg: {
      id?: string;
      result?: { type?: string };
      event?: string;
      data?: { pane_id?: string };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // tolerate garbage lines
    }

    if (msg.id === subscribeId && msg.result?.type === "subscription_started") {
      connected = true;
      attempt = 0;
      const isResubscribe = everSubscribed;
      everSubscribed = true;
      if (isResubscribe) {
        for (const cb of [...reconcileCallbacks]) cb();
      }
      return;
    }

    if (msg.event === "pane_exited" || msg.event === "pane_closed") {
      const paneId = msg.data?.pane_id;
      if (!paneId) return;
      const paneListeners = listeners.get(paneId);
      if (!paneListeners) return;
      const ev: HerdrPaneEvent = { event: msg.event, paneId };
      for (const listener of [...paneListeners]) listener(ev);
    }
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closed) return;
    const subscribeId = `sub${++requestCounter}`;
    let buffer = "";
    const sock = net.connect(opts.socketPath);
    socket = sock;

    sock.on("connect", () => {
      sock.write(
        `${JSON.stringify({
          id: subscribeId,
          method: "events.subscribe",
          params: { subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }] },
        })}\n`,
      );
    });

    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line, subscribeId);
      }
    });

    sock.on("error", () => {
      // "close" always follows "error"; reconnect is scheduled there.
    });

    sock.on("close", () => {
      connected = false;
      if (sock === socket) socket = null;
      scheduleReconnect();
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    connected = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.destroy();
    socket = null;
  }

  if (opts.signal.aborted) {
    closed = true;
  } else {
    opts.signal.addEventListener("abort", close, { once: true });
    connect();
  }

  return {
    watch(paneId, listener) {
      let paneListeners = listeners.get(paneId);
      if (!paneListeners) {
        paneListeners = new Set();
        listeners.set(paneId, paneListeners);
      }
      paneListeners.add(listener);
      return () => {
        const set = listeners.get(paneId);
        if (!set) return;
        set.delete(listener);
        if (set.size === 0) listeners.delete(paneId);
      };
    },
    onReconcile(cb) {
      reconcileCallbacks.push(cb);
      return () => {
        const idx = reconcileCallbacks.indexOf(cb);
        if (idx !== -1) reconcileCallbacks.splice(idx, 1);
      };
    },
    close,
    get connected() {
      return connected;
    },
  };
}
