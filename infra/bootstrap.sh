#!/bin/bash
# One-time bootstrap for a freshly erased Mac mini. Run from the laptop:
#   ssh ranch@ranch-ai.local 'bash -s' < infra/bootstrap.sh
# Installs Xcode Command Line Tools (gives a real python3 + git) and Homebrew.
# Everything after this is Ansible (infra/ansible). Idempotent.
set -euo pipefail

log(){ printf '\n==> %s\n' "$*"; }

if xcode-select -p >/dev/null 2>&1; then
  log "Command Line Tools already installed at $(xcode-select -p)"
else
  log "Installing Command Line Tools (non-interactive)"
  FLAG=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
  touch "$FLAG"
  # Label looks like "Command Line Tools for Xcode 27.0-27.0" on macOS 27 (older: "...Xcode-15.3")
  LABEL=$(softwareupdate -l 2>&1 | sed -n 's/^\* Label: \(Command Line Tools for Xcode.*\)$/\1/p' | sort -V | tail -1 || true)
  if [ -z "$LABEL" ]; then echo "No CLT label found in softwareupdate -l"; rm -f "$FLAG"; exit 1; fi
  log "softwareupdate -i \"$LABEL\""
  softwareupdate -i "$LABEL" --verbose
  rm -f "$FLAG"
  xcode-select -p
fi

if [ -x /opt/homebrew/bin/brew ]; then
  log "Homebrew already installed"
else
  log "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if ! grep -q 'brew shellenv' ~/.zprofile 2>/dev/null; then
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
fi

log "Bootstrap complete"
/usr/bin/python3 --version
/opt/homebrew/bin/brew --version | head -1
