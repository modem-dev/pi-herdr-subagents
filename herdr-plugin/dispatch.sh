#!/usr/bin/env bash
set -u

if [[ -z "${PI_SUBAGENT_LAUNCH_SCRIPT:-}" ]]; then
  echo "pi-herdr-subagents dispatcher: PI_SUBAGENT_LAUNCH_SCRIPT is unset" >&2
  exit 64
fi

if [[ ! -r "$PI_SUBAGENT_LAUNCH_SCRIPT" ]]; then
  echo "pi-herdr-subagents dispatcher: launch script is not readable: $PI_SUBAGENT_LAUNCH_SCRIPT" >&2
  exit 66
fi

exec bash "$PI_SUBAGENT_LAUNCH_SCRIPT"
