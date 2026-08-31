#!/usr/bin/env bash
set -u

launch_script="${PI_HERDR_LAUNCH_SCRIPT:-${PI_SUBAGENT_LAUNCH_SCRIPT:-}}"

if [[ -z "$launch_script" ]]; then
  echo "pi-herdr-subagents dispatcher: PI_HERDR_LAUNCH_SCRIPT is unset or empty; legacy fallback PI_SUBAGENT_LAUNCH_SCRIPT is also unset or empty" >&2
  exit 64
fi

if [[ ! -r "$launch_script" ]]; then
  echo "pi-herdr-subagents dispatcher: launch script is not readable (PI_HERDR_LAUNCH_SCRIPT or legacy fallback PI_SUBAGENT_LAUNCH_SCRIPT): $launch_script" >&2
  exit 66
fi

exec bash "$launch_script"
