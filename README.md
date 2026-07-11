# pi-herdr-subagents

Interactive subagent orchestration for [pi](https://github.com/earendil-works/pi), built natively
on [herdr](https://github.com/ogulcancelik/herdr) — spawn, resume, and interrupt subagents in
herdr panes with truthful lifecycle events. **Fully non-blocking**: the orchestrator keeps
working while subagents run; results are steered back as async messages that wake it up.

## Origins & credit

This extension is a herdr-native descendant of
[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) by
[HazAT](https://github.com/HazAT). I used that extension daily for months and it completely
changed how I structure my agent work. The orchestration model here is its design — spawn
subagents into visible terminal surfaces, keep working, get woken by steer messages when they
finish, resume/interrupt/list, markdown agent definitions — and several modules are direct
ports (see [License](#license)). I've also contributed improvements upstream. If you work in
tmux, cmux, zellij, or wezterm — or need Claude Code children — use pi-interactive-subagents;
it's excellent.

## Why a separate herdr-native extension

pi-interactive-subagents drives its four muxes through one generic backend mechanism: create a
pane, wait for its interactive shell, *type a launch command into it*, verify startup with
retries, and poll the screen for a completion sentinel. Its hardest reliability edge cases
trace back to that open-loop mechanism — a shell still running direnv/devenv init can swallow
the typed command, and a dead child looks like a screen that stopped changing (the war story is
in [`docs/PROJECT-BRIEF.md`](docs/PROJECT-BRIEF.md)).

To be fair: that mechanism is an implementation choice more than a hard limit of the muxes.
tmux, zellij, and wezterm can all launch a command directly at pane creation, and sidecar files
can replace screen scraping — pi-interactive-subagents could plausibly be retrofitted with
per-backend launch and lifecycle adapters (cmux's currently exposed CLI is the awkward one, and
push-style lifecycle events aren't uniformly available). But that retrofit is a substantial
refactor multiplied across every backend and both of its launch paths. Rather than carry that
surface area, this extension targets herdr only and uses its native primitives directly:

- **argv process launch** (`herdr agent start … -- bash <script>`): the child is started as a
  direct process. No shell, no typing, no delays — **the launch race cannot happen, by
  construction**. There is no verify/retry machinery because there is nothing to verify.
- **Socket events** (`events.subscribe` → `pane.exited` / `pane.closed`): a child that dies is
  an observable event within milliseconds, not a screen that stopped changing.

## Requirements

- **herdr ≥ 0.7.1** (protocol 14 — pinned; the extension pings the socket at session start and
  warns if the server is unreachable)
- **pi running inside a herdr pane.** herdr injects `HERDR_ENV`, `HERDR_PANE_ID`, and
  `HERDR_SOCKET_PATH` into every pane; the extension activates only when they are present.
- **pi children only.** Claude Code / codex subagents are an explicit non-goal — if you need
  them, use [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents).
  Agent defs with `cli: claude` produce a clear "unsupported" error.
- node ≥ 22.

## Setup

Install as a pi package (add to `~/.pi/agent/settings.json`):

```jsonc
{
  "packages": [
    "/path/to/pi-herdr-subagents"   // local checkout; or a git: URL once published
  ]
}
```

Then start herdr in your terminal and run pi in a pane:

```bash
herdr          # opens the multiplexer
# in a pane:
pi
```

The `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` tools plus the
`/subagent` and `/iterate` commands appear automatically.

**Outside herdr** the extension registers nothing at load. At `session_start`, if no other
extension provides a `subagent` tool, it registers setup-hint stubs that explain how to run pi
inside herdr (so the model gets a clear answer instead of a missing tool). If another extension
already provides `subagent` (e.g. pi-interactive-subagents in tmux), it registers nothing and
the other extension wins cleanly.

## Transition: running side-by-side with pi-interactive-subagents

Tool names are **identical by design**: agent-def `spawning: false` / `deny-tools` frontmatter
gates the exact names `subagent`, `subagent_resume`, `subagent_interrupt`, `subagents_list`,
and existing orchestrator prompts reference those names in prose. pi resolves duplicate tool
names **first-loaded-extension-wins, silently** — so ordering matters:

> **List `pi-herdr-subagents` BEFORE `pi-interactive-subagents` in `packages`.**

Behavior matrix during the transition:

| pi is running… | active provider |
|---|---|
| inside a herdr pane | **pi-herdr-subagents** (registers at load, wins the race) |
| inside tmux/cmux/zellij/wezterm | pi-interactive-subagents (this extension stays silent) |
| outside any mux | whichever is loaded; ours only adds setup-hint stubs if nothing else provides `subagent` |

If this extension is inside herdr but *lost* the registry race (loaded after another `subagent`
provider), it emits a visible `session_start` warning telling you to fix the package order —
it never fails silently.

No relation to [pi-herdr](https://github.com/ogulcancelik/pi-extensions) (the generic
user-facing pane tool): no dependency in either direction, no name collisions (`herdr` vs
`subagent*`); they coexist fine.

## Configuration

All configuration is via environment variables (set globally, or per-project via `.envrc`):

| Variable | Default | Effect |
|---|---|---|
| `PI_HERDR_LAUNCH_PREFIX` | *(unset)* | Template for the command wrapping the child pi invocation; `{cwd}` is interpolated shell-escaped. **If defined (even empty) it replaces direnv autodetection**; empty string disables wrapping entirely. Examples: `direnv exec {cwd}` (the autodetect default), `mise exec --`, `nix develop {cwd} -c`. |
| `PI_HERDR_PI_BIN` | first executable `pi` on `PATH` | Absolute path of the pi binary to launch children with (e.g. `~/.local/bin/pi`). |
| `PI_HERDR_DIRENV` | *(unset)* | Set to `0` to disable the `direnv exec` autodetect (see below). |
| `PI_HERDR_HOLD_OPEN_SECS` | `15` | Startup-crash window: if the child exits nonzero within this many seconds, the pane is held open for post-mortem (`0` disables). |
| `HERDR_BIN` | `herdr` on `PATH` | herdr binary override. |

### direnv / devenv / varlock repos

Spawning into a repo whose environment lives behind direnv (devenv, nix, varlock-managed
secrets) is a first-class case — it is exactly where typed-launch muxes fail. The generated
launch script exports the **orchestrator's PATH** plus curated `PI_SUBAGENT_*` vars (never a
full env dump), and when the child's effective cwd (or an ancestor, up to `$HOME`) has an
`.envrc`, the pi invocation is wrapped in `direnv exec '<cwd>'`. That wrap materializes the
devenv environment — node, pnpm, postgres, project env vars — before pi starts. If your `pi`
is itself a wrapper that needs in-env tools (e.g. varlock for 1Password-backed secrets), it
runs inside that environment and just works; the extension needs zero knowledge of it. The
whole chain — launch script → `direnv exec` → devenv PATH → pi wrapper → varlock — is covered
by an integration test against a real devenv checkout (`test/integration/direnv-env.test.ts`).
Set `PI_HERDR_DIRENV=0` or an explicit `PI_HERDR_LAUNCH_PREFIX` to override.

## Tools & commands

| Tool | Description |
|---|---|
| `subagent` | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately) |
| `subagent_resume` | Resume a previous sub-agent session in a new pane (async) |
| `subagent_interrupt` | Send Escape to a running subagent's active turn |
| `subagents_list` | List available agent definitions (project-local `.pi/agents/` overrides global) |

| Command | Description |
|---|---|
| `/subagent <agent> [task]` | Spawn a named agent directly |
| `/iterate [task]` | Fork the current session into a subagent for focused work |

Agent definitions in `~/.pi/agent/agents/*.md` are read with the same frontmatter semantics as
pi-interactive-subagents (name, description, tools, deny-tools, model, thinking, spawning,
auto-exit, interactive, session-mode, systemPromptMode, …) — the same defs drive both
extensions during the transition. A `subagent_done` / `caller_ping` child extension is loaded
into every child for the completion handshake.

## Lifecycle: every child ends in exactly one honest state

The watcher classifies each child from socket events + sidecar files. There is **no path to an
eternal "stalled" zombie** — every row below terminates the running entry with a steer message:

| What happened | Steer you get |
|---|---|
| child called `subagent_done` | `completed` + summary (last assistant message) |
| child called `caller_ping` | `subagent_ping` + the child's question + session path |
| user drove the child and quit pi without `subagent_done` | distinct honest phrasing: *"closed by user, no subagent_done"* + last message + session path |
| child exited nonzero within the startup window (e.g. bad `--model`) | `failed to launch (exit code N)` + pane id + launch script path; pane held open for post-mortem |
| child crashed later | exit code + last message + session path (resumable) |
| pane killed externally (no sidecars) | honest failure steer + session path (resumable) |
| pane vanished while the event stream was down | classified from on-disk sidecars, else *"ended while event stream was down"* |

## Differences vs pi-interactive-subagents

- **No launch race, by construction.** argv launch replaces type-into-shell; the shell-ready
  delay, launch verify/retry loop, and sentinel screen polling have no analog here.
- **Truthful crash/lifecycle steers.** `pane.exited` + exit-code sidecar give immediate, honest
  launch-failure and crash reporting (a bad `--model` used to produce a silent zombie).
- **No stall-status machinery.** The `starting/active/waiting/stalled` state machine and
  activity files are gone — herdr's sidebar shows semantic per-pane agent state, and dead
  children can no longer masquerade as "stalled". The status widget is a slim
  name/agent/elapsed/count list.
- **Distinct user-exit phrasing.** A user quitting a child without `subagent_done` is reported
  as exactly that, not as a generic completion.
- **pi children only.** No Claude Code CLI path, no transcript-copy machinery.
- **Panes auto-close** on clean exit (held open only for startup crashes).
- **herdr only.** No cmux/tmux/zellij/wezterm code paths.

## Debugging

Artifacts live under the orchestrator's session dir, same convention as
pi-interactive-subagents — `<sessionDir>/artifacts/<session-id>/`:

```
artifacts/<session-id>/
├── context/<name>-<ts>.md            # task handoff file (child's initial @-message)
├── context/<name>-sysprompt-<ts>.md  # system prompt file (when the agent def provides one)
├── subagent-scripts/<name>-<id>.sh   # the generated launch script (the single source of truth
│                                     #   for env exports, direnv wrap, pi argv)
└── subagent-resume/<name>-<ts>.md    # resume follow-up messages
```

Next to each child session file (`…/sessions/<encoded-cwd>/<ts>_<id>.jsonl`):

- `<session>.exit` — semantic completion sidecar written by the child
  (`{"type":"done"}` or `{"type":"ping",…}`)
- `<session>.exitcode` — process exit code written by the wrapper script

Useful tricks:

- **Startup crashes hold the pane open** (default 15s window) with the error visible — read it,
  then press Enter in the pane to close.
- **Re-run any launch by hand**: `bash <artifacts>/subagent-scripts/<name>-<id>.sh` reproduces
  the exact child environment and invocation.
- Every failure steer carries the child session path; `pi --session <path>` resumes it, or use
  `subagent_resume`.

## Known limitations / upstream notes

- **Exit-code sidecar**: herdr's `pane.exited` event carries no exit code and pane records
  vanish on exit, so the wrapper script writes `<session>.exitcode`. A herdr feature request
  for `exit_code` on `pane.exited` is drafted (not yet filed) in
  [`docs/full-socket-client.md`](docs/full-socket-client.md) — once it lands, the sidecar can
  be deleted.
- **No stall detection** (yet): a child that is alive but spinning its wheels is not flagged;
  herdr's sidebar agent states are the current signal. Could be reintroduced on
  `pane.agent_status_changed`.
- **Single-workspace topology**: children split into the orchestrator's tab
  (`--tab $HERDR_TAB_ID --split right`); multi-workspace layouts are unexplored.
- **Hybrid client**: request/response goes through the `herdr` CLI; only `events.subscribe`
  uses a raw socket connection. The all-socket design (and when to switch) is sketched in
  [`docs/full-socket-client.md`](docs/full-socket-client.md).

## Development

```bash
npm test                  # unit suite (mocked herdr boundary), ~0.6s
npm run test:integration  # real pi children in an isolated named herdr session
                          # (needs herdr + tmux + model auth; skips cleanly otherwise)
```

The integration harness creates its own tmux session and named herdr session
(`herdr-subagents-test-<pid>-…`), points `PI_CODING_AGENT_DIR` at a temp dir, and refuses to
run against the default herdr socket — your live sessions and global pi config are never
touched.

## License

MIT. Portions (agent-def parsing, session seeding, steer formats, child extension) ported from
[pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) (MIT, HazAT);
herdr CLI envelope-parsing pattern adapted from
[pi-herdr](https://github.com/ogulcancelik/pi-extensions) (MIT).
