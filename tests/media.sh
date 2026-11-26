#!/bin/bash
# Media transcoding test: H.264/AAC samples served locally, played in a test
# page (see tests/media-live.js). Needs ffmpeg and node.
#   tests/media.sh [binary]   (GUI on workspace 4; scratch data + cache dirs)
set -eu
bin=$(readlink -f "${1:-target/debug/corvid}")
here=$(cd "$(dirname "$0")" && pwd)
data=$(mktemp -d)
cache=$(mktemp -d)
media=$(mktemp -d)
# Only the two samples are removed (by exact path); the small scratch dirs stay.
trap 'kill $(jobs -p) 2>/dev/null; rm -f -- "$media/short.mp4" "$media/long.mp4"' EXIT

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
ff -f lavfi -i testsrc2=s=640x360:d=3:r=30 -f lavfi -i sine=d=3 -c:v libx264 -preset veryfast -c:a aac -movflags +faststart "$media/short.mp4"
# long enough that the transcode outlasts the 1.5 s wait and gets streamed
ff -f lavfi -i testsrc2=s=1920x1080:d=90:r=30 -f lavfi -i sine=d=90 -c:v libx264 -preset veryfast -b:v 6M -c:a aac -movflags +faststart "$media/long.mp4"

# Tiny static file server (ffmpeg reads faststart MP4 front to back).
node -e '
const http = require("http"), fs = require("fs"), path = require("path");
const dir = process.argv[1];
http.createServer((q, s) => {
  const f = path.join(dir, path.basename(decodeURIComponent(q.url.split("?")[0])));
  fs.stat(f, (e, st) => {
    if (e) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": st.size });
    fs.createReadStream(f).pipe(s);
  });
}).listen(18733, "127.0.0.1");
' "$media" &

( sleep 0.3; for i in $(seq 50); do hyprctl dispatch 'hl.dsp.window.move({ workspace = "4", follow = false, window = "class:corvid" })' >/dev/null 2>&1; sleep 0.1; done ) &
CORVID_MEDIA_TEST_ORIGIN=http://127.0.0.1:18733/ CORVID_DATA_DIR=$data XDG_CACHE_HOME=$cache \
    timeout 90 "$bin" --url="file://$here/blank.html" --smoke-js="$here/media-live.js" 2>&1 | grep -E -o 'SMOKE.*|transcod.*'
echo "cached: $(ls "$cache/corvid/media" 2>/dev/null | tr '\n' ' ')"
