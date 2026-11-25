#!/bin/bash
# Theme pipeline test: local theme + remote @import + live file edit.
#   tests/themes.sh [binary]   (GUI on workspace 4; scratch data dir)
set -eu
bin=$(readlink -f "${1:-target/debug/corvid}")
here=$(cd "$(dirname "$0")" && pwd)
data=$(mktemp -d)
cache=$(mktemp -d)
mkdir -p "$data/themes"
cat > "$data/themes/test.theme.css" <<'CSS'
/**
 * @name Test Theme
 * @author corvid tests
 */
@import url("https://catppuccin.github.io/discord/dist/catppuccin-mocha.theme.css");
body { --corvid-theme-test: 1px; }
CSS
( sleep 0.3; for i in $(seq 50); do hyprctl dispatch 'hl.dsp.window.move({ workspace = "4", follow = false, window = "class:corvid" })' >/dev/null 2>&1; sleep 0.1; done ) &
( sleep 6; sed -i 's/--corvid-theme-test: 1px/--corvid-theme-test: 2px/' "$data/themes/test.theme.css" ) &
CORVID_DATA_DIR=$data XDG_CACHE_HOME=$cache timeout 60 "$bin" --url="file://$here/blank.html" --smoke-js="$here/smoke-themes.js" 2>&1 | grep -o 'SMOKE.*'
wait
echo "cached assets: $(ls "$cache/corvid/theme-assets" 2>/dev/null | wc -l)"
