#!/bin/bash
# Tier-2 latency and memory on the mini (plan A3 / C2): serve one candidate with mlx-vlm, run an escalation set through
# it with evals/vlm/run.py, sample memory pressure and swap while it runs, stop the server. Foreground, bash 3.2.
#   vlm-bench.sh <hf model id> <escalations.jsonl> [prompt version]
set -euo pipefail
MODEL="$1"; ESC="$2"; PROMPT="${3:-v1}"
APP=/usr/local/ranch/app/evals/vlm
UV=/opt/homebrew/bin/uv
cd "$APP"
"$UV" run python -m mlx_vlm.server --model "$MODEL" --port 8080 >/tmp/vlm-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 120); do
  curl -s -m 2 http://127.0.0.1:8080/v1/models >/dev/null 2>&1 && break
  sleep 2
done
echo "{\"server_ready_s\": $((i * 2)), \"memory_pressure_before\": \"$(memory_pressure | grep -i 'percentage' | tr -d '\n')\", \"swap_before\": \"$(sysctl -n vm.swapusage)\"}"
# The server's resident set, sampled once a second over every mlx_vlm.server process (the uv wrapper and the python
# child), summed; the peak is the number the memory bar is read against.
RSS_LOG=/tmp/vlm-rss.log; : > "$RSS_LOG"
( while kill -0 $SERVER 2>/dev/null; do
    ps -o rss= -p "$(pgrep -f mlx_vlm.server | tr '\n' ',' | sed 's/,$//')" 2>/dev/null | awk '{s+=$1} END {print int(s/1024)}' >> "$RSS_LOG"
    sleep 1
  done ) &
SAMPLER=$!
"$UV" run python run.py --model "$MODEL" --escalations "$ESC" --prompt "$PROMPT"
kill $SAMPLER 2>/dev/null || true
echo "{\"memory_pressure_after\": \"$(memory_pressure | grep -i 'percentage' | tr -d '\n')\", \"swap_after\": \"$(sysctl -n vm.swapusage)\", \"server_rss_mb_peak\": $(sort -n "$RSS_LOG" | tail -1 | grep . || echo null), \"server_rss_mb_samples\": $(wc -l < "$RSS_LOG" | tr -d ' ')}"
