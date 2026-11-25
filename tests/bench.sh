#!/bin/bash
# Launch-to-usable time and memory of a corvid binary (GUI goes to workspace 4).
#   tests/bench.sh [binary] [runs] [extra args...]
# ready = wall ms from exec until Discord's server list exists (the binary's
# --smoke-js result line); PSS = all of the binary's processes, 20 s after
# launch while idle on the Friends page (whole process tree).
set -u
bin=$(readlink -f "${1:-target/release/corvid}")
runs=${2:-3}
here=$(cd "$(dirname "$0")" && pwd)
# Children re-exec as /proc/self/exe (network service etc.): walk the process
# tree from the browser process rather than matching the binary path.
tree() { echo "$1"; for c in $(pgrep -P "$1"); do tree "$c"; done; }
pss() {
    local total=0 p v
    for p in "$@"; do
        v=$(awk '/^Pss:/ {print $2}' /proc/$p/smaps_rollup 2>/dev/null)
        total=$((total + ${v:-0}))
    done
    echo $((total / 1024))
}
to_ws4() { ( sleep 0.3; for i in $(seq 60); do hyprctl dispatch 'hl.dsp.window.move({ workspace = "4", follow = false, window = "class:corvid" })' >/dev/null 2>&1; sleep 0.1; done ) & }
for r in $(seq "$runs"); do
    to_ws4
    start=$EPOCHREALTIME
    while IFS= read -r line; do
        [[ $line == SMOKE* ]] && echo "run $r: ready $(( (${EPOCHREALTIME/./} - ${start/./}) / 1000 )) ms"
    done < <(timeout 90 "$bin" --smoke-js="$here/bench-ready.js" "${@:3}" 2>&1)
    wait; sleep 2
done
to_ws4
to_ws4
"$bin" --new-instance --smoke-js="$here/bench-idle.js" "${@:3}" >/dev/null 2>&1 &
main=$!
sleep 20
procs=$(tree "$main")
echo "memory: PSS $(pss $procs) MB in $(wc -w <<<"$procs") processes"
kill "$main" 2>/dev/null; wait
