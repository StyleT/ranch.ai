#!/bin/bash
# LaunchDaemon wrapper for com.ranch.wyze-bridge. Runs as user ranch. Loads the Wyze credentials from
# ~/.config/ranch/wyze.env (mode 600, never in the repo) and execs the bridge; everything else comes
# from the plist's EnvironmentVariables. go2rtc and ffmpeg are found on PATH (/usr/local/ranch/bin,
# /opt/homebrew/bin).
set -euo pipefail
ENV_FILE="${WYZE_ENV_FILE:-$HOME/.config/ranch/wyze.env}"
if [ ! -r "$ENV_FILE" ]; then
  echo "$(date '+%F %T') wyze-bridge: $ENV_FILE missing or unreadable; sleeping" >&2
  sleep 300
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec /usr/local/ranch/bin/wyze-bridge
