#!/bin/sh
# Start over, to test setup like someone who just got the board (docs/setup.md, "Testing setup again").
#
#   sh tools/fresh.sh all [dev|prod]   factory-reset the board, then open that server's /setup: the first-time experience
#   sh tools/fresh.sh board            factory-reset the board (backup first): Waveshare's demo, like out of the box
#   sh tools/fresh.sh backup [FILE]    the whole board (16 MB flash: firmware, settings, Wi-Fi) to a file
#   sh tools/fresh.sh restore FILE     write a backup back (e.g. your daily board after testing)
#   sh tools/fresh.sh status           what's on USB
#
# Options: --yes (no questions), --no-backup (board: skip the backup). Backups go to $PAPERBOT_BACKUPS
# (default ~/src/projects/paperbot-hw-backup). dev = https://dev.paperbot.ca, prod = https://app.paperbot.ca.
# A factory reset erases only the board's flash; the SD card (recordings) is untouched.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BACKUPS=${PAPERBOT_BACKUPS:-$HOME/src/projects/paperbot-hw-backup}
FACTORY=$ROOT/vendor/waveshare/03_Firmware/01_fac_v1.0.bin
YES=0 BACKUP=1
ARGS=""
for a in "$@"; do case "$a" in --yes|-y) YES=1;; --no-backup) BACKUP=0;; *) ARGS="$ARGS $a";; esac; done
set -- $ARGS
CMD=${1:-help}

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r r </dev/tty; case "$r" in y|Y|yes) return 0;; *) return 1;; esac; }
esptool() { uvx -q --from esptool esptool --chip esp32c6 -p "$PORT" -b 921600 "$@"; }
server_url() {
  case "${1:-dev}" in
    dev) echo https://dev.paperbot.ca;; prod|production) echo https://app.paperbot.ca;;
    http*) echo "$1";; *) die "server: dev, prod or a URL (not '$1')";;
  esac
}
find_port() {
  PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -n1 || true)
  [ -n "$PORT" ] || die "No board on USB. Plug it in with a data cable; if it's plugged in: press ⏻ (it may be asleep), or unplug it and flip the USB-C plug."
}

backup() {
  find_port
  mkdir -p "$BACKUPS"
  f=${1:-$BACKUPS/board-$(date +%Y%m%d-%H%M%S).bin}
  say "Backing up the board's flash (16 MB, about a minute) to $f"
  ( umask 077; esptool --after hard-reset read-flash 0 0x1000000 "$f" >/dev/null )
  say "✓ backup: $f (it holds the board's token and Wi-Fi passwords; keep it private)"
}

board() {
  find_port
  [ -r "$FACTORY" ] || die "Missing $FACTORY (git submodule update --init vendor/waveshare)"
  ask "Factory-reset the board on $PORT? Its paperbot firmware, settings and Wi-Fi are erased." || die "Stopped."
  [ "$BACKUP" = 1 ] && backup
  say "Erasing and writing Waveshare's factory firmware…"
  esptool erase-flash >/dev/null
  esptool write-flash 0x0 "$FACTORY" >/dev/null
  say "✓ The board is like new (Waveshare's demo). Next: open https://dev.paperbot.ca/setup in Chrome"
}

restore() {
  [ -n "${1:-}" ] && [ -r "$1" ] || die "restore FILE (a backup from: sh tools/fresh.sh backup)"
  find_port
  ask "Write $1 to the board on $PORT? Everything on the board is replaced." || die "Stopped."
  esptool write-flash 0x0 "$1" >/dev/null
  say "✓ Restored. The board restarts with what it had when the backup was made."
}

status() {
  p=$(ls /dev/cu.usbmodem* 2>/dev/null | tr '\n' ' ')
  say "USB:     ${p:-no board (asleep? press ⏻, or flip the USB-C plug)}"
  say "Backups: $(ls "$BACKUPS"/*.bin 2>/dev/null | wc -l | tr -d ' ') in $BACKUPS"
}

case "$CMD" in
  all)
    url=$(server_url "${2:-dev}")
    say "Fresh start against $url: factory-reset the board, then open $url/setup."
    ask "Go ahead?" || die "Stopped."
    YES=1
    board
    open "$url/setup" ;;
  board) board ;;
  backup) backup "${2:-}" ;;
  restore) restore "${2:-}" ;;
  status) status ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
