#!/bin/bash
# Double-click on macOS: copies images, ssl-vmix.xlsx and ssl-vmix.json from the online dashboard to a local folder (for testing the sync on a Mac).
cd "$(dirname "$0")" || exit 1
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null 2>&1
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
git pull --ff-only >/dev/null 2>&1
echo "== vMix sync (close this window to stop)"
node vmix-sync/vmix-sync.mjs
