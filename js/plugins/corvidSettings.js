// corvidSettings: corvid's own settings overlay. Plain DOM in a closed shadow
// root, styled only through Discord's CSS variables so it follows themes.
// Nothing is built until the first open; at startup this file costs one
// keydown listener and two flux subscriptions.
// Open: Ctrl+Shift+, or the "corvid" entry added to Discord's settings sidebar.
// SPDX-License-Identifier: MIT

const HOST_OPTS = [
    ["blockTelemetry", true, "Block telemetry requests",
        "Drop requests to Discord's analytics, metrics and crash-report endpoints before they leave corvid."],
    ["hideLocalIps", true, "Hide other network interfaces",
        "WebRTC (voice, video, screen share) only uses your default route, so addresses of VPNs, overlays (Yggdrasil, Tailscale) and Docker bridges aren't offered to Discord."],
    ["spellcheck", false, "Spellcheck",
        "Chromium's spellchecker. Its dictionaries are downloaded from Google's servers the first time it's used."],
    ["remoteThemeAssets", true, "Load theme assets from the web",
        "Let corvid fetch fonts and images that themes pull in with @import or url() and inline them. Off: themes can only use what's in their files, and no theme host learns your IP."],
    ["gpu", true, "Hardware acceleration",
        "Render with the GPU. Turn off if you see glitches; uses more CPU."],
    ["transcodeMedia", true, "Play videos and GIFs",
        "corvid's Chromium can't decode H.264/AAC (most Discord videos, all picker GIFs), so ffmpeg converts them to WebM as they load (cached in ~/.cache/corvid/media). Needs ffmpeg. Off: those show only a still image."],
    ["compactHeap", true, "Compact JavaScript memory",
        "Tell V8 to optimize for size: about 115 MB (13%) less memory, about 0.2 s slower startup."],
    ["lowMemory", false, "Low memory mode",
        "Fewer processes and smaller caches. Slightly slower switching between channels and servers."],
    ["proxy", "", "Proxy",
        "Send all of corvid's traffic through a proxy, e.g. socks5://127.0.0.1:9050 for Tor. Empty: connect directly."],
];
const PROXY_RE = /^(?:(?:socks5h?|socks4a?|https?):\/\/(?:[^\s/@]+@)?(?:\[[0-9a-fA-F:.]+\]|[^\s/:@]+)(?::\d{1,5})?\/?)?$/;

const cfg = () => (corvid.settings.host ??= {});
const hostValue = (k, dflt) => cfg()[k] ?? dflt;
// What the host started with; differences mean a relaunch is needed.
const hostAtBoot = Object.fromEntries(HOST_OPTS.map(([k, d]) => [k, hostValue(k, d)]));

let pluginsAtBoot = null;       // name -> enabled, captured once all plugin files ran
const settingAtBoot = new Map(); // "Plugin.key" -> JSON of value before first change
const restartReasons = new Set();

// ------------------------------------------------------------ tiny DOM helper
function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const k in props) {
        const v = props[k];
        if (v == null || (v === false && !(k in el))) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (k in el && typeof v !== "string") el[k] = v;
        else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c);
    return el;
}
const put = (el, ...kids) => { for (const c of kids.flat()) if (c != null && c !== false) el.append(c); };
let uid = 0;
const nextId = p => `cv-${p}-${++uid}`;

// ------------------------------------------------------------ styles
const CSS = String.raw`
:host { all: initial; }
* { box-sizing: border-box; }
.scrim {
    position: fixed; inset: 0; z-index: 2147483000;
    display: flex; align-items: center; justify-content: center;
    background: var(--background-scrim, rgba(0,0,0,.7));
    font-family: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
    font-size: 14px; line-height: 1.4; color: var(--text-default, var(--text-normal, #dbdee1));
}
.dialog {
    display: grid; grid-template-columns: 200px 1fr; grid-template-rows: 1fr auto;
    width: min(920px, calc(100vw - 32px)); height: min(680px, calc(100vh - 32px));
    background: var(--modal-background, var(--background-base-low, var(--background-primary, #313338)));
    border: 1px solid var(--border-subtle, transparent);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-high, 0 8px 16px rgba(0,0,0,.24));
    overflow: hidden;
}
nav {
    grid-row: 1 / 3; display: flex; flex-direction: column; gap: 2px; padding: 16px 8px;
    background: var(--background-base-lower, var(--background-secondary, #2b2d31));
    border-right: 1px solid var(--border-subtle, transparent);
}
nav h1 {
    margin: 0 8px 12px; font-size: 12px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase;
    color: var(--text-muted, #949ba4);
}
nav .spacer { flex: 1; }
.tab {
    all: unset; display: block; padding: 7px 10px; border-radius: var(--radius-sm, 4px); cursor: pointer;
    color: var(--interactive-text-default, var(--interactive-normal, #b5bac1)); font-weight: 500;
}
.tab:hover { background: var(--interactive-background-hover, var(--background-modifier-hover, rgba(255,255,255,.06)));
    color: var(--interactive-text-hover, var(--interactive-hover, #dbdee1)); }
.tab[aria-selected="true"] { background: var(--interactive-background-selected, var(--background-modifier-selected, rgba(255,255,255,.1)));
    color: var(--interactive-text-active, var(--interactive-active, #fff)); }
.panel { overflow-y: auto; padding: 20px 24px 24px; scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thin-thumb, rgba(0,0,0,.4)) transparent; }
.panel:focus { outline: none; }
.head { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 600; color: var(--text-strong, var(--header-primary, #f2f3f5)); }
h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-strong, var(--header-primary, #f2f3f5)); }
p { margin: 0; }
.muted { color: var(--text-muted, #949ba4); font-size: 13px; }
.close {
    all: unset; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; cursor: pointer;
    color: var(--interactive-icon-default, var(--interactive-normal, #b5bac1)); font-size: 20px; line-height: 1;
}
.close:hover { color: var(--interactive-icon-hover, var(--interactive-hover, #fff));
    background: var(--interactive-background-hover, rgba(255,255,255,.06)); }
.card {
    padding: 12px 14px; margin-bottom: 8px; border-radius: var(--radius-sm, 6px);
    background: var(--card-background-default, var(--background-base-lower, var(--background-secondary, #2b2d31)));
    border: 1px solid var(--border-subtle, transparent);
}
.row { display: flex; align-items: center; gap: 12px; }
.row > .grow { flex: 1; min-width: 0; }
.tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 8px; margin-left: 6px; vertical-align: 1px;
    background: var(--background-mod-normal, rgba(255,255,255,.08)); color: var(--text-muted, #949ba4); }
.tag.warn { color: var(--text-feedback-warning, #f0b232); }
.opts { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-subtle, rgba(255,255,255,.06));
    display: grid; gap: 10px; }
.opt { display: grid; gap: 4px; }
.opt.inline { grid-template-columns: 1fr auto; align-items: center; }
label { cursor: pointer; }
button.btn {
    all: unset; cursor: pointer; padding: 6px 14px; border-radius: var(--radius-sm, 4px); font-weight: 500; white-space: nowrap;
    background: var(--control-secondary-background-default, var(--button-secondary-background, #4e5058));
    color: var(--control-secondary-text-default, #fff);
}
button.btn:hover { background: var(--control-secondary-background-hover, var(--button-secondary-background-hover, #6d6f78)); }
button.btn.primary { background: var(--control-primary-background-default, var(--brand-500, #5865f2));
    color: var(--control-brand-foreground-new, var(--control-brand-foreground, #fff)); }
button.btn.primary:hover { background: var(--control-primary-background-hover, var(--brand-560, #4752c4)); }
button.link { all: unset; cursor: pointer; color: var(--text-link, #00a8fc); font-size: 13px; }
button.link:hover { text-decoration: underline; }
input[type=text], input[type=number], input[type=search], select, textarea {
    font: inherit; color: var(--input-text-default, var(--text-default, #dbdee1));
    background: var(--input-background-default, var(--input-background, #1e1f22));
    border: 1px solid var(--input-border-default, transparent); border-radius: var(--radius-sm, 4px);
    padding: 7px 10px; width: 100%;
}
input::placeholder, textarea::placeholder { color: var(--input-placeholder-text-default, var(--text-muted, #87898c)); }
input:hover, select:hover, textarea:hover { border-color: var(--input-border-hover, var(--border-normal, transparent)); }
input[aria-invalid="true"] { border-color: var(--input-border-error-default, var(--status-danger, #f23f43)); }
select { width: auto; min-width: 160px; }
input[type=number] { width: 120px; }
textarea.editor {
    font-family: var(--font-code, "gg mono", monospace); font-size: 13px; line-height: 1.5;
    tab-size: 4; resize: none; white-space: pre; overflow: auto; height: calc(100% - 4px); min-height: 240px;
}
.css-wrap { display: flex; flex-direction: column; height: 100%; }
.css-wrap .editor-box { flex: 1; min-height: 0; margin: 10px 0 6px; }
/* switch */
input.switch {
    appearance: none; margin: 0; flex: none; width: 40px; height: 24px; border-radius: 12px; cursor: pointer; position: relative;
    background: var(--interactive-muted, #80848e); transition: background .15s;
}
input.switch::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; transition: transform .15s;
}
input.switch:checked { background: var(--status-positive, var(--green-360, #23a55a)); }
input.switch:checked::after { transform: translateX(16px); }
input.switch:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--border-focus, var(--text-link, #00a8fc)); outline-offset: 2px; }
.bar {
    grid-column: 2; display: flex; align-items: center; gap: 12px; padding: 10px 24px;
    background: var(--background-base-lowest, var(--background-tertiary, #1e1f22));
    border-top: 1px solid var(--border-subtle, transparent);
}
.bar[hidden] { display: none; }
.bar p { flex: 1; color: var(--text-feedback-warning, #f0b232); font-weight: 500; }
.status { font-size: 12px; color: var(--text-muted, #949ba4); min-height: 1.4em; }
.status.err { color: var(--text-feedback-critical, var(--status-danger, #f23f43)); }
.err { color: var(--text-feedback-critical, var(--status-danger, #f23f43)); }
.search { margin-bottom: 12px; }
.section-gap { height: 12px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--text-muted, #949ba4); }
dd { margin: 0; font-family: var(--font-code, monospace); font-size: 13px; overflow-wrap: anywhere; user-select: text; }
kbd { font-family: var(--font-code, monospace); font-size: 12px; padding: 0 4px; border-radius: 3px;
    background: var(--background-mod-normal, rgba(255,255,255,.08)); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
@media (max-width: 640px) { .dialog { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
    nav { grid-row: auto; flex-direction: row; flex-wrap: wrap; border-right: 0; } nav h1, nav .spacer { display: none; }
    .bar { grid-column: 1; } }
`;

// ------------------------------------------------------------ overlay state
let ui = null;          // built lazily: { host, root, scrim, dialog, tabs, panel, bar, ... }
let isOpen = false;
let current = "plugins";
let returnFocus = null;
let themesCache = null;
let rerenderThemes = null;

const SECTIONS = [
    ["plugins", "Plugins", renderPlugins],
    ["themes", "Themes", renderThemes],
    ["css", "Custom CSS", renderCss],
    ["privacy", "Privacy & performance", renderPrivacy],
    ["about", "About", renderAbout],
];

function snapshotPlugins() {
    pluginsAtBoot ??= Object.fromEntries(Object.values(corvid.plugins).map(p => [p.name, !!p.enabled]));
}

function build() {
    snapshotPlugins();
    const host = h("div", { id: "corvid-settings", "data-no-focus-lock": "true" });
    const root = host.attachShadow({ mode: "closed" });
    try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
    } catch { root.append(h("style", { text: CSS })); }

    const panelId = nextId("panel");
    const tabs = SECTIONS.map(([id, label]) => h("button", {
        class: "tab", role: "tab", id: nextId("tab"), "aria-controls": panelId, "data-section": id,
        tabIndex: -1, text: label, onclick: () => show(id, true),
    }));
    const nav = h("nav", { role: "tablist", "aria-orientation": "vertical", "aria-label": "corvid settings sections" },
        h("h1", { text: "corvid" }), tabs, h("div", { class: "spacer" }));
    nav.addEventListener("keydown", e => {
        const i = tabs.indexOf(root.activeElement);
        if (i === -1) return;
        let j = -1;
        if (e.key === "ArrowDown" || e.key === "ArrowRight") j = (i + 1) % tabs.length;
        else if (e.key === "ArrowUp" || e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") j = 0;
        else if (e.key === "End") j = tabs.length - 1;
        if (j === -1) return;
        e.preventDefault();
        show(tabs[j].dataset.section, false);
        tabs[j].focus();
    });

    const panel = h("section", { class: "panel", role: "tabpanel", id: panelId, tabIndex: -1 });
    const barText = h("p", { text: "Restart corvid to apply your changes." });
    const bar = h("div", { class: "bar", hidden: true, role: "status" }, barText,
        h("button", { class: "btn primary", text: "Relaunch now", onclick: relaunch }));
    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "corvid settings" },
        nav, panel, bar);
    const scrim = h("div", { class: "scrim" }, dialog);
    scrim.addEventListener("mousedown", e => { if (e.target === scrim) close(); });
    root.append(scrim);

    root.addEventListener("keydown", e => {
        if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close(); return; }
        if (e.key === "Tab" && !e.defaultPrevented) trapTab(e);
    });
    // Keep keystrokes and clicks inside the overlay away from Discord's
    // global handlers (type-to-focus-chat, keybinds, popout dismissers).
    for (const t of ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"])
        host.addEventListener(t, e => e.stopPropagation());

    ui = { host, root, scrim, dialog, nav, tabs, panel, bar };
}

function focusables() {
    return [...ui.dialog.querySelectorAll("button, input, select, textarea, [tabindex]")]
        .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest("[hidden]") && el.getClientRects().length);
}
function trapTab(e) {
    const list = focusables();
    // the roving tablist: only the selected tab is a stop
    const tab = ui.tabs.find(t => t.getAttribute("aria-selected") === "true");
    if (tab && !list.includes(tab)) list.unshift(tab);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1], active = ui.root.activeElement;
    if (e.shiftKey && (active === first || !ui.dialog.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !ui.dialog.contains(active))) { e.preventDefault(); first.focus(); }
}

function show(id, focusPanel) {
    current = id;
    rerenderThemes = null;
    for (const t of ui.tabs) {
        const on = t.dataset.section === id;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        if (on) ui.panel.setAttribute("aria-labelledby", t.id);
    }
    ui.panel.replaceChildren();
    ui.panel.scrollTop = 0;
    const [, label, render] = SECTIONS.find(s => s[0] === id);
    try { render(ui.panel, label); }
    catch (e) { corvid.err("settings render", id, e); ui.panel.append(h("p", { class: "err", text: "Failed to render: " + e })); }
    if (focusPanel) ui.panel.focus({ preventScroll: true });
}

function open(section) {
    if (!document.body) return;
    if (!ui) build();
    if (isOpen) { if (section) show(section, true); return; }
    isOpen = true;
    const a = document.activeElement;
    returnFocus = a && a !== document.body ? a : null;
    document.body.append(ui.host);
    updateBar();
    show(section ?? current, false);
    (ui.tabs.find(t => t.dataset.section === current) ?? ui.tabs[0]).focus();
}

function close() {
    if (!isOpen) return;
    isOpen = false;
    rerenderThemes = null;
    flushCss();
    ui.panel.replaceChildren();  // drop section DOM; rebuilt cheaply on open
    ui.host.remove();
    const r = returnFocus;
    returnFocus = null;
    try { if (r?.isConnected) r.focus({ preventScroll: true }); } catch {}
}

// ------------------------------------------------------------ restart tracking
function markRestart(key, needed) {
    needed ? restartReasons.add(key) : restartReasons.delete(key);
    updateBar();
}
function updateBar() {
    if (ui) ui.bar.hidden = restartReasons.size === 0;
}
async function relaunch() {
    try {
        flushCss();
        await corvid.native("settings.save", corvid.settings);  // skip the save debounce
    } catch (e) { corvid.err("save before relaunch", e); }
    corvid.native("app.relaunch").catch(e => corvid.err("relaunch", e));
}

// ------------------------------------------------------------ controls
function switchInput(checked, label, onchange, extra) {
    return h("input", {
        type: "checkbox", class: "switch", role: "switch", checked: !!checked, "aria-label": label,
        onchange: e => onchange(e.target.checked, e.target), ...extra,
    });
}

function settingControl(plugin, key, def) {
    const store = plugin.settings.store;
    const id = nextId("opt");
    const desc = def.description || key;
    const restartTag = def.restartNeeded ? h("span", { class: "tag", text: "restart" }) : null;
    const commit = v => {
        const fullKey = plugin.name + "." + key;
        if (!settingAtBoot.has(fullKey)) settingAtBoot.set(fullKey, JSON.stringify(store[key]));
        store[key] = v;
        if (def.restartNeeded) markRestart("s:" + fullKey, JSON.stringify(v) !== settingAtBoot.get(fullKey));
    };
    const labelEl = h("label", { for: id }, desc, restartTag);

    switch (def.type) {
        case "custom": {
            // The plugin builds the control (buttons, stats); no stored value.
            const node = def.render?.(plugin);
            return node instanceof Node ? node : null;
        }
        case "boolean":
            return h("div", { class: "opt inline" }, labelEl,
                switchInput(store[key], desc, v => commit(v), { id }));
        case "number": {
            const input = h("input", {
                type: "number", id, value: String(store[key] ?? ""),
                min: def.min ?? null, max: def.max ?? null, step: def.step ?? "any",
            });
            input.addEventListener("change", () => {
                const n = input.valueAsNumber;
                const ok = Number.isFinite(n) && (def.min == null || n >= def.min) && (def.max == null || n <= def.max);
                input.setAttribute("aria-invalid", ok ? "false" : "true");
                if (ok) commit(n);
            });
            return h("div", { class: "opt inline" }, labelEl, input);
        }
        case "select": {
            const opts = (def.options ?? []).map(o => (o && typeof o === "object") ? o : { label: String(o), value: o });
            const sel = h("select", { id },
                opts.map((o, i) => h("option", { value: String(i), text: o.label ?? String(o.value) })));
            const cur = opts.findIndex(o => o.value === store[key]);
            sel.selectedIndex = cur === -1 ? Math.max(0, opts.findIndex(o => o.value === def.default)) : cur;
            sel.addEventListener("change", () => commit(opts[sel.selectedIndex]?.value));
            return h("div", { class: "opt inline" }, labelEl, sel);
        }
        case "string":
        default: {
            const multi = !!def.multiline;
            const input = h(multi ? "textarea" : "input", {
                id, type: multi ? null : "text", spellcheck: false, rows: multi ? 4 : null,
                placeholder: def.placeholder ?? null,
            });
            input.value = store[key] == null ? "" : String(store[key]);
            let t = 0;
            const save = () => { clearTimeout(t); if (def.validate && !def.validate(input.value)) return; commit(input.value); };
            input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(save, 400); });
            input.addEventListener("change", save);
            return h("div", { class: "opt" }, labelEl, input);
        }
    }
}

// ------------------------------------------------------------ sections
function sectionHead(title, ...extra) {
    return h("div", { class: "head" }, h("h2", { text: title }), extra,
        h("button", { class: "close", "aria-label": "Close settings", title: "Close (Esc)", text: "×", onclick: close }));
}

function renderPlugins(panel, title) {
    const list = Object.values(corvid.plugins).sort((a, b) => a.name.localeCompare(b.name));
    const search = h("input", { type: "search", class: "search", placeholder: "Search plugins", "aria-label": "Search plugins" });
    const cards = list.map(p => {
        const defs = Object.entries(p.settings?.def ?? {}).filter(([, d]) => d && !d.hidden);
        const nameId = nextId("pn");
        let optsBox = null;
        const toggle = switchInput(p.enabled, "Enable " + p.name, (on, el) => {
            let needs;
            try { needs = corvid.setPluginEnabled(p.name, on); }
            catch (e) { corvid.err("toggle", p.name, e); el.checked = !on; return; }
            const boot = pluginsAtBoot?.[p.name] ?? !on;
            markRestart("p:" + p.name, !!needs && on !== boot);
        }, { disabled: !!p.required, "aria-labelledby": nameId });
        const more = defs.length ? h("button", {
            class: "link", text: "Settings", "aria-expanded": "false",
            onclick: e => {
                const b = e.currentTarget;
                if (!optsBox) {
                    optsBox = h("div", { class: "opts" }, defs.map(([k, d]) => {
                        try { return settingControl(p, k, d); }
                        catch (err) { return h("p", { class: "err", text: `${k}: ${err}` }); }
                    }));
                    card.append(optsBox);
                } else optsBox.hidden = !optsBox.hidden;
                b.setAttribute("aria-expanded", optsBox.hidden ? "false" : "true");
            },
        }) : null;
        const card = h("div", { class: "card", "data-search": (p.name + " " + (p.description ?? "")).toLowerCase() },
            h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("h3", { id: nameId }, p.name,
                        p.required ? h("span", { class: "tag", text: "required" }) : null,
                        p.patches?.length ? h("span", { class: "tag", title: "Changes Discord's code; toggling needs a relaunch", text: "restart" }) : null),
                    p.description ? h("p", { class: "muted", text: p.description }) : null,
                    more),
                toggle));
        return card;
    });
    search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        for (const c of cards) c.hidden = !!q && !c.dataset.search.includes(q);
    });
    put(panel, sectionHead(title), search, cards);
}

function renderThemes(panel, title) {
    const status = h("p", { class: "status", role: "status" });
    const listBox = h("div");
    const draw = themes => {
        listBox.replaceChildren();
        if (!Array.isArray(themes)) return;
        if (!themes.length) {
            listBox.append(h("p", { class: "muted", text: "No themes yet. Drop .css files into the themes folder; they show up here automatically." }));
            return;
        }
        for (const t of [...themes].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
            const nameId = nextId("tn");
            const meta = [t.author && "by " + t.author, t.version && "v" + t.version].filter(Boolean).join(" · ");
            listBox.append(h("div", { class: "card" }, h("div", { class: "row" },
                h("div", { class: "grow" },
                    h("h3", { id: nameId, text: t.name || t.fileName }),
                    meta ? h("p", { class: "muted", text: meta }) : null,
                    t.description ? h("p", { class: "muted", text: t.description }) : null,
                    h("p", { class: "muted", text: t.fileName })),
                switchInput(t.enabled, "Enable " + (t.name || t.fileName), (on, el) => {
                    el.disabled = true;
                    corvid.native("themes.setEnabled", { fileName: t.fileName, enabled: on })
                        .then(() => { t.enabled = on; status.textContent = ""; status.className = "status"; })
                        .catch(e => { el.checked = !on; status.textContent = "Couldn't toggle theme: " + e.message; status.className = "status err"; })
                        .finally(() => { el.disabled = false; });
                }, { "aria-labelledby": nameId }))));
        }
    };
    const refresh = () => {
        status.textContent = themesCache ? "" : "Loading…";
        corvid.native("themes.list").then(list => {
            themesCache = list;
            if (rerenderThemes === draw) { status.textContent = ""; status.className = "status"; draw(list); }
        }).catch(e => { status.textContent = "Couldn't list themes: " + e.message; status.className = "status err"; });
    };
    rerenderThemes = draw;
    put(panel, sectionHead(title,
        h("button", { class: "btn", text: "Open folder", onclick: () => corvid.native("themes.openDir").catch(e => {
            status.textContent = "Couldn't open folder: " + e.message; status.className = "status err";
        }) }),
        h("button", { class: "btn", text: "Reload", onclick: refresh })),
    h("p", { class: "muted", text: "Themes are .css files in corvid's themes folder. Changes to the files apply live." }),
    h("div", { class: "section-gap" }), status, listBox);
    if (themesCache) draw(themesCache);
    refresh();
}

// Custom CSS: live preview through the host, which writes the file and
// pushes the sheet. The textarea keeps its undo stack via insertText.
let cssPending = null;   // text waiting for the debounce
let cssTimer = 0;
let cssStatus = null;
let tabIndents = true;
function pushCss() {
    cssTimer = 0;
    if (cssPending == null) return;
    const css = cssPending;
    cssPending = null;
    corvid.native("quickcss.set", { css }).then(() => {
        if (cssStatus) { cssStatus.textContent = "Applied"; cssStatus.className = "status"; }
    }, e => {
        if (cssStatus) { cssStatus.textContent = "Couldn't save: " + e.message; cssStatus.className = "status err"; }
    });
}
function flushCss() {
    if (!cssTimer) return;
    clearTimeout(cssTimer);
    pushCss();
}
function insertText(ta, text) {
    // execCommand keeps native undo/redo; fall back if it's gone.
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch {}
    if (!ok) {
        ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
}
function editorKey(e) {
    const ta = e.currentTarget;
    if (e.key === "m" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        tabIndents = !tabIndents;
        cssStatus.textContent = tabIndents ? "Tab indents" : "Tab moves focus (Ctrl+M to switch back)";
        cssStatus.className = "status";
        return;
    }
    if (e.key !== "Tab" || !tabIndents || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    const IND = "    ";
    const { selectionStart: s, selectionEnd: en, value: v } = ta;
    if (s === en && !e.shiftKey) { insertText(ta, IND); return; }
    const ls = v.lastIndexOf("\n", s - 1) + 1;
    let le = v.indexOf("\n", en > s && v[en - 1] === "\n" ? en - 1 : en);
    if (le === -1) le = v.length;
    const block = v.slice(ls, le).split("\n")
        .map(l => e.shiftKey ? l.replace(/^(?: {1,4}|\t)/, "") : IND + l).join("\n");
    if (block === v.slice(ls, le)) return;
    ta.setSelectionRange(ls, le);
    insertText(ta, block);
    ta.setSelectionRange(ls, ls + block.length);
}
function renderCss(panel, title) {
    const id = nextId("css");
    cssStatus = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const ta = h("textarea", {
        class: "editor", id, spellcheck: false, autocapitalize: "off", autocomplete: "off",
        placeholder: "/* CSS here applies on top of Discord and your themes, live. */", disabled: true,
        "aria-describedby": id + "-hint",
    });
    ta.setAttribute("autocorrect", "off");
    ta.addEventListener("keydown", editorKey);
    ta.addEventListener("input", () => {
        cssPending = ta.value;
        clearTimeout(cssTimer);
        cssTimer = setTimeout(pushCss, 150);
    });
    put(panel, h("div", { class: "css-wrap" },
        sectionHead(title, h("button", { class: "btn", text: "Open in editor", onclick: () => {
            flushCss();
            corvid.native("quickcss.openEditor").catch(e => { cssStatus.textContent = "Couldn't open editor: " + e.message; cssStatus.className = "status err"; });
        } })),
        h("p", { class: "muted", id: id + "-hint" }, "Applies as you type. ",
            h("kbd", { text: "Tab" }), " indents, ", h("kbd", { text: "Shift+Tab" }), " outdents, ",
            h("kbd", { text: "Ctrl+M" }), " lets Tab move focus instead."),
        h("div", { class: "editor-box" }, h("label", { for: id, hidden: true, text: "Custom CSS" }), ta),
        cssStatus));
    cssStatus.textContent = "Loading…";
    corvid.native("quickcss.get").then(css => {
        if (!ta.isConnected) return;
        ta.value = cssPending ?? (typeof css === "string" ? css : "");
        ta.disabled = false;
        cssStatus.textContent = "";
    }, e => {
        ta.disabled = false;
        cssStatus.textContent = "Couldn't load custom CSS: " + e.message;
        cssStatus.className = "status err";
    });
}

function renderPrivacy(panel, title) {
    const cards = HOST_OPTS.map(([key, dflt, label, help]) => {
        const id = nextId("host");
        const helpId = id + "-help";
        const set = v => {
            cfg()[key] = v;
            corvid.saveSettings();
            markRestart("h:" + key, v !== hostAtBoot[key]);
        };
        let control;
        if (typeof dflt === "boolean") {
            control = switchInput(hostValue(key, dflt), label, v => set(v), { id, "aria-describedby": helpId });
        } else {
            control = h("input", { type: "text", id, spellcheck: false, placeholder: "socks5://127.0.0.1:9050", "aria-describedby": helpId });
            control.value = String(hostValue(key, dflt));
            const check = () => {
                const v = control.value.trim();
                const ok = PROXY_RE.test(v);
                control.setAttribute("aria-invalid", ok ? "false" : "true");
                return ok ? v : null;
            };
            control.addEventListener("input", check);
            control.addEventListener("change", () => { const v = check(); if (v != null) set(v); });
        }
        const isText = typeof dflt !== "boolean";
        return h("div", { class: "card" },
            isText
                ? h("div", { class: "opt" }, h("label", { for: id }, h("h3", { text: label })), h("p", { class: "muted", id: helpId, text: help }), control)
                : h("div", { class: "row" }, h("div", { class: "grow" },
                    h("label", { for: id }, h("h3", { text: label })), h("p", { class: "muted", id: helpId, text: help })), control));
    });
    put(panel, sectionHead(title),
        h("p", { class: "muted", text: "These are read when corvid starts; changes take effect after a relaunch." }),
        h("div", { class: "section-gap" }), cards);
}

function renderAbout(panel, title) {
    const dl = h("dl");
    const add = (k, v) => { if (v != null && v !== "") dl.append(h("dt", { text: k }), h("dd", { text: String(v) })); };
    const ver = corvid.version ?? {};
    const st = corvid._internal?.stats;
    const fill = info => {
        dl.replaceChildren();
        add("corvid", info?.corvid ?? ver.corvid);
        add("CEF", info?.cef ?? ver.cef);
        add("Chromium", info?.chrome ?? ver.chrome);
        add("Data directory", info?.dataDir);
        if (st) add("Webpack modules", `${st.modules} (${st.patched} patched, ${st.patchMs.toFixed(1)} ms)`);
        add("Plugins", Object.values(corvid.plugins).filter(p => p.enabled).length + " enabled of " + Object.keys(corvid.plugins).length);
    };
    fill(null);
    corvid.native("app.info").then(fill, () => {});

    // Patches that found nothing: the first thing to check when a plugin breaks.
    const broken = (corvid._internal?.patches ?? []).filter(p => corvid._internal.ready && (p.hits === 0 || p.failed) && !p.noWarn);
    const patchInfo = broken.length
        ? h("div", { class: "card" }, h("h3", { text: "Patches that didn't apply" }),
            broken.map(p => h("p", { class: "muted", text: `${p.plugin}: ${p.failed ? "broke its module" : "no match"} (${String(p.src).slice(0, 80)})` })))
        : null;
    put(panel, sectionHead(title),
        h("div", { class: "card" }, dl),
        patchInfo,
        h("div", { class: "card" },
            h("p", { class: "muted" }, "corvid is free software under the MIT license. Open these settings anywhere with ",
                h("kbd", { text: "Ctrl+Shift+," }), ".")),
        h("div", { class: "row" }, h("div", { class: "grow" }),
            h("button", { class: "btn", text: "Relaunch corvid", onclick: relaunch })));
}

// ------------------------------------------------------------ hotkey
function onHotkey(e) {
    if (e.code !== "Comma" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.repeat) return;
    e.preventDefault();
    e.stopPropagation();
    isOpen ? close() : open();
}
globalThis.addEventListener?.("keydown", onHotkey, true);

// ------------------------------------------------------------ entry in Discord's settings
// No source patches, no MutationObserver: when Discord's settings open, look
// for its sidebar for a short while (50 ms timer, max ~8 s; rAF stalls while
// the window is hidden) and add one item,
// cloned from a sidebar item so it picks up Discord's (and themes') styling.
let entryHunt = 0;
function findSidebar() {
    // 2026 layout: nav "Settings pages" > ul.sectionList > li[data-settings-sidebar-item]
    const nav = document.querySelector('nav[aria-label="Settings pages"]');
    if (nav) {
        const list = [...nav.querySelectorAll('ul[class*="sectionList"]')].find(ul => ul.querySelector(":scope > li[data-settings-sidebar-item]"));
        if (list) {
            const items = [...list.querySelectorAll(":scope > li[data-settings-sidebar-item]")];
            items.append = true;
            return items;
        }
    }
    let best = null, bestTabs = null;
    for (const tl of document.querySelectorAll('[role="tablist"]')) {
        if (ui?.host.contains(tl)) continue;
        const tabs = tl.querySelectorAll('[role="tab"]');
        if (tabs.length >= 8 && (!bestTabs || tabs.length > bestTabs.length)) { best = tl; bestTabs = tabs; }
    }
    if (best) return [...bestTabs];
    // Older layout: standardSidebarView > side > item
    const side = document.querySelector('[class*="standardSidebarView"] [class*="side_"]');
    return side ? [...side.querySelectorAll(':scope > [class*="item_"]')] : null;
}
function makeEntry(sample) {
    const el = sample.cloneNode(true);
    for (const n of [el, ...el.querySelectorAll("*")]) {
        n.removeAttribute("id");
        n.removeAttribute("aria-controls");
        n.removeAttribute("aria-current");
        n.removeAttribute("href");
        n.removeAttribute("data-settings-sidebar-item");
        n.removeAttribute("data-list-item-id");
    }
    for (const n of el.querySelectorAll("svg, img")) n.remove();
    // Put our label into the last non-empty text node, clear the rest.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.trim()) texts.push(n);
    if (texts.length) { texts.forEach((t, i) => { t.data = i === texts.length - 1 ? "corvid" : ""; }); }
    else el.textContent = "corvid";
    el.setAttribute("aria-selected", "false");
    el.setAttribute("aria-label", "corvid settings");
    el.setAttribute("data-corvid-entry", "");
    el.tabIndex = 0;
    const go = e => {
        e.preventDefault();
        e.stopPropagation();
        // Discord's settings modal traps focus; close it so ours gets it.
        // The 2026 settings layer ignores the flux action; use its Close button.
        const nav = document.querySelector('nav[aria-label="Settings pages"]');
        let layer = nav;
        while (layer && !layer.querySelector?.('[aria-label="Close"]')) layer = layer.parentElement;
        const closeBtn = layer?.querySelector('[aria-label="Close"]');
        if (closeBtn) closeBtn.click();
        else try { corvid.flux?.dispatch({ type: "USER_SETTINGS_MODAL_CLOSE" }); } catch {}
        setTimeout(() => open(), 0);
    };
    el.addEventListener("click", go);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") go(e); });
    return el;
}
function addEntry() {
    clearTimeout(entryHunt);
    let frames = 0;
    const tick = () => {
        entryHunt = 0;
        if (document.querySelector("[data-corvid-entry]")) return;
        const items = findSidebar();
        if (!items?.length) {
            if (++frames < 160) entryHunt = setTimeout(tick, 50); // ~8 s: first open loads a lazy chunk
            return;
        }
        try {
            const sample = items.find(i => i.getAttribute("aria-selected") !== "true" && !/selected/i.test(i.className)) ?? items[0];
            if (items.append) items.at(-1).after(makeEntry(sample));
            else items[0].parentNode.insertBefore(makeEntry(sample), items[0]);
        } catch (e) { corvid.warn("settings entry", e); }
    };
    entryHunt = setTimeout(tick, 0);
}

// ------------------------------------------------------------ plugin
corvid.definePlugin({
    name: "CorvidSettings",
    description: "This settings screen. Ctrl+Shift+, opens it anywhere.",
    required: true,
    settings: {
        sidebarEntry: { type: "boolean", default: true, description: "Add a \"corvid\" item to Discord's settings sidebar." },
    },
    flux: {
        USER_SETTINGS_MODAL_OPEN() { if (this.settings.store.sidebarEntry) addEntry(); },
        USER_SETTINGS_MODAL_SET_SECTION() { if (this.settings.store.sidebarEntry) addEntry(); },
    },
    start() {
        // Every plugin file has run by now; this is the boot state.
        snapshotPlugins();
        this._offThemes = corvid.on("themes.changed", list => {
            if (!Array.isArray(list)) return;
            themesCache = list;
            rerenderThemes?.(list);
        });
    },
    stop() {
        this._offThemes?.();
    },
    open,
    close,
});
