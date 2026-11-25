#!/bin/bash
# Install corvid for the current user:
#   ~/.local/opt/corvid/       binary + CEF runtime (mod layer is built in)
#   ~/.local/bin/corvid        symlink
#   ~/.local/share/applications/corvid.desktop
#
# Env overrides: CEF_PATH (exported CEF dist, default ~/.local/share/cef),
# PREFIX (default ~/.local/opt/corvid).
# Files are only ever copied over; nothing is deleted.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
export CEF_PATH=${CEF_PATH:-$HOME/.local/share/cef}
prefix=${PREFIX:-$HOME/.local/opt/corvid}
bindir=$HOME/.local/bin
appdir=$HOME/.local/share/applications

[[ -f $CEF_PATH/libcef.so ]] || { echo "missing $CEF_PATH/libcef.so" >&2; exit 1; }

echo "== checking plugin patches against Discord's current build"
if ! node "$repo/tests/patch-check.mjs"; then
    echo "!! some patches don't apply to today's Discord build (see above); installing anyway" >&2
fi

echo "== tests + release build"
cargo test -q -p corvid-core --manifest-path "$repo/Cargo.toml"
cargo build --release -p corvid --manifest-path "$repo/Cargo.toml"

echo "== installing to $prefix"
install -d "$prefix/locales"
install -m 755 "$repo/target/release/corvid" "$prefix/corvid"
install -m 644 "$repo/LICENSE" "$prefix/LICENSE"
install -d "$prefix/LICENSES"
install -m 644 "$repo"/LICENSES/* "$prefix/LICENSES/"

# CEF runtime. libcef.so ships with debug info (~1.5 GB); install it stripped.
cef_files=(icudtl.dat resources.pak chrome_100_percent.pak chrome_200_percent.pak
           v8_context_snapshot.bin libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json)
for f in "${cef_files[@]}"; do
    [[ -e $CEF_PATH/$f ]] && install -m 644 "$CEF_PATH/$f" "$prefix/$f"
done
chmod 755 "$prefix"/*.so* 2>/dev/null || true
if [[ ! -f $prefix/libcef.so || $CEF_PATH/libcef.so -nt $prefix/libcef.so ]]; then
    strip --strip-debug -o "$prefix/libcef.so" "$CEF_PATH/libcef.so"
    chmod 755 "$prefix/libcef.so"
fi
# English only: the other locale paks are ~45 MB of disk nobody here reads.
install -m 644 "$CEF_PATH"/locales/en-US.pak "$prefix/locales/"
install -m 644 "$CEF_PATH/CREDITS.html" "$prefix/CEF-CREDITS.html"
# No crash reporter config is ever installed (CEF only reports if one exists).
[[ -e $prefix/crash_reporter.cfg ]] && echo "!! $prefix/crash_reporter.cfg exists; remove it" >&2

echo "== launcher"
install -d "$bindir" "$appdir"
ln -sfn "$prefix/corvid" "$bindir/corvid"
cat >| "$appdir/corvid.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=corvid
GenericName=Discord client
Comment=Lean, private Discord client
Exec=$prefix/corvid
Icon=internet-chat
Terminal=false
Categories=Network;InstantMessaging;Chat;
StartupWMClass=corvid
DESKTOP
command -v desktop-file-validate >/dev/null && desktop-file-validate "$appdir/corvid.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$appdir" || true

# Some launchers (e.g. tux) only read /usr/share/applications. That needs
# root, so print the command instead of running it.
sys_entry=/usr/share/applications/corvid.desktop
if ! cmp -s "$appdir/corvid.desktop" "$sys_entry"; then
    echo "!! launchers that only read /usr/share/applications (tux) need:"
    echo "   doas install -m 644 $appdir/corvid.desktop $sys_entry"
fi
[[ -d $prefix/equicord ]] && echo "note: $prefix/equicord is unused now (old Equicord bundle); safe to delete"
echo "== done: $(du -sh "$prefix" | cut -f1) in $prefix"
