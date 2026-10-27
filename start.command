#!/bin/bash
# Pulse Lab OR — launcher for macOS. Double-click in Finder, or run: bash start.command
cd "$(dirname "$0")" || exit 1
PORT=8766
echo ""
echo "  Pulse Lab OR — case rehearsal simulator"
echo "  ---------------------------------------"
if command -v python3 >/dev/null 2>&1; then
  echo "  Serving at http://localhost:$PORT  (press Ctrl+C to stop)"
  ( sleep 1 && open "http://localhost:$PORT" ) &
  python3 -m http.server "$PORT" --bind 127.0.0.1
else
  open "index.html"
fi
