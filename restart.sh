#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────────────────────
# restart.sh – Redémarrage propre du Vibe Telegram Bot
#
# Usage:  ./restart.sh                (démarrage normal)
#         ./restart.sh --build        (build + restart)
#         ./restart.sh --hard         (kill -9 si stuck)
# ────────────────────────────────────────────────────────────

BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCK_FILE="/tmp/vibe-telegram-bot.pid"
BOT_USER="timo"
SLEEP_AFTER_KILL=25
MAX_WAIT_LOOPS=10

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
err()  { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

# ── Check other bots before touching anything ──
check_bots() {
  local alive=true
  for pid_file in /tmp/opencode-telegram-bot2.pid /tmp/opencode-telegram-bot1.pid; do
    if [ -f "$pid_file" ]; then
      local pid; pid=$(cat "$pid_file" 2>/dev/null || true)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        log "✓ Co-bot $(basename "$pid_file" .pid) PID $pid is alive"
      fi
    fi
  done
}

# ── Find vibe node PID (via lock file or fallback) ──
# Outputs ONLY the PID on stdout (for capture), logs on stderr
find_vibe_pid() {
  if [ -f "$LOCK_FILE" ]; then
    local pid; pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ] && grep -q 'node dist/index.js' "/proc/$pid/cmdline" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    log "Lock file stale (PID $pid not vibe), scanning..." >&2
  fi

  # Fallback: find by cwd + exe
  local pid
  for pid in /proc/[0-9]*; do
    local cwd exe
    cwd=$(readlink "$pid/cwd" 2>/dev/null || true)
    exe=$(readlink "$pid/exe" 2>/dev/null || true)
    if [ "$cwd" = "$BOT_DIR" ] && echo "$exe" | grep -q 'node$'; then
      pid="${pid#/proc/}"
      echo "$pid"
      return 0
    fi
  done
  return 1
}

# ── Build ──
do_build() {
  log "Building..."
  cd "$BOT_DIR"
  if ! npm run build; then
    err "Build failed — aborting restart"
    exit 1
  fi
  log "Build OK"
}

# ── Wait for vibe to come back with a NEW PID ──
wait_for_vibe() {
  local timeout=$1 old_pid=$2
  log "Waiting for vibe to restart (max ${timeout}s)..."
  for i in $(seq 1 "$MAX_WAIT_LOOPS"); do
    sleep "$((timeout / MAX_WAIT_LOOPS))"
    local pid
    if pid=$(find_vibe_pid) && [ "$pid" != "$old_pid" ]; then
      log "✓ Vibe restarted — PID $pid"
      sleep 2
      if [ -f "$LOCK_FILE" ] && [ "$(cat "$LOCK_FILE")" = "$pid" ]; then
        log "✓ Lock file matches"
      fi
      return 0
    fi
  done
  err "Vibe did not restart after ${timeout}s — check systemctl"
  return 1
}

# ── Verify co-bots survived ──
verify_bots() {
  sleep 1
  check_bots
  log "✓ All co-bots still alive"
}

# ── Main restart ──
restart() {
  local old_pid
  if ! old_pid=$(find_vibe_pid); then
    err "No vibe process found — is it running?"
    exit 1
  fi

  log "Found vibe PID $old_pid"
  log "Vibe-acp children: $(pgrep -P "$old_pid" 2>/dev/null | wc -l || echo 0)"

  # Snapshot co-bot state before kill
  check_bots

  # Send SIGTERM — systemd will auto-restart (Restart=always)
  log "Sending SIGTERM to PID $old_pid..."
  /bin/kill "$old_pid"

  log "Waiting ${SLEEP_AFTER_KILL}s for systemd restart..."
  wait_for_vibe "$SLEEP_AFTER_KILL" "$old_pid"

  verify_bots
  log "✅ Restart complete"
}

# ── Hard kill (only if --hard and stuck) ──
hard_kill() {
  local old_pid
  if ! old_pid=$(find_vibe_pid); then
    err "No vibe process found"
    exit 1
  fi
  log "HARD kill PID $old_pid (SIGKILL)..."
  /bin/kill -9 "$old_pid"
  sleep 5
  wait_for_vibe 15 "$old_pid"
  verify_bots
}

# ── Parse args ──
if [ "$0" = "restart.sh" ] || [ "$0" = "./restart.sh" ] || [ "$0" = "$BOT_DIR/restart.sh" ]; then
  case "${1:-}" in
    --build|-b)
      do_build
      restart
      ;;
    --hard)
      hard_kill
      ;;
    --help|-h)
      echo "Usage: $0 [--build|--hard|--help]"
      echo "  --build     Build then restart"
      echo "  --hard      SIGKILL (only if stuck)"
      exit 0
      ;;
    *)
      restart
      ;;
  esac
fi
