#!/bin/bash
# Interleaved memory A/B of Chromium/V8 flag sets on one binary.
#   tests/bench-mem.sh rounds 'label|flags' 'label|flags' ...
# Each round runs every variant once (A B C A B C ...): idle PSS (whole
# process tree, total and largest child) 20 s after launch. GUI goes to ws 4.
set -u
here=$(cd "$(dirname "$0")" && pwd)
bin=$(readlink -f "${BIN:-$HOME/.local/opt/corvid/corvid}")
rounds=$1; shift
to_ws4() { ( sleep 0.3; for i in $(seq 60); do hyprctl dispatch 'hl.dsp.window.move({ workspace = "4", follow = false, window = "class:corvid" })' >/dev/null 2>&1; sleep 0.1; done ) & }
pss() { awk '/^Pss:/{print int($2/1024)}' /proc/$1/smaps_rollup 2>/dev/null || echo 0; }
# Children re-exec as /proc/self/exe (network/utility services), so walk the
# tree from the browser process instead of matching the binary path.
tree() { echo "$1"; for c in $(pgrep -P "$1"); do tree "$c"; done; }
for r in $(seq "$rounds"); do
    for v in "$@"; do
        label=${v%%|*}; read -ra flags <<<"${v#*|}"
        to_ws4
        "$bin" --new-instance --smoke-js="$here/bench-idle.js" "${flags[@]}" >/dev/null 2>&1 &
        main=$!
        sleep 22
        total=0; big=0; n=0
        for p in $(tree "$main"); do
            m=$(pss "$p"); total=$((total + m)); n=$((n + 1))
            ((p != main && m > big)) && big=$m
        done
        echo "round $r  $label  PSS $total MB  largest-child $big MB  procs $n"
        kill "$main" 2>/dev/null; wait "$main" 2>/dev/null; sleep 3
    done
done
