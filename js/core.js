// corvid mod core. Injected by the host into Discord's main frame at
// document start, before any page script, followed by every js/plugins/*.js.
// No build step: plain modern JS, runs in Chromium (and node for tests).
// SPDX-License-Identifier: MIT
//
// The host prepends:   const CORVID_CFG = {...};
//   CORVID_CFG.settings   settings.json contents
//   CORVID_CFG.css        [[id, cssText], ...] to apply right away
//   CORVID_CFG.token      name of the global the host calls back into
//   CORVID_CFG.version    corvid/CEF versions
// and passes the native post function as globalThis.__corvidNative (removed
// here before any page script can grab it).
//
// Patch syntax is compatible with Vencord/Equicord plugin patches:
//   \i in a regex = an identifier, $self in a replacement = this plugin,
//   #{intl::KEY} = Discord's hashed intl key.
(() => {
    "use strict";
    const G = globalThis;
    const cfg = typeof CORVID_CFG === "object" ? CORVID_CFG : (G.CORVID_CFG ?? {});
    const settings = cfg.settings ?? {};
    settings.plugins ??= {};

    // ------------------------------------------------------------ native bridge
    const nativePost = G.__corvidNative;
    try { delete G.__corvidNative; } catch { G.__corvidNative = undefined; }
    const stringify = JSON.stringify;
    const pending = new Map();
    let seq = 0;

    /** Call the host. Resolves with its JSON reply. */
    function native(cmd, args = null) {
        if (typeof nativePost !== "function") return Promise.reject(new Error("corvid: no host"));
        const id = ++seq;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            nativePost(stringify({ id, cmd, args }));
        });
    }

    const log = (...a) => console.log("%c[corvid]", "color:#9b84ee", ...a);
    const warn = (...a) => console.warn("%c[corvid]", "color:#9b84ee", ...a);
    const err = (...a) => console.error("%c[corvid]", "color:#9b84ee", ...a);

    // ------------------------------------------------------------ CSS
    // Constructable stylesheets: no DOM nodes, so they work before <head>
    // exists, survive Discord's DOM churn and replace in one cheap call.
    const sheets = new Map();
    const pendingSheets = [];
    function adopt(sheet) {
        if (!G.document) return;
        G.document.adoptedStyleSheets = [...G.document.adoptedStyleSheets, sheet];
    }
    function setCss(id, text) {
        let s = sheets.get(id);
        if (text == null || text === "") {
            if (s && G.document) {
                G.document.adoptedStyleSheets = G.document.adoptedStyleSheets.filter(x => x !== s);
                sheets.delete(id);
            }
            return;
        }
        if (!s) {
            if (typeof CSSStyleSheet !== "function") return;
            s = new CSSStyleSheet();
            sheets.set(id, s);
            adopt(s);
        }
        try { s.replaceSync(String(text)); } catch (e) { err("css", id, e); }
    }
    for (const [id, text] of cfg.css ?? []) pendingSheets.push([id, text]);
    for (const [id, text] of pendingSheets) setCss(id, text);

    // ------------------------------------------------------------ intl hash
    // Discord's runtimeHashMessageKey: xxhash64(key) -> 6 base64 chars of the
    // low bytes. Only used while canonicalizing patches.
    const M64 = (1n << 64n) - 1n;
    const P1 = 0x9E3779B185EBCA87n, P2 = 0xC2B2AE3D27D4EB4Fn, P3 = 0x165667B19E3779F9n,
        P4 = 0x85EBCA77C2B2AE63n, P5 = 0x27D4EB2F165667C5n;
    const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64;
    const round = (acc, lane) => (rotl((acc + lane * P2) & M64, 31) * P1) & M64;
    const merge = (acc, v) => (((acc ^ round(0n, v)) * P1) + P4) & M64;
    function xxh64(bytes) {
        const n = bytes.length;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
        let i = 0, h;
        if (n >= 32) {
            let v1 = (P1 + P2) & M64, v2 = P2, v3 = 0n, v4 = (-P1) & M64;
            for (; i + 32 <= n; i += 32) {
                v1 = round(v1, dv.getBigUint64(i, true));
                v2 = round(v2, dv.getBigUint64(i + 8, true));
                v3 = round(v3, dv.getBigUint64(i + 16, true));
                v4 = round(v4, dv.getBigUint64(i + 24, true));
            }
            h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M64;
            h = merge(merge(merge(merge(h, v1), v2), v3), v4);
        } else {
            h = P5;
        }
        h = (h + BigInt(n)) & M64;
        for (; i + 8 <= n; i += 8) {
            h ^= round(0n, dv.getBigUint64(i, true));
            h = (rotl(h, 27) * P1 + P4) & M64;
        }
        if (i + 4 <= n) {
            h ^= (BigInt(dv.getUint32(i, true)) * P1) & M64;
            h = (rotl(h, 23) * P2 + P3) & M64;
            i += 4;
        }
        for (; i < n; i++) {
            h ^= (BigInt(bytes[i]) * P5) & M64;
            h = (rotl(h, 11) * P1) & M64;
        }
        h ^= h >> 33n; h = (h * P2) & M64;
        h ^= h >> 29n; h = (h * P3) & M64;
        h ^= h >> 32n;
        return h;
    }
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function intlHash(key) {
        const h = xxh64(new TextEncoder().encode(key));
        const b = i => Number((h >> BigInt(8 * i)) & 0xffn);
        const [b0, b1, b2, b3, b4] = [b(0), b(1), b(2), b(3), b(4)];
        return B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[((b1 & 15) << 2) | (b2 >> 6)]
            + B64[b2 & 63] + B64[b3 >> 2] + B64[((b3 & 3) << 4) | (b4 >> 4)];
    }

    // ------------------------------------------------------------ patch canonicalization
    const IDENT = String.raw`(?:[A-Za-z_$][\w$]*)`;
    function canonIntl(src, isString) {
        return src.replaceAll(/#{intl::([\w$+/]*)(?:::(\w+))?}/g, (_, key, mod) => {
            const hashed = mod === "raw" ? key : intlHash(key);
            if (mod === "hash") return isString ? hashed : `(?:${hashed})`.replaceAll("+", "\\+");
            const special = !Number.isNaN(Number(hashed[0])) || hashed.includes("+") || hashed.includes("/");
            if (special) return isString ? `["${hashed}"]` : String.raw`(?:\["${hashed}"\])`.replaceAll("+", "\\+");
            return isString ? `.${hashed}` : String.raw`(?:\.${hashed})`;
        });
    }
    function canonMatch(m) {
        if (typeof m === "string") return canonIntl(m, true);
        const src = canonIntl(m.source, false).replaceAll(/(\\*)\\i/g, (all, esc) =>
            esc.length % 2 === 0 ? esc + IDENT : all.slice(1));
        return new RegExp(src, m.flags);
    }
    function canonReplace(r, selfPath) {
        if (typeof r === "function") return (...a) => String(r(...a)).replaceAll("$self", selfPath);
        return String(r).replaceAll("$self", selfPath);
    }
    const matches = (code, f) => typeof f === "string" ? code.includes(f) : (f.lastIndex = 0, f.test(code));

    // ------------------------------------------------------------ plugins
    const plugins = Object.create(null);
    const patches = [];  // { plugin, find:[...], replacement:[...], all, hits, ... }
    const GLOBAL = cfg.token ? "__cv" + cfg.token.slice(0, 12) : "__corvid";
    const corvid = {};
    // What patched Discord code reaches as `$self`: per plugin, only the
    // members its patch replacements name. The page global must not hand
    // Discord's scripts (or anything injected into the page) the host bridge,
    // settings or plugin setting stores — those can rewrite host options
    // (proxy, telemetry blocking) and persist across restarts.
    const pagePlugins = Object.create(null);
    function exposeToPatches(p, replace) {
        if (typeof replace !== "string") return;
        const face = (pagePlugins[p.name] ??= Object.create(null));
        for (const [, k] of replace.matchAll(/\$self\.([A-Za-z_$][\w$]*)/g)) {
            if (k in face) continue;
            Object.defineProperty(face, k, typeof p[k] === "function"
                ? { value: function (...a) { return p[k].apply(p, a); } }
                : { get: () => p[k] });
        }
    }

    function pluginSettings(name) {
        return (settings.plugins[name] ??= {});
    }
    function isEnabled(p) {
        if (p.required) return true;
        const s = settings.plugins[p.name];
        return s?.enabled ?? !!p.enabledByDefault;
    }

    let saveTimer = 0;
    function saveSettings() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => native("settings.save", settings).catch(e => err("save settings", e)), 250);
    }

    /**
     * Define a plugin. Fields: name, description, enabledByDefault, required,
     * settings {key: {type, default, description, options, restartNeeded}},
     * patches [{find, replacement: {match, replace, predicate} | [...], predicate, all, noWarn}],
     * start(), stop(), flux {EVENT(payload)}, css (string, applied while enabled).
     */
    function definePlugin(p) {
        if (!p?.name || plugins[p.name]) { err("bad or duplicate plugin", p?.name); return p; }
        plugins[p.name] = p;
        const own = pluginSettings(p.name);
        own.settings ??= {};
        // p.settings.store: live values with defaults filled in; writes persist.
        const defs = p.settings ?? {};
        const store = new Proxy(own.settings, {
            get: (t, k) => (k in t ? t[k] : defs[k]?.default),
            set: (t, k, v) => { t[k] = v; saveSettings(); p.onSettingChange?.(k, v); return true; },
        });
        p.settings = { def: defs, store };
        p.started = false;
        p.enabled = isEnabled(p);
        if (p.enabled) {
            if (p.predicate && !safe(() => p.predicate(), p.name)) p.enabled = false;
        }
        if (p.enabled) registerPatches(p);
        if (p.enabled && ready) startPlugin(p);
        return p;
    }

    function safe(fn, label) {
        try { return fn(); } catch (e) { err(label, e); return undefined; }
    }

    function registerPatches(p) {
        const selfPath = `${GLOBAL}.plugins[${stringify(p.name)}]`;
        for (const raw of p.patches ?? []) {
            if (raw.predicate && !safe(() => raw.predicate(), p.name)) continue;
            const finds = (Array.isArray(raw.find) ? raw.find : [raw.find]).map(canonMatch);
            const reps = (Array.isArray(raw.replacement) ? raw.replacement : [raw.replacement]).map(r => (exposeToPatches(p, r.replace), {
                match: canonMatch(r.match),
                replace: canonReplace(r.replace, selfPath),
                predicate: r.predicate,
                noWarn: r.noWarn,
                applied: 0,
            }));
            const key = p.name + "\0" + finds.map(String).join("\0");
            patches.push({ plugin: p.name, key, src: raw.find, finds, reps, all: !!raw.all, noWarn: !!raw.noWarn, hits: 0, failed: 0 });
            prefilterDirty = true;
        }
    }

    function startPlugin(p) {
        if (p.started) return;
        try {
            if (p.css) setCss("plugin:" + p.name, p.css);
            p.start?.();
            if (p.flux && flux) for (const [ev, fn] of Object.entries(p.flux)) {
                const h = p.flux[ev] = fn.bind(p);
                flux.subscribe(ev, h);
            }
            p.started = true;
        } catch (e) { err("start", p.name, e); }
    }

    function stopPlugin(p) {
        if (!p.started) return;
        try {
            if (p.flux && flux) for (const [ev, h] of Object.entries(p.flux)) flux.unsubscribe(ev, h);
            p.stop?.();
            setCss("plugin:" + p.name, null);
        } catch (e) { err("stop", p.name, e); }
        p.started = false;
    }

    /** Toggle at runtime. Plugins with patches need a reload to fully apply. */
    function setPluginEnabled(name, on) {
        const p = plugins[name];
        if (!p || p.required) return false;
        pluginSettings(name).enabled = !!on;
        saveSettings();
        p.enabled = !!on;
        if (on && ready) startPlugin(p); else if (!on) stopPlugin(p);
        return !!(p.patches?.length);  // true = restart needed
    }

    // ------------------------------------------------------------ webpack
    let wreq = null;
    let flux = null;
    let ready = false;
    const waiters = [];          // [filter, callback]
    const patchedModuleSets = new WeakSet();
    const stats = { modules: 0, patched: 0, patchMs: 0 };

    function toFnSource(code) {
        // Object-method shorthand factories ("123(e,t,n){") aren't expressions,
        // and "function 123(" isn't valid either: drop the numeric name.
        if (/^(?:function|async|\()/.test(code) || /^[\w$]+\s*=>/.test(code)) return code;
        return "function" + code.slice(code.indexOf("("));
    }

    // One combined regex of a string find per still-searching patch: a single
    // pass over each module instead of one includes() per patch (~17 x 17 MB
    // at startup). Patches without a string find are always checked; patches
    // that already hit only need their own module id (`pinned`).
    let prefilterDirty = true, prefilter = null, alwaysCheck = false;
    const pinned = new Set();
    const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Module ids are fixed per Discord build, so remember which module each
    // patch hit (settings.patchCache, keyed by GLOBAL_ENV.VERSION_HASH) and
    // on the next launch of the same build only look at that module.
    let cacheBuild;  // undefined until the first factory is patched
    // Boot-time negative cache: module ids seen before `ready` last launch,
    // and the patches that missed all of them. While booting, a module in
    // that set can't match any of those patches, so it isn't even stringified.
    // Lazy chunks (after ready) are always scanned.
    let bootSkip = null;
    const bootIds = [];
    // `seen` as sorted base-36 deltas ("d:" prefix): ~2.6x smaller than the
    // plain id list (78 KB -> 30 KB for 11k ids), which rides in settings.json,
    // every settings.save and every injected CORVID_CFG.
    const encIds = ids => {
        const n = [...new Set(ids)].map(Number);
        if (!n.every(Number.isSafeInteger)) return ids.join(",");
        n.sort((a, b) => a - b);
        let prev = 0;
        return "d:" + n.map(x => (x - prev).toString(36) + ((prev = x), "")).join(",");
    };
    const decIds = s => {
        if (!s.startsWith("d:")) return s.split(",");
        let x = 0;
        return s.slice(2).split(",").map(d => String(x += parseInt(d, 36)));
    };
    function writeBootCache() {
        if (!cacheBuild) return;
        const c = settings.patchCache;
        const miss = patches.filter(p => !p.all && p.hitId === undefined).map(p => p.key);
        const allHits = {};
        for (const p of patches) if (p.all) allHits[p.key] = p.allIds ?? [];
        if (c.seen && miss.every(k => c.miss?.includes(k)) && Object.keys(allHits).every(k => c.allHits?.[k])) return;
        c.seen = encIds(bootIds);
        c.miss = miss;
        c.allHits = allHits;
        saveSettings();
    }
    function cacheHit(p, id) {
        if (!cacheBuild || p.all) return;
        const hits = settings.patchCache.hits;
        if (hits[p.key] === id) return;
        hits[p.key] = id;
        saveSettings();
    }
    function rebuildPrefilter() {
        prefilterDirty = false;
        alwaysCheck = false;
        if (cacheBuild === undefined) {
            cacheBuild = G.GLOBAL_ENV?.VERSION_HASH ?? null;
            if (cacheBuild && settings.patchCache?.build !== cacheBuild) settings.patchCache = { build: cacheBuild, hits: {} };
        }
        const lits = new Set();
        for (const p of patches) {
            if (cacheBuild && !p.all && p.hitId === undefined && !p.seeded) {
                p.seeded = true;
                const id = settings.patchCache.hits[p.key];
                if (id !== undefined) { p.hitId = id; p.cached = true; pinned.add(id); }
            }
            if (cacheBuild && p.all && !p.seeded) {
                p.seeded = true;
                const ids = settings.patchCache.allHits?.[p.key];
                if (ids) { p.allCached = true; for (const id of ids) pinned.add(id); }
            }
            if (p.hitId !== undefined && !p.all) continue;
            const lit = p.finds.find(f => typeof f === "string");
            if (lit === undefined || lit === "") { alwaysCheck = true; continue; }
            lits.add(lit);
        }
        prefilter = lits.size ? new RegExp([...lits].map(reEscape).join("|")) : null;
        const c = cacheBuild && settings.patchCache;
        bootSkip = null;
        if (c?.seen && !alwaysCheck && patches.every(p => p.all ? p.allCached : (p.hitId !== undefined || c.miss?.includes(p.key))))
            bootSkip = new Set(decIds(c.seen));
    }

    // Run one patch's replacements over `code`. Returns { code, done }.
    function runReps(p, code, id) {
        const done = [];
        for (const r of p.reps) {
            if (r.predicate && !safe(() => r.predicate(), p.plugin)) continue;
            let next;
            try { next = code.replace(r.match, r.replace); } catch (e) { err(p.plugin, "replace threw", e); continue; }
            if (next === code) {
                if (!r.noWarn && !p.noWarn) warn(`${p.plugin}: replacement ${r.match} had no effect (module ${id})`);
                continue;
            }
            r.applied++;
            done.push(r);
            code = next;
        }
        return { code, done };
    }
    const compileModule = (code, id) => (0, eval)(`0,${toFnSource(code)}\n//# sourceURL=corvid:///WebpackModule${id}`);

    function patchFactory(id, factory) {
        if (prefilterDirty) rebuildPrefilter();
        if (!ready) {
            bootIds.push(id);
            if (bootSkip?.has(id) && !pinned.has(id)) return factory;
        }
        const original = String(factory);
        if (!alwaysCheck && !pinned.has(id) && !(prefilter && prefilter.test(original))) return factory;
        let code = original;
        const steps = [];  // patches that changed this module, in order
        for (const p of patches) {
            // One module per non-`all` patch, but every copy of it: Discord
            // ships the same module id in several chunks (differently minified)
            // and whichever chunk loads last wins.
            if (p.hitId !== undefined && !p.all && p.hitId !== id) continue;
            if (!p.finds.every(f => matches(code, f))) continue;
            if (p.hitId === undefined) { p.hitId = id; if (!p.all) pinned.add(id); }
            if (p.all && !ready) (p.allIds ??= []).push(id);
            if (!p.cached) cacheHit(p, id);
            p.hits++;
            const r = runReps(p, code, id);
            if (!r.done.length) continue;
            steps.push({ p, done: r.done });
            code = r.code;
        }
        if (!steps.length) return factory;
        // Compile once, not once per patch: a module several patches hit
        // (FakeNitro's MessageAccessories, ~180 KB) was parsed for each.
        try {
            const fn = compileModule(code, id);
            stats.patched++;
            return fn;
        } catch {}
        // Some patch broke it: redo one patch at a time, dropping the ones
        // that don't compile (the rest re-run on the reverted source).
        let fn = factory;
        code = original;
        for (const s of steps) {
            for (const r of s.done) r.applied--;
            const r = runReps(s.p, code, id);
            if (!r.done.length) continue;
            try {
                fn = compileModule(r.code, id);
                code = r.code;
            } catch (e) {
                err(`${s.p.plugin}: patch broke module ${id}, reverted`, e);
                s.p.failed++;
                for (const x of r.done) x.applied--;
            }
        }
        if (fn !== factory) stats.patched++;
        return fn;
    }

    function onModuleLoaded(exports, id) {
        if (!waiters.length || exports == null) return;
        for (let i = waiters.length - 1; i >= 0; i--) {
            const [filter, cb] = waiters[i];
            const hit = testExports(exports, filter);
            if (hit !== undefined) {
                waiters.splice(i, 1);
                safe(() => cb(hit, id), "waitFor callback");
            }
        }
    }

    // Shared, so wrapping 11k factories allocates one closure each, not two.
    function wrappedToString() { return String(this.$$corvid); }
    function wrapFactory(id, fn) {
        const w = function (module, exports, require) {
            if (require !== lastReq && typeof require === "function") addRuntime(require);
            const r = fn.apply(this, arguments);
            onModuleLoaded(module?.exports, id);
            return r;
        };
        w.toString = wrappedToString;
        w.$$corvid = fn;
        return w;
    }

    function patchModules(modules) {
        if (!modules || typeof modules !== "object" || patchedModuleSets.has(modules)) return;
        patchedModuleSets.add(modules);
        const t0 = performance.now();
        for (const id of Object.keys(modules)) {
            const f = modules[id];
            if (typeof f !== "function" || f.$$corvid) continue;
            stats.modules++;
            modules[id] = wrapFactory(id, patches.length ? patchFactory(id, f) : f);
        }
        stats.patchMs += performance.now() - t0;
    }

    function hookChunkArray(arr) {
        if (!Array.isArray(arr) || arr.$$corvid) return;
        Object.defineProperty(arr, "$$corvid", { value: true });
        for (const c of arr) patchModules(c?.[1]);
        let inner = arr.push;
        Object.defineProperty(arr, "push", {
            configurable: true,
            get() {
                // Bind to whatever push is current *now*: webpack captures the
                // original push before installing its own, which then calls it.
                const target = inner;
                return function (...chunks) {
                    for (const c of chunks) patchModules(c?.[1]);
                    return target.apply(this, chunks);
                };
            },
            set(v) { inner = v; },
        });
    }

    let chunkArr;
    Object.defineProperty(G, "webpackChunkdiscord_app", {
        configurable: true,
        get: () => chunkArr,
        set(v) { chunkArr = v; hookChunkArray(v); },
    });

    // The entry chunk's modules (~3k, incl. many patch targets) are inlined in
    // the runtime as `require.m = {...}` and never pushed: catch that assignment.
    Object.defineProperty(Function.prototype, "m", {
        configurable: true,
        set(v) {
            Object.defineProperty(this, "m", { value: v, writable: true, configurable: true, enumerable: true });
            if (v && typeof v === "object" && Function.prototype.toString.call(this).includes("exports:{}")) {
                patchModules(v);
                addRuntime(this);
            }
        },
    });

    // Discord's page runs more than one webpack runtime; the main one is the
    // one with the most modules. Finders search all of them.
    const runtimes = new Set();
    let lastReq = null;
    function addRuntime(r) {
        lastReq = r;
        if (runtimes.has(r)) return;
        runtimes.add(r);
        const size = x => (x?.m ? Object.keys(x.m).length : 0);
        if (!wreq || size(r) > size(wreq)) wreq = r;
        if (runtimes.size === 1) onFirstRuntime();
    }

    function onFirstRuntime() {
        // Flux comes early in Discord's boot; plugins start once it exists.
        waitFor(byProps("dispatch", "subscribe", "_subscriptions"), d => {
            flux = d;
            ready = true;
            writeBootCache();
            for (const p of Object.values(plugins)) if (p.enabled) startPlugin(p);
            log(`started; ${stats.modules} modules, ${stats.patched} patched in ${stats.patchMs.toFixed(1)} ms`);
        });
    }

    // ------------------------------------------------------------ finders
    const isObj = v => v != null && (typeof v === "object" || typeof v === "function");

    function testExports(e, filter) {
        if (!isObj(e) || e === G) return undefined;
        try { if (filter(e)) return e; } catch {}
        if (e.default !== undefined && isObj(e.default)) { try { if (filter(e.default)) return e.default; } catch {} }
        if (typeof e === "object") {
            for (const k in e) {
                if (k === "default") continue;
                let v;
                try { v = e[k]; } catch { continue; }
                if (v !== e && isObj(v)) { try { if (filter(v)) return v; } catch {} }
            }
        }
        return undefined;
    }

    function find(filter, { all = false } = {}) {
        const out = [];
        for (const r of runtimes) {
            if (!r.c) continue;
            for (const id in r.c) {
                const hit = testExports(r.c[id]?.exports, filter);
                if (hit === undefined) continue;
                if (!all) return hit;
                out.push(hit);
            }
        }
        return all ? out : undefined;
    }

    function waitFor(filter, cb) {
        const hit = find(filter);
        if (hit !== undefined) { cb(hit); return; }
        waiters.push([filter, cb]);
    }

    // Catch-all Proxies answer every property; real modules don't have this one.
    const byProps = (...props) => m => m.$$corvidNoSuchProp === undefined && props.every(p => m[p] !== undefined);
    const byCode = (...code) => {
        const c = code.map(canonMatch);
        return m => typeof m === "function" && c.every(x => matches(Function.prototype.toString.call(m), x));
    };
    const byStoreName = name => m => m?.constructor?.displayName === name || (typeof m?.getName === "function" && m.getName?.() === name && m.constructor?.displayName == null);

    /** Module whose factory source contains all `code` strings/regexes. */
    function findModuleByCode(...code) {
        const c = code.map(canonMatch);
        for (const r of runtimes) {
            if (!r.m) continue;
            for (const id in r.m) {
                const src = String(r.m[id]);
                if (c.every(x => matches(src, x))) return r(id);
            }
        }
        return undefined;
    }

    /** {name: filter} over the (mangled) exports of the module found by `code`. */
    function mapMangled(code, map) {
        const mod = findModuleByCode(code);
        const out = {};
        if (!mod) return out;
        for (const [name, filter] of Object.entries(map)) {
            for (const k in mod) {
                let v;
                try { v = mod[k]; } catch { continue; }
                try { if (filter(v)) { out[name] = v; break; } } catch {}
            }
        }
        return out;
    }

    /** A getter that finds once and caches; returns undefined until found. */
    function lazy(fn) {
        let v;
        return () => v ?? (v = fn());
    }

    /** `corvid.stores.EmojiStore` etc., cached. */
    const storeCache = new Map();
    const stores = new Proxy({}, {
        get(_, name) {
            if (typeof name !== "string") return undefined;
            let s = storeCache.get(name);
            if (!s) {
                s = find(byStoreName(name));
                if (s) storeCache.set(name, s);
            }
            return s;
        },
    });

    // ------------------------------------------------------------ message hooks
    const preSend = new Set();
    const preEdit = new Set();
    let msgHooked = false;
    function hookMessages() {
        if (msgHooked) return;
        msgHooked = true;
        waitFor(byProps("sendMessage", "editMessage"), MA => {
            const desc = Object.getOwnPropertyDescriptor(MA, "sendMessage");
            if (desc && !desc.writable && !desc.set) { err("MessageActions not writable; send hooks off"); return; }
            const origSend = MA.sendMessage;
            MA.sendMessage = async function (channelId, message, ...rest) {
                const options = rest[1] ?? (rest[1] = {});
                for (const l of preSend) {
                    try {
                        if ((await l(channelId, message, options))?.cancel) return;
                    } catch (e) { err("preSend", e); }
                }
                return origSend.call(this, channelId, message, ...rest);
            };
            const origEdit = MA.editMessage;
            MA.editMessage = async function (channelId, messageId, message, ...rest) {
                for (const l of preEdit) {
                    try {
                        if ((await l(channelId, messageId, message))?.cancel) return;
                    } catch (e) { err("preEdit", e); }
                }
                return origEdit.call(this, channelId, messageId, message, ...rest);
            };
        });
    }

    // ------------------------------------------------------------ host -> page
    const hostApi = {
        reply(id, ok, value) {
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            ok ? p.resolve(value) : p.reject(new Error(String(value)));
        },
        css: setCss,
        event(name, payload) {
            for (const fn of listeners.get(name) ?? []) safe(() => fn(payload), "event " + name);
        },
    };
    const listeners = new Map();
    function on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => listeners.get(name).delete(fn);
    }
    if (cfg.token) Object.defineProperty(G, cfg.token, { value: Object.freeze(hostApi) });

    // ------------------------------------------------------------ public API
    Object.assign(corvid, {
        version: cfg.version ?? {},
        settings,
        saveSettings,
        plugins,
        definePlugin,
        setPluginEnabled,
        isEnabled: name => !!plugins[name]?.enabled,
        native,
        on,
        css: { set: setCss },
        log, warn, err,
        webpack: {
            get wreq() { return wreq; },
            find, waitFor, lazy, findModuleByCode, mapMangled,
            filters: { byProps, byCode, byStoreName },
            findByProps: (...p) => find(byProps(...p)),
            findByCode: (...c) => find(byCode(...c)),
            findStore: name => stores[name],
        },
        stores,
        messages: {
            onPreSend(fn) { hookMessages(); preSend.add(fn); return () => preSend.delete(fn); },
            onPreEdit(fn) { hookMessages(); preEdit.add(fn); return () => preEdit.delete(fn); },
        },
        openExternal: url => native("open.external", { url }),
        // internals for tests and the settings UI
        _internal: { writeBootCache, patches, stats, intlHash, canonMatch, patchModules, get ready() { return ready; } },
    });
    // A real getter (Object.assign would have copied the value once).
    Object.defineProperty(corvid, "flux", { get: () => flux, enumerable: true });
    // Smoke tests (--smoke-js only) use the full API from page context.
    Object.defineProperty(G, GLOBAL, { value: cfg.test ? corvid : Object.freeze({ plugins: pagePlugins }) });
    // Plugin files reach the API through this lexical name.
    G.__corvidDefine = corvid;
})();
