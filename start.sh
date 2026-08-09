#!/usr/bin/env bash
# Run the school attendance + Telegram bot 24/7 with auto-restart on crash.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${BOT_TOKEN:-}" ]]; then
  echo "[WARN] BOT_TOKEN is not set — Telegram bot will be disabled."
fi

export PORT="${PORT:-8080}"
export PATH="${HOME}/.local/bin:${PATH}"

echo "[START] 24/7 runner — port $PORT (Ctrl+C to stop)"
while true; do
  echo "[START] Launching server at $(date -Iseconds)"
  if python3 -m gunicorn --version >/dev/null 2>&1; then
    python3 -m gunicorn --bind "0.0.0.0:${PORT}" --workers 1 --threads 4 --timeout 120 wsgi:app
  else
    python3 main.py
  fi
  code=$?
  echo "[START] Server exited (code $code) at $(date -Iseconds) — restarting in 5s"
  sleep 5
done
