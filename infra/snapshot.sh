#!/bin/bash
# Dump the mini's live configuration into infra/snapshots/<date>/ for drift review.
# Usage: infra/snapshot.sh [host]   (default ranch@ranch-ai.local)
set -euo pipefail
HOST="${1:-ranch@ranch-ai.local}"
DIR="$(cd "$(dirname "$0")" && pwd)/snapshots/$(date +%Y-%m-%d)"
mkdir -p "$DIR"
r(){ ssh -o BatchMode=yes "$HOST" "$1" > "$DIR/$2" 2>&1 || true; }
r 'sw_vers; echo; sysctl -n machdep.cpu.brand_string hw.memsize' system.txt
r 'scutil --get ComputerName; scutil --get HostName; scutil --get LocalHostName; sudo -n systemsetup -gettimezone' names.txt
r 'pmset -g' pmset.txt
r 'sudo -n systemsetup -getremotelogin; sudo -n launchctl print system/com.apple.screensharing >/dev/null 2>&1 && echo "Screen Sharing: On" || echo "Screen Sharing: Off"' sharing.txt
r 'mdutil -s /; defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup 2>&1' indexing_backup.txt
r 'defaults read /Library/Preferences/com.apple.SoftwareUpdate; defaults read /Library/Preferences/com.apple.commerce 2>&1; defaults read com.apple.assistant.support 2>&1' defaults.txt
r 'launchctl print-disabled gui/$(id -u)' disabled_agents.txt
r 'ls -la /Library/LaunchDaemons /etc/ssh/sshd_config.d /etc/sudoers.d; echo; cat /etc/ssh/sshd_config.d/*; echo; sudo -n cat /etc/sudoers.d/*' daemons_access.txt
r '/opt/homebrew/bin/brew bundle dump --file=- 2>/dev/null; echo; /opt/homebrew/bin/fnm ls 2>/dev/null' packages.txt
r 'sudo -n /opt/homebrew/bin/tailscale status 2>&1 | head -5' tailscale.txt
r 'uptime; echo; memory_pressure | tail -2; echo; vm_stat | head -8; echo; sysctl vm.swapusage; echo; top -l 1 -o cpu -n 15 -stats pid,command,cpu,mem | tail -16' baseline.txt
echo "Snapshot written to $DIR"
PREV=$(ls -d "$(dirname "$DIR")"/*/ 2>/dev/null | grep -v "$DIR" | sort | tail -1 || true)
if [ -n "$PREV" ]; then echo "Diff vs $(basename "$PREV"):"; diff -r "$PREV" "$DIR" || true; fi
