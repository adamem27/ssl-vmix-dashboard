#!/bin/bash
# Double-click on macOS (or run ./start.command): fetches the latest version, builds it and starts the dashboard.
cd "$(dirname "$0")" || exit 1

# Use nvm's Node when present, so an older system Node is not picked up.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use >/dev/null 2>&1
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"

node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)||(a>20&&a<22)?0:1)' || {
  echo "Node $(node -v) is too old. Install Node 22.12 or newer (e.g. 'nvm install 22')."; read -r -p "Press Enter to close."; exit 1; }

echo "== Checking for updates"
before=$(git rev-parse HEAD)
git checkout -- package-lock.json 2>/dev/null
if git pull --ff-only; then
  after=$(git rev-parse HEAD)
else
  echo "Could not update (no internet or local changes). Starting the current version."
  after=$before
fi

if [ "$before" != "$after" ] || [ ! -d node_modules ] || [ ! -f server/dist/index.js ] || [ ! -d web/dist ]; then
  echo "== Installing and building"
  npm install --no-audit --no-fund && npm run build || { read -r -p "Build failed. Press Enter to close."; exit 1; }
else
  echo "== Already up to date"
fi

# Stop a dashboard left running from an earlier start, so the new version can take the port.
old=$(lsof -ti tcp:4310 2>/dev/null)
[ -n "$old" ] && { echo "== Stopping the previous dashboard"; kill $old; sleep 1; }

echo "== Starting on http://localhost:4310 (close this window to stop)"
(sleep 3; open "http://localhost:4310" 2>/dev/null || xdg-open "http://localhost:4310" 2>/dev/null) &
npm start
