# pi-herdr-subagents — Project Brief / Spec

**Date:** 2026-07-06.

## WHAT we are building

A new pi extension that provides **interactive subagent orchestration designed natively around
herdr** (https://github.com/ogulcancelik/herdr — "agent multiplexer that lives in your terminal").
It works *similarly to* `pi-interactive-subagents` (HazAT) from the orchestrating agent's point of
view — spawn/resume/interrupt subagents in visible terminal surfaces, get woken by steer messages
on completion — but supports **only herdr**, no tmux/cmux/zellij/wezterm.

### Why a new extension instead of adding herdr to pi-interactive-subagents

`pi-interactive-subagents` is built on the **least-common-denominator of four terminal muxes**:
split a pane → wait a fixed delay → *type keystrokes into an interactive shell* → scrape the
screen for a `__SUBAGENT_DONE_N__` sentinel. Every serious reliability problem we've debugged is a
direct consequence of that LCD:

- **The launch race** (documented in internal race-investigation notes): typed launch commands are *flushed* by direnv/devenv
  shell init (reproduced 100% in a large direnv+devenv work checkout, swallow threshold ~0.5–1s even warm). We
  fixed this with guarded launch scripts + a verify/retry loop
  (a local pi-interactive-subagents branch `fix/launch-verify-retry`) — a closed feedback loop
  bolted onto an inherently open-loop mechanism.
- **Dishonest lifecycle state**: a never-started child used to register "running" and emit
  "stalled 1m" steer messages forever (fixed on that branch with a launch-failed state).
- **Screen-scrape completion detection**: `pollForExit` reads pane text looking for a sentinel;
  plus an `.exit` sidecar file fast-path.
- Upstream PR #57 (HazAT/pi-interactive-subagents) adds herdr as a *fifth LCD backend* — it types
  commands via `herdr pane run` and reads screens, ignoring herdr's actual primitives. Wrong level.

herdr's socket API provides exactly the primitives the LCD lacks (verified hands-on 2026-07-06
with herdr 0.7.1 driven headless):

- **`herdr agent start <name> --cwd .. --env K=V --no-focus -- <argv...>`** — launches the agent
  as a direct **argv process**. No shell, no typing, no launch race *by construction*. Returns
  pane id + agent record in ~12ms. Verified: launched pi in a devenv-poisoned cwd successfully.
- **Semantic agent state** — herdr detects agents (there is a `pi.toml` detection manifest
  in-tree: `working` when screen shows `Working...`, idle fallback) and rolls up
  idle/working/blocked/done per pane/tab/workspace in its sidebar.
- **`herdr wait agent-status <pane> --status done|idle|blocked` and `herdr wait output --match`**
  — one-shot blocking waits. Verified: `--status working` resolved 0.2s after submitting a
  prompt; `--status idle` unblocked when the pi turn finished (~9s).
- **`events.subscribe`** (raw socket, newline-delimited JSON) — push events: `pane.exited`,
  `pane.closed`, `pane.agent_status_changed`, `pane.created`, worktree/workspace/tab lifecycle.
- **`pane.report_agent` / `pane.report_metadata`** — a child process can *self-report* semantic
  state and display metadata (deep-integration path: pi extension inside the child reports
  working/blocked/done instead of relying on screen detection).
- **`notification.show`**, git **worktree** management, **named sessions**
  (`--session <name>`, per-session socket), remote via ssh (`herdr --remote`).

Design consequence: the child-exit sidecar (`.exit` file) plus herdr events can fully replace
sentinel screen-scraping; argv launch fully replaces the delay/type/verify/retry machinery; and
`pane.exited` gives truthful, immediate launch/crash failure (e.g. a bad `--model` typo in an
agent def previously produced a silent zombie — with herdr the pane exit is an observable event).

## HARD REQUIREMENTS

1. **herdr-only.** If pi is not running inside a herdr pane (`HERDR_ENV=1`/`HERDR_PANE_ID` env)
   or the socket is unreachable, tools report a clear setup hint. No other mux code paths.
2. **Agent-definition compatibility.** MUST read the same `~/.pi/agent/agents/*.md` files with
   the same frontmatter semantics as pi-interactive-subagents (name, description, tools,
   deny-tools, model, thinking, spawning, auto-exit, interactive, cli, session-mode,
   disable-model-invocation, systemPromptMode — audit the reference impl for the full set).
   Both extensions will run side-by-side during a transition period and the defs must work with both.
   Read-only consumption: do not write/migrate these files.
3. **Orchestrator UX parity for the core loop:**
   - `subagent` tool: spawn named subagent with task, optional agent def, cwd, model, tools,
     systemPrompt, fork/session-mode, interactive flag. Fire-and-forget; completion/failure
     delivered as steer messages that wake the orchestrator.
   - `subagent_resume`, `subagent_interrupt`, `subagents_list` equivalents.
   - Artifact-backed task handoff (task/context files under session artifacts dir) — reuse the
     convention `<sessionDir>/artifacts/<session-id>/...` so debugging habits transfer.
   - `subagent_done` mechanism in the child (the `-e subagent-done.ts` extension + `.exit`
     sidecar handshake) — keep; it is transport-independent and battle-tested.
4. **Truthful lifecycle.** Launch failure (process exits before session starts), crash
   (`pane.exited` with nonzero), completion, and interactive-user-exit must each produce a
   distinct, honest result steer. Never an eternal "stalled" state for a dead child.
5. **Env correctness for direnv/devenv repos.** argv launch skips interactive shell init. The
   `pi` on the dev machine is a wrapper that needs varlock inside
   certain work checkouts — varlock only exists inside the devenv env. Verified fix: launch
   argv as `direnv exec <cwd> pi ...` when the target cwd has an `.envrc` (detect; make behavior
   configurable). Without this, spawns in such checkouts die instantly (verified).
6. **TDD, red/green.** Write failing tests first, then implement. Unit tests (mock the herdr
   CLI/socket boundary) + integration tests against a real herdr named session. Follow the
   node:test style of the reference repo if convenient.
7. **Isolation during development — CRITICAL.** Running pi orchestration agents on this machine
   load the live pi-interactive-subagents checkout via `~/.pi/agent/settings.json` packages. You MUST NOT:
   - modify `~/.pi/agent/settings.json` or anything under `~/.pi/` (except reading agent defs),
   - modify the live pi-interactive-subagents checkout (the live extension source),
   - touch tmux sessions/panes you did not create, or any herdr session you did not create.
   Test recipe (verified): create your own tmux session; run `herdr --session herdr-test` in a
   pane there (client needs a TTY; this starts an isolated server+socket); drive it headless via
   `HERDR_SESSION=herdr-test herdr <cmd>`. Load the extension under test explicitly
   with `pi -e <this-repo>/<entry>.ts` (never via installed packages).
   Note: `~/.local/bin` may not be on tool-shell PATH; use the absolute herdr path.

## DECISIONS DELEGATED TO PLANNER/IMPLEMENTERS

- **What to reproduce vs discard from pi-interactive-subagents.** Study
  its `pi-extension/subagents/` (index.ts ~2100 lines, cmux.ts,
  status.ts, activity.ts, session.ts, subagent-done.ts, plugin/). Candidates to discard: all
  multi-mux surface code (cmux.ts), shell-ready delay, launch verify/retry loop (obsolete under
  argv launch), sentinel screen polling, possibly the Claude Code CLI path (decide; herdr detects
  claude natively so keeping it may be cheap), the local status-widget machinery if herdr's
  sidebar + steer messages suffice (or keep a slim widget — decide with rationale). Candidates to
  keep: agent-def parsing, artifact/task-file handoff, session seeding/fork modes, deny-tools
  env, `.exit` sidecar + subagent-done child extension, steer message formats.
- **Depend on `pi-herdr` (ogulcancelik/pi-extensions/packages/pi-herdr) or standalone.**
  pi-herdr is a *user-facing generic pane tool* (~1000-line single file, reviewed in full); it is
  not a library. Likely answer: standalone with a small internal herdr client module (CLI-exec
  based like pi-herdr, or raw socket ndJSON — evaluate; events.subscribe needs a persistent
  socket connection which the CLI does not provide, so a small socket client may be warranted for
  the event watcher). License is MIT; copying patterns with attribution is fine.
- **Event-driven vs poll-driven completion watcher.** Prefer events.subscribe
  (pane.exited/agent_status_changed) + `.exit` sidecar; a low-frequency poll fallback is
  acceptable for robustness. Must be abortable on /reload (see da8ab6b pattern in reference).
- **Child state self-reporting** (`pane.report_agent` from a pi extension in the child) — nice to
  have, likely a later phase; the shipped `pi.toml` screen detection is thin (literal
  `Working...`) but functional today.
- Naming of tools (`subagent` vs `herdr_*`): keep familiar names BUT both extensions may be
  loaded side-by-side during the transition period — tool name collisions must be handled
  (e.g. registration guard, distinct names, or documented mutual exclusion; decide).

## Reference material (all local)

- pi-interactive-subagents — reference implementation. Branch `fix/launch-verify-retry`
  (v3.7.1 + our race fix, 3 commits). READ-ONLY. Also read its README and tests
  (`test/test.ts`, `test/integration/`).
- herdr source clone. Docs: `docs/next/website/src/content/docs/*.mdx`
  (esp. `socket-api.mdx`, `cli-reference.mdx`, `agents.mdx`, `persistence-remote.mdx`),
  `SKILL.md` (agent-facing usage), `website/agent-detection/pi.toml`.
- ogulcancelik/pi-extensions `packages/pi-herdr/index.ts` — same-author pi extension, good herdr-CLI
  patterns (error envelope parsing, alias bookkeeping, wait loops, renderers).
- internal race-investigation notes — the race
  investigation that motivates this design.
- Pi extension API docs: `@earendil-works/pi-coding-agent/docs/`
  (`extensions.md`, `skills.md`, `packages.md`) and `examples/extensions/`.
- herdr v0.7.1. PR #57: `gh pr view 57 --repo HazAT/pi-interactive-subagents`.

## Ideal State Criteria (ISC)

1. From a pi orchestrator running inside herdr: `subagent` spawn → herdr pane appears running the
   child pi directly (argv), task delivered via artifact file, orchestrator gets a completion
   steer with the child's summary. Works in a devenv checkout cwd with zero
   launch-race mitigation code.
2. A child that crashes at startup (e.g. invalid `--model`) produces a failure steer within
   seconds naming the exit code, pane, and launch script/argv — no zombie.
3. 3 concurrent spawns work without cross-talk.
4. `subagent_resume` and `subagent_interrupt` work; interactive (non-auto-exit) subagents wait
   for the user and still deliver `subagent_done` results.
5. Agent defs in `~/.pi/agent/agents/*.md` drive model/tools/system-prompt identically to
   pi-interactive-subagents (spot-check: worker, planner, reviewer).
6. `npm test` green; integration suite runs against an isolated named herdr session and cleans up
   after itself. Nothing in the developer's global pi config or live sessions is touched.
7. README documents setup (start pi inside herdr), configuration, and differences vs
   pi-interactive-subagents.

## Effort / scope

Weekend-project scale, but done properly (TDD, serial implementer todos). Phase later-phase
items (child self-reporting, Claude CLI path if deferred, notifications polish) as explicit
follow-up todos rather than cramming.
