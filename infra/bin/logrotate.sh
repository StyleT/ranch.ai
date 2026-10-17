#!/bin/bash
# Rotates /var/log/ranch-*.log (com.ranch.logrotate, hourly, as root). launchd opens StandardOutPath for the
# daemons with O_APPEND, so copy-then-truncate keeps every writer on the live file without a restart or a
# reopen signal (newsyslog's rename would leave them writing into the rotated file). A file is rotated when it
# exceeds MAX_MB, or once a day after DAILY_HOUR local time. Keeps KEEP gzipped generations.
set -euo pipefail
MAX_MB="${MAX_MB:-20}"; KEEP="${KEEP:-7}"; DAILY_HOUR="${DAILY_HOUR:-3}"
STAMP=/usr/local/ranch/var/logrotate.daily
today=$(date +%F); hour=$(date +%-H)
daily=0
if [ "$hour" -ge "$DAILY_HOUR" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$today" ]; then daily=1; fi
rotate() {
  local f=$1
  for ((i=KEEP-1; i>=1; i--)); do [ -f "$f.$i.gz" ] && mv -f "$f.$i.gz" "$f.$((i+1)).gz"; done
  [ -f "$f.$KEEP.gz" ] && rm -f "$f.$KEEP.gz"
  cp -p "$f" "$f.1" && : > "$f" && gzip -f "$f.1"
  echo "$(date '+%F %T') rotated $f ($2)"
}
for f in /var/log/ranch-*.log; do
  [ -f "$f" ] || continue
  size_mb=$(( $(stat -f %z "$f") / 1048576 ))
  if [ "$size_mb" -ge "$MAX_MB" ]; then rotate "$f" "size ${size_mb} MB"
  elif [ "$daily" = 1 ] && [ "$(stat -f %z "$f")" -gt 0 ]; then rotate "$f" "daily"
  fi
done
[ "$daily" = 1 ] && echo "$today" > "$STAMP"
exit 0
