# Design note: the full-socket herdr client

**Status:** future work — not scheduled. This documents what an all-socket client would look
like, why we did not build it for v1, and the drafted (not yet filed) upstream feature request
that would remove the exit-code sidecar.

## Where we are today (the hybrid, PLAN.md Key Decision #1)

- **Request/response** (`agent.start`, `pane.get`, `pane.list`, `pane.close`,
  `pane.send_keys`, `ping`) goes through the **`herdr` CLI** as a subprocess per call, with
  JSON envelope parsing (`src/herdr/client.ts`; pattern adapted from pi-herdr, MIT).
- **Event subscription** uses a **raw ndJSON unix-socket connection**
  (`src/herdr/events.ts`): one process-wide `events.subscribe` for `pane.exited` +
  `pane.closed`, with reconnect + reconcile.

Why the split: the herdr **0.7.1 CLI has no `events.subscribe` wrapper** — there is no
`herdr api` subcommand in 0.7.1; that exists only in the docs-"next" tree. Subscription needs a
persistent connection the CLI cannot provide, so the socket client exists *only* for the event
stream, and everything else rides the CLI, which absorbs protocol drift for us.

Verified protocol facts this design rests on (herdr 0.7.1, protocol 14, probed live
2026-07-06):

- Socket path comes from `HERDR_SOCKET_PATH`, injected into every pane (named sessions get
  per-session sockets under `~/.config/herdr/sessions/<name>/` transparently).
- Wire format is newline-delimited JSON. Subscribe request/ack/event shapes:

  ```
  → {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.exited"},{"type":"pane.closed"}]}}
  ← {"id":"sub1","result":{"type":"subscription_started"}}
  ← {"event":"pane_exited","data":{"pane_id":"w1:p4","type":"pane_exited","workspace_id":"w1"}}
  ```

- `pane.exited` carries **no exit code**, and pane records vanish on exit — hence the
  `<session>.exitcode` sidecar written by the wrapper script (Key Decision #6).
- Global `pane.exited`/`pane.closed` subscriptions work without a `pane_id`;
  `pane.agent_status_changed` requires a per-pane `pane_id`.
- `events.subscribe` has **no replay**: events during a disconnect are gone, so reconnect must
  reconcile (we `pane list` and treat watched-but-missing panes as exited).

## What full-socket would look like

One persistent connection per pi process, owned by a `HerdrSocketClient`:

- **Correlation**: every request gets a monotonically increasing `id`; responses are matched
  by `id` to pending promises. Push events (no `id`, an `event` field) are dispatched to the
  existing subscription fan-out. This merges `client.ts` and `events.ts` into one connection
  state machine.
- **Bootstrap + cache**: on connect, call `session.snapshot` and keep a local cache of
  pane/agent records, updated from events. The socket-api docs are explicit about this shape:

  > `session.snapshot` returns a one-time bootstrap snapshot for clients that keep their own
  > local runtime cache. […] It is not a subscription; after reading it, subscribe to resource
  > events and update the local cache from those events. Call `session.snapshot` again after
  > reconnecting or when the local cache may be stale.

  Reconnect therefore becomes: reconnect → re-subscribe → re-snapshot → diff against watched
  panes (subsuming today's `pane list` reconcile).
- **Typed method map** for the ~8 methods we actually use: `ping`, `session.snapshot`,
  `agent.start`, `pane.list`, `pane.get`, `pane.close`, `pane.send_keys`, `events.subscribe`
  (request/response/event types generated or hand-written against `herdr api schema --json`
  once the CLI ships it).
- The `ExecFn` unit-test seam is replaced by a scripted-socket seam (we already test
  `events.ts` against a real `net.createServer` on a temp socket path — that harness
  generalizes).

### Gains

- No subprocess per request (today: fork+exec of the CLI for every spawn/list/close/ping).
- Atomic view of the session (snapshot + ordered events, no CLI-call interleaving).
- Lower latency; matters little at subagent scale (spawns are ~12ms via CLI already).

### Costs

- We own protocol-version drift the CLI currently absorbs (request shapes, envelope changes,
  version negotiation against `ping.protocol`).
- Platform differences (Windows named pipes vs unix sockets) become our problem.
- More mocking surface: every request/response test needs the scripted socket instead of
  canned CLI envelopes.

## Trigger conditions for revisiting

Build the full-socket client when any of these lands:

1. **`herdr api` CLI ships in a released herdr** (schema available via
   `herdr api schema --json` → typed method map becomes cheap and drift-checkable).
2. **`pane.exited` gains `exit_code`** (see FR below) — the sidecar dies, and the watcher
   becomes pure-socket, at which point the hybrid's remaining CLI half is mostly launch.
3. Subprocess overhead becomes measurable (e.g. very high spawn/list frequency).

## Drafted upstream feature request (NOT yet filed)

To be filed against `ogulcancelik/herdr` when ready
(`gh issue create --repo ogulcancelik/herdr`). Once implemented upstream, the
`<session>.exitcode` sidecar and its watcher path can be deleted.

> **Title:** Include exit code in `pane.exited` event payload
>
> **Body:**
>
> When a pane's process exits, the socket API emits `pane.exited`:
>
> ```json
> {"event":"pane_exited","data":{"pane_id":"w1:p4","type":"pane_exited","workspace_id":"w1"}}
> ```
>
> The payload carries no exit code, and the pane record is already gone by the time the event
> is observable (`pane.get` returns not-found), so a socket client cannot distinguish a clean
> exit from a crash.
>
> **Use case:** pi-herder-subagents launches pi subagents via `agent start … -- <argv>` and
> classifies their lifecycle from socket events. "Exited 0" vs "exited nonzero" is the
> difference between *completed* and *crashed / failed to launch* — e.g. a typo'd `--model`
> makes the child exit nonzero within a second, and we want to report that truthfully. Today we
> work around it with a wrapper script that writes the exit code to a sidecar file
> (`<session>.exitcode`), which adds a wrapper layer to what could be a plain argv launch and a
> filesystem watch to what could be pure socket observation.
>
> **Request:** add the child process's exit status to the `pane.exited` payload, e.g.
>
> ```json
> {"event":"pane_exited","data":{"pane_id":"w1:p4","type":"pane_exited","workspace_id":"w1","exit_code":1}}
> ```
>
> (or `exit_code: null` plus a `signal` field when the process was signal-killed). Observed on
> herdr 0.7.1 / protocol 14.

## References

- herdr repo `docs/next/website/src/content/docs/socket-api.mdx` — raw methods, snapshot
  guidance, event subscription shapes
- `src/herdr/client.ts`, `src/herdr/events.ts` — the current hybrid implementation
