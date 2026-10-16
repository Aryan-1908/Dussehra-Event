#!/usr/bin/env bash
# Starts the Ravan Dahan server and a public Cloudflare quick tunnel.
# Usage: ./start.sh        (Ctrl+C stops both)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
mkdir -p bin data

if [ ! -x .venv/bin/python ]; then
  echo "Setting up Python environment..."
  python3 -m venv .venv
  .venv/bin/pip install -q aiohttp==3.9.5
fi
if [ ! -x bin/cloudflared ]; then
  echo "Downloading cloudflared..."
  curl -fsSL -o bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x bin/cloudflared
fi

SERVER=""; TUNNEL=""
trap 'kill ${SERVER:-} ${TUNNEL:-} 2>/dev/null || true' EXIT INT TERM

PORT="$PORT" .venv/bin/python server.py > data/server.log 2>&1 &
SERVER=$!
sleep 1
bin/cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > data/tunnel.log 2>&1 &
TUNNEL=$!

URL=""
for _ in $(seq 1 40); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/tunnel.log | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then echo "Tunnel did not start. See data/tunnel.log"; exit 1; fi

KEY=$(cat data/host_key)
echo
echo "  Players link (share in the meeting chat):  $URL"
echo "  Host link (keep private, open on the screen you share):  $URL/?host=$KEY"
echo
echo "  Keep this window open during the event. Ctrl+C stops it."
wait
