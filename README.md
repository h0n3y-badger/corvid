# corvid

A lean, private Discord client for Linux: Discord's web app in a small Rust
host on CEF (Chromium), with its own built-in mod layer. MIT (see
[License](#license)).

CEF is there for one reason: Discord voice/video requires DAVE end-to-end
encryption, which needs Chromium's WebRTC encoded transforms (WebKitGTK's are
unimplemented). Everything else is kept as small as possible.

## What you get

- **Voice, video, screen share** — Opus, VP8/VP9/AV1, DAVE; screen share via
  xdg-desktop-portal/PipeWire. Mic/camera permission is stored for Discord.
- **Fast** — usable ~1.5–2 s after launch (an Equicord-based build: ~4.2 s).
  The mod layer is ~100 KB of plain JS with no build step and costs nothing
  at startup beyond patching. A second launch just focuses the running window.
- **Light** — ~760 MB PSS for the whole process tree idle (Equicord-based build:
  ~1.1 GB): V8 optimizes for size (`host.compactHeap`, ~115 MB less for
  ~0.2 s slower startup; turn off in settings to trade back), audio service
  in-process, no spare renderer, no Chrome background services.
  `host.lowMemory` trims further. The mod layer remembers which Discord
  modules its patches hit per build, so patching costs ~15 ms after the
  first launch of a new Discord build (~40 ms then).
- **Fake nitro** (FakeNitro plugin, on by default) — emojis from any server
  (static + animated) in any channel, guild stickers in other servers (static,
  GIF; APNG converted to GIF), stream quality unlock, client themes, app icons,
  soundboard; fake links render as real emojis/stickers for you.
- **Themes + custom CSS** — drop BetterDiscord-style `.css` files in
  `~/.config/corvid/themes/`, toggle them in settings; quick CSS in
  `~/.config/corvid/quick.css`. Both hot-reload on save. Remote `@import`s and
  images are fetched once by the host, cached, and inlined, so Discord's CSP
  doesn't block them and the page never talks to theme hosts.
- **Private**
  - NoTrack plugin: Discord analytics, metrics and Sentry are switched off in
    the page; the host also answers telemetry endpoints locally (204) as a
    backstop (`/api/*/science`, `/metrics`, `/rtc/quality-report`, Sentry,
    session-recording and ad-tracking hosts).
  - No crash reporter, no component updater, no Google services, no
    spellcheck dictionary downloads, `Accept-Language: en-US,en`.
  - WebRTC only uses the default route (no VPN/Yggdrasil/Docker addresses).
  - ClearURLs strips tracking parameters from links you send (built-in rules,
    no downloads). Optional: SilentTyping, AnonymiseFileNames.
  - Optional proxy (`host.proxy`, e.g. `socks5://127.0.0.1:9050`), with DNS
    through the proxy.

## Use

- Settings: **Ctrl+Shift+,** anywhere, or the "corvid" item in Discord's
  settings sidebar. Plugins, themes, custom CSS editor (live preview),
  privacy/performance options, relaunch.
- `corvid --help` for flags. `--remote-debugging-port=N` for DevTools.
- Data: `~/.config/corvid` (`settings.json`, `themes/`, `quick.css`,
  `profile/` = your login). Theme asset cache: `~/.cache/corvid`.

## Build / install

Needs Rust (2024 edition), node (for the patch check) and a CEF 156.0.26
linux64 distribution at `CEF_PATH` (cef-rs's `export-cef-dir` tool makes
one).

```sh
CEF_PATH=~/.local/share/cef scripts/install.sh   # tests, release build, install to ~/.local/opt/corvid
```

## Develop

- `js/core.js` — webpack hook, Vencord-syntax patcher (`\i`, `$self`,
  `#{intl::KEY}`), finders, plugin API. `js/plugins/*.js` — one plugin per file.
- `CORVID_JS_DIR=$PWD/js target/debug/corvid` loads JS from disk (no rebuild).
- `node tests/patch-check.mjs` — downloads Discord's current web build
  (cached in `target/discord-assets/`) and checks every plugin patch applies.
- `cargo test -p corvid-core` — host unit tests.
- Live, read-only checks in the real client (send nothing):
  `corvid --smoke-js=tests/live-plugins.js`, `tests/live-fakenitro.js`,
  `tests/live-settings-entry.js`; `tests/themes.sh`; `tests/bench.sh`.
- WebRTC probes on a Discord origin:
  `corvid --url=https://discord.com/robots.txt --smoke-js=tests/webrtc-loopback.js`.

## License

MIT ([LICENSE](LICENSE)), except `crates/corvid-core/src/themes.rs`, which
ports BetterDiscord's theme meta parser and stays Apache-2.0
([LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)).

The FakeNitro plugin is a clean-room implementation: written from a
behavioural spec by someone who hadn't seen any other client mod's FakeNitro
code, with every patch derived from Discord's own web build.

corvid is not affiliated with Discord. Client mods break Discord's Terms of
Service; use at your own risk.
