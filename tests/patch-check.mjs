#!/usr/bin/env node
// corvid patch checker: validates every plugin patch against Discord's live
// web client build, statically (no DOM, nothing executed but the bundle).
// SPDX-License-Identifier: MIT
//
//   node tests/patch-check.mjs [options]
//     --plugin NAME     only enable/report this plugin (repeatable)
//     --offline         don't touch the network; use the newest cached build
//     --build HASH      use this cached build (implies --offline)
//     --refresh         re-download every file of the current build
//     --verbose         list every patch, not only problems; show core's console
//     --show            also print each replacement's before/after snippet
//     --grep REGEX      print snippets of modules whose source matches REGEX
//     --context N       snippet radius for --grep (default 300)
//     --module ID       print the full (original) source of one module
//
// Downloads https://discord.com/app anonymously, reads the webpack (rspack)
// runtime to get the URL of every lazy chunk, and caches everything under
// target/discord-assets/<VERSION_HASH>/. It then evaluates the injected
// bundle (core.js + js/plugins/*.js, assembled exactly like the host does)
// in a node:vm context, evaluates every chunk in it (core.js's hooks patch the
// factories on push / on `require.m = ...` without running them) and reports
// per patch how many modules each find matched, which replacements had no
// effect and which patches broke compilation. Exit code 1 on any problem.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, "target", "discord-assets");
const ORIGIN = "https://discord.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const CONCURRENCY = 6;

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = { plugins: [], offline: false, build: null, refresh: false, verbose: false, grep: null, context: 300, module: null };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => { if (i + 1 >= args.length) die(`${a} needs a value`); return args[++i]; };
    if (a === "--plugin") opt.plugins.push(next());
    else if (a === "--offline") opt.offline = true;
    else if (a === "--build") { opt.build = next(); opt.offline = true; }
    else if (a === "--refresh") opt.refresh = true;
    else if (a === "--verbose" || a === "-v") opt.verbose = true;
    else if (a === "--show") { opt.show = true; opt.verbose = true; }
    else if (a === "--grep") opt.grep = new RegExp(next(), "g");
    else if (a === "--context") opt.context = Number(next());
    else if (a === "--module") opt.module = next();
    else if (a === "--help" || a === "-h") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(4, 14).map(l => l.slice(3)).join("\n")); process.exit(0); }
    else die(`unknown argument ${a}`);
}
function die(msg) { console.error("patch-check:", msg); process.exit(2); }

// ------------------------------------------------------------------ download
async function get(url, { text = true, tries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { "User-Agent": UA, "Accept": text ? "*/*" : "*/*", "Accept-Language": "en-US,en;q=0.9" },
                redirect: "follow",
                signal: AbortSignal.timeout(60_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.text();
        } catch (e) {
            if (attempt >= tries) throw new Error(`${url}: ${e.message}`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

/** Source of the object/function body starting at the `{` at `start`, string-aware. */
function balanced(src, start) {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`") {
            for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
        } else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error("unbalanced braces");
}

/** All lazy chunk files the runtime knows about, from its `require.u` function. */
function chunkFilesFromRuntime(runtime) {
    // rspack/webpack: `<req>.u=e=>{...}` (or function(e){...}) maps chunk id -> file name.
    // Later wrappers (`p.u=function(e){return m(e)+...}`) delegate to it; take the
    // first definition whose body builds a ".js" name from a literal table.
    const re = /([\w$]+)\.u=(?:\(?([\w$]+)\)?=>|function\(([\w$]+)\))\{/g;
    for (let m; (m = re.exec(runtime));) {
        const param = m[2] ?? m[3];
        const body = balanced(runtime, m.index + m[0].length - 1);
        if (!body.includes('.js"') || body.length < 200) continue;
        const fn = vm.runInNewContext(`(${param})=>${body}`, Object.create(null), { timeout: 5000 });
        const ids = new Set();
        const esc = param.replace(/\$/g, "\\$");
        for (const x of body.matchAll(new RegExp(String.raw`([\d.e]+)===${esc}\b`, "g"))) ids.add(Number(x[1]));
        for (const x of body.matchAll(/[{,]([\d.e]+|"[^"]+"):"/g)) {
            const k = x[1].startsWith('"') ? x[1].slice(1, -1) : Number(x[1]);
            ids.add(k);
        }
        const files = new Set();
        for (const id of ids) {
            const f = fn(id);
            if (typeof f === "string" && f.endsWith(".js") && !f.includes("undefined")) files.add(f);
        }
        if (files.size) return [...files];
    }
    throw new Error("could not find the chunk URL function (require.u) in the runtime");
}

async function pool(items, n, fn) {
    let next = 0, done = 0;
    const total = items.length;
    const tick = () => { if (process.stderr.isTTY) process.stderr.write(`\r  ${done}/${total}`); };
    await Promise.all(Array.from({ length: Math.min(n, total) }, async () => {
        while (next < total) {
            const item = items[next++];
            await fn(item);
            done++;
            if (done % 25 === 0 || done === total) tick();
        }
    }));
    if (process.stderr.isTTY) process.stderr.write("\n");
}

function newestBuild() {
    if (!fs.existsSync(CACHE)) return null;
    const dirs = fs.readdirSync(CACHE)
        .filter(d => fs.existsSync(path.join(CACHE, d, "manifest.json")))
        .map(d => ({ d, t: fs.statSync(path.join(CACHE, d, "manifest.json")).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    return dirs[0]?.d ?? null;
}

async function ensureAssets() {
    if (opt.offline) {
        const b = opt.build ?? newestBuild();
        if (!b) die("no cached build; run once online");
        return loadManifest(b);
    }
    let html;
    try { html = await get(`${ORIGIN}/app`); } catch (e) {
        const b = newestBuild();
        if (!b) throw e;
        console.error(`patch-check: ${e.message}; using cached build ${b}`);
        return loadManifest(b);
    }
    const env = html.match(/"VERSION_HASH":"([0-9a-f]+)"/)?.[1];
    const buildNumber = html.match(/"BUILD_NUMBER":"(\d+)"/)?.[1] ?? null;
    if (!env) throw new Error("no VERSION_HASH in /app HTML");
    const dir = path.join(CACHE, env);
    if (!opt.refresh && fs.existsSync(path.join(dir, "manifest.json"))) return loadManifest(env);

    console.error(`patch-check: downloading build ${buildNumber} (${env.slice(0, 12)})`);
    const adir = path.join(dir, "assets");
    fs.mkdirSync(adir, { recursive: true });
    fs.writeFileSync(path.join(dir, "app.html"), html);
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="\/assets\/([^"?#]+\.js)"/g)].map(m => m[1]);
    if (!scripts.length) throw new Error("no /assets scripts in /app HTML");

    const fetchTo = async file => {
        if (/[/\\]|\.\./.test(file)) throw new Error(`refusing odd asset name ${file}`);
        const dest = path.join(adir, file);
        if (!opt.refresh && fs.existsSync(dest)) return;
        const body = await get(`${ORIGIN}/assets/${file}`);
        fs.writeFileSync(dest + ".part", body);
        fs.renameSync(dest + ".part", dest);
    };
    await pool(scripts, CONCURRENCY, fetchTo);

    // The runtime is the initial script whose chunk loader yields the lazy chunk table.
    let runtime = null, lazy = null;
    for (const s of scripts) {
        const src = fs.readFileSync(path.join(adir, s), "utf8");
        if (!src.includes("webpackChunkdiscord_app") || !/\.u=(?:\(?[\w$]+\)?=>|function\([\w$]+\))\{/.test(src)) continue;
        try { lazy = chunkFilesFromRuntime(src).filter(f => !scripts.includes(f)); runtime = s; break; } catch {}
    }
    if (!runtime) throw new Error("no webpack runtime (chunk URL table) among the initial scripts");
    console.error(`patch-check: ${scripts.length} initial scripts, ${lazy.length} lazy chunks`);
    await pool(lazy, CONCURRENCY, fetchTo);

    const manifest = { versionHash: env, buildNumber, fetchedAt: new Date().toISOString(), runtime, initial: scripts, lazy };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
    return loadManifest(env);
}

function loadManifest(b) {
    const dir = path.join(CACHE, b);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    m.dir = path.join(dir, "assets");
    return m;
}

// ------------------------------------------------------------------ bundle
function assembleBundle(token) {
    const core = fs.readFileSync(path.join(ROOT, "js", "core.js"), "utf8");
    const pdir = path.join(ROOT, "js", "plugins");
    const files = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter(f => f.endsWith(".js")).sort() : [];
    const sources = files.map(f => [f, fs.readFileSync(path.join(pdir, f), "utf8")]);
    const plugins = {};
    const names = [];
    for (const [f, src] of sources) {
        for (const m of src.matchAll(/definePlugin\(\s*\{\s*name:\s*(["'])(.+?)\1/g)) names.push(m[2]);
    }
    for (const n of opt.plugins) if (!names.includes(n)) die(`no plugin named ${n} (have: ${names.join(", ")})`);
    for (const n of names) plugins[n] = { enabled: !opt.plugins.length || opt.plugins.includes(n) };
    const cfg = { settings: { plugins }, css: [], token, version: {}, test: true };
    let out = `const CORVID_CFG = ${JSON.stringify(cfg)};\n${core}\n;(corvid => {\n`;
    // Mirrors crates/corvid-core/src/bundle.rs body().
    for (const [name, src] of sources) out += `try { (() => {\n${src}\n})(); } catch (e) { console.error("[corvid] plugin file ${name} failed", e); }\n`;
    out += `})(globalThis.__corvidDefine);\ndelete globalThis.__corvidDefine;\n`;
    return { code: out, files, names };
}

// ------------------------------------------------------------------ evaluate
function makeContext(log) {
    const noop = () => {};
    const quiet = {
        log: (...a) => log.push(["log", a]), info: (...a) => log.push(["log", a]),
        warn: (...a) => log.push(["warn", a]), error: (...a) => log.push(["error", a]),
        debug: noop, trace: noop, group: noop, groupEnd: noop, time: noop, timeEnd: noop, assert: noop,
    };
    const sandbox = {
        console: quiet, performance, TextEncoder, TextDecoder, URL, URLSearchParams,
        setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
        queueMicrotask: noop, requestAnimationFrame: noop, AbortController, Event: class {}, EventTarget,
        navigator: { userAgent: UA, platform: "Linux x86_64", language: "en-US", languages: ["en-US"] },
        location: new URL(`${ORIGIN}/app`),
    };
    const ctx = vm.createContext(sandbox);
    vm.runInContext("globalThis.self = globalThis.window = globalThis.top = globalThis.parent = globalThis;", ctx);
    return ctx;
}

// Discord ships many module ids in several chunks, minified differently; the
// last chunk to load wins at runtime, so every copy has to be patched.
const copies = [];             // [{id, code, file}] in load (= patch) order
const originals = new Map();   // module id -> [copy, ...]
let curFile = "";
const seenObjects = new WeakSet();
function snapshot(mods) {
    // The same chunk can pass through several push wrappers; count it once.
    if (!mods || typeof mods !== "object" || seenObjects.has(mods)) return;
    seenObjects.add(mods);
    for (const id of Object.keys(mods)) {
        const f = mods[id];
        if (typeof f !== "function" || f.$$corvid) continue;
        const code = Function.prototype.toString.call(f);
        const list = originals.get(id);
        if (list?.some(c => c.code === code)) continue; // identical copy: nothing new to check
        const c = { id, code, file: curFile };
        copies.push(c);
        if (list) list.push(c); else originals.set(id, [c]);
    }
}

/**
 * Replays core.js's patchFactory over every module copy (same order, same
 * one-module-per-patch rule, later patches see earlier ones' output) and
 * records per patch: chosen module id, copies hit, per-replacement misses.
 */
function simulate(patches) {
    const st = patches.map(p => ({ hitId: undefined, hitCopies: [], repHit: p.reps.map(() => 0), repMiss: p.reps.map(() => []), shown: p.reps.map(() => null) }));
    for (const c of copies) {
        let code = c.code;
        patches.forEach((p, i) => {
            const s = st[i];
            if (s.hitId !== undefined && !p.all && s.hitId !== c.id) return;
            if (!p.finds.every(f => test(code, f))) return;
            s.hitId ??= c.id;
            s.hitCopies.push(c);
            p.reps.forEach((r, j) => {
                if (r.predicate) { try { if (!r.predicate()) return; } catch { return; } }
                const next = code.replace(r.match, r.replace);
                if (next === code) { s.repMiss[j].push(c); return; }
                s.repHit[j]++;
                s.shown[j] ??= diffSnippet(code, next);
                code = next;
            });
        });
    }
    return st;
}

function diffSnippet(before, after) {
    let a = 0;
    while (a < before.length && before[a] === after[a]) a++;
    let e1 = before.length, e2 = after.length;
    while (e1 > a && e2 > a && before[e1 - 1] === after[e2 - 1]) { e1--; e2--; }
    const R = 160;
    const cut = (str, x, y) => `${str.slice(Math.max(0, x - R), x)}\x1b[1m${str.slice(x, y)}\x1b[0m${str.slice(y, y + R)}`;
    return `\n      - ${cut(before, a, e1)}\n      + ${cut(after, a, e2)}`;
}

// A proxied chunk array: snapshot each chunk's factories before core.js's
// push hook (which the proxy forwards to) replaces them with patched wrappers.
const PROXY_ARRAY = `(() => {
    const snap = globalThis.__cvSnap;
    const arr = new Proxy([], { get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k !== "push" || typeof v !== "function") return v;
        return function (...chunks) { for (const c of chunks) snap(c && c[1]); return v.apply(this, chunks); };
    } });
    globalThis.webpackChunkdiscord_app = arr;
})();`;

// The runtime's own modules are assigned as require.m = {...}; snapshot them
// before core.js's Function.prototype "m" hook (if any) sees them.
const M_HOOK = `(() => {
    const snap = globalThis.__cvSnap;
    const prev = Object.getOwnPropertyDescriptor(Function.prototype, "m");
    globalThis.__cvCoreHooksM = !!(prev && prev.set);
    Object.defineProperty(Function.prototype, "m", { configurable: true, set(v) {
        if (v && typeof v === "object") snap(v);
        if (prev && prev.set) prev.set.call(this, v);
        else Object.defineProperty(this, "m", { value: v, writable: true, configurable: true, enumerable: true });
    } });
})();`;

function run(manifest) {
    const log = [];
    const ctx = makeContext(log);
    ctx.__cvSnap = snapshot;
    const token = crypto.randomBytes(16).toString("hex");
    const bundle = assembleBundle(token);
    const problems = [];

    try {
        vm.runInContext(bundle.code, ctx, { filename: "corvid-bundle.js" });
    } catch (e) {
        problems.push(`bundle threw: ${e.stack ?? e}`);
        return { problems, log };
    }
    const corvid = vm.runInContext(`globalThis[${JSON.stringify("__cv" + token.slice(0, 12))}]`, ctx);
    if (!corvid) { problems.push("corvid global not found"); return { problems, log }; }
    for (const [k, a] of log) if (k === "error") problems.push(`bundle logged error: ${a.map(String).join(" ")}`);

    vm.runInContext(PROXY_ARRAY, ctx);
    const files = [...manifest.initial.filter(f => f !== manifest.runtime), ...manifest.lazy];
    const evalErrors = [];
    const t0 = performance.now();
    for (const f of files) {
        curFile = f;
        const src = fs.readFileSync(path.join(manifest.dir, f), "utf8");
        if (!src.includes("webpackChunkdiscord_app")) continue; // sentry etc.: not webpack chunks
        try { vm.runInContext(src, ctx, { filename: f }); } catch (e) { evalErrors.push(`${f}: ${e.message}`); }
    }
    // Runtime last, with a fresh empty chunk array, so its startup keeps
    // waiting for initial chunks and never runs Discord's entry module.
    vm.runInContext(PROXY_ARRAY, ctx);
    vm.runInContext(M_HOOK, ctx);
    curFile = manifest.runtime;
    const coreHooksM = ctx.__cvCoreHooksM;
    const runtimeSrc = fs.readFileSync(path.join(manifest.dir, manifest.runtime), "utf8");
    try { vm.runInContext(runtimeSrc, ctx, { filename: manifest.runtime }); } catch (e) { evalErrors.push(`${manifest.runtime} (runtime): ${e.message}`); }
    const evalMs = performance.now() - t0;

    return { problems, log, corvid, files, evalErrors, evalMs, coreHooksM, bundle };
}

// ------------------------------------------------------------------ report
function fmtFind(src) {
    const one = x => typeof x === "string" ? JSON.stringify(x) : String(x);
    return Array.isArray(src) ? `[${src.map(one).join(", ")}]` : one(src);
}
const test = (code, f) => {
    if (typeof f === "string") return code.includes(f);
    f.lastIndex = 0;
    return f.test(code);
};

async function main() {
    const manifest = await ensureAssets();
    if (opt.module) {
        for (const f of [manifest.runtime, ...manifest.initial, ...manifest.lazy]) {
            const src = fs.readFileSync(path.join(manifest.dir, f), "utf8");
            const i = src.search(new RegExp(String.raw`[{,]${opt.module}\(`));
            if (i < 0) continue;
            // Print from the factory head to its matching brace.
            const open = src.indexOf("{", i + 1);
            console.log(`// ${f}\n${opt.module}${src.slice(i + 1 + opt.module.length, open)}${balanced(src, open)}`);
            return;
        }
        die(`module ${opt.module} not found`);
    }

    const r = run(manifest);
    const out = [];
    let bad = r.problems.length;
    for (const p of r.problems) out.push(`PROBLEM ${p}`);
    if (!r.corvid) { console.log(out.join("\n")); process.exit(1); }

    if (opt.grep) {
        for (const { id, code, file } of copies) {
            opt.grep.lastIndex = 0;
            for (const m of code.matchAll(opt.grep)) {
                const a = Math.max(0, m.index - opt.context), b = Math.min(code.length, m.index + m[0].length + opt.context);
                console.log(`--- module ${id} (${file}) @${m.index}\n${code.slice(a, b)}\n`);
            }
        }
        return;
    }

    const { patches, stats } = r.corvid._internal;
    const filter = opt.plugins.length ? new Set(opt.plugins) : null;
    const sim = simulate(patches);
    let nPatch = 0, nRep = 0, nApplied = 0;
    patches.forEach((p, pi) => {
        if (filter && !filter.has(p.plugin)) return;
        nPatch++;
        const s = sim[pi];
        // Distinct module ids whose (original) source matches the find.
        const matched = [];
        for (const [id, cs] of originals) if (cs.some(c => p.finds.every(f => test(c.code, f)))) matched.push(id);
        const issues = [];
        if (matched.length === 0) issues.push("find matched no module");
        else if (matched.length > 1 && !p.all) issues.push(`find matched ${matched.length} modules (${matched.slice(0, 8).join(", ")}${matched.length > 8 ? ", ..." : ""})`);
        if (s.hitId !== undefined && !p.all) {
            const all = originals.get(s.hitId);
            const missed = all.filter(c => !s.hitCopies.includes(c));
            if (missed.length) issues.push(`find misses ${missed.length} of ${all.length} copies of module ${s.hitId} (${missed.map(c => c.file).join(", ")})`);
        }
        if (p.failed) issues.push(`patch broke compilation ${p.failed}x (reverted)`);
        const reps = p.reps.map((rep, i) => {
            nRep++;
            let skipped = false;
            if (rep.predicate) { try { skipped = !rep.predicate(); } catch { skipped = true; } }
            const label = `  rep ${i}: ${rep.match}`;
            if (skipped) return `${label}  [skipped: predicate false]`;
            const hit = s.repHit[i], miss = s.repMiss[i];
            if (hit && !miss.length) nApplied++;
            if (miss.length && !rep.noWarn && !p.noWarn) {
                issues.push(hit
                    ? `replacement ${i} had no effect in ${miss.length} of ${hit + miss.length} copies (${miss.map(c => c.file).join(", ")}): ${rep.match}`
                    : `replacement ${i} had no effect: ${rep.match}`);
            }
            const status = hit ? `applied in ${hit}/${hit + miss.length} cop${hit + miss.length === 1 ? "y" : "ies"}` : "NO EFFECT";
            return `${label}  ${status}${opt.show && s.shown[i] ? s.shown[i] : ""}`;
        });
        const head = `[${p.plugin}] find ${fmtFind(p.src)} -> ${matched.length} module(s)${matched.length && matched.length <= 3 ? ` (${matched.map(id => `${id}${originals.get(id).length > 1 ? `x${originals.get(id).length}` : ""}`).join(", ")})` : ""}`;
        if (issues.length) {
            bad += issues.length;
            out.push(`FAIL ${head}`);
            for (const s of issues) out.push(`  ! ${s}`);
            out.push(...reps);
        } else if (opt.verbose) {
            out.push(`ok   ${head}`);
            out.push(...reps);
        }
    });

    if (r.evalErrors.length) {
        out.push(`note: ${r.evalErrors.length} file(s) threw while evaluating (workers, sentry, ...; harmless)${opt.verbose ? ":" : "; --verbose lists them"}`);
        if (opt.verbose) for (const e of r.evalErrors) out.push(`  ${e}`);
    }
    const runtimeMods = copies.filter(c => c.file === manifest.runtime).length;
    if (!r.coreHooksM) {
        bad++;
        out.push(`PROBLEM core.js does not hook require.m: the ${runtimeMods} modules inlined in the runtime (${manifest.runtime}) are never patched`);
    }
    if (opt.verbose) for (const [k, a] of r.log) out.push(`core ${k}: ${a.map(x => typeof x === "string" ? x.replace(/%c|color:#\w+/g, "") : String(x)).join(" ").trim()}`);

    out.push("");
    out.push(`build ${manifest.buildNumber} (${manifest.versionHash.slice(0, 12)}): ${r.files.length + 1} files, ${originals.size} modules, ${copies.length} copies (${runtimeMods} in runtime)`);
    out.push(`plugins: ${r.bundle.names.filter(n => !filter || filter.has(n)).join(", ") || "(none)"}`);
    out.push(`patches: ${nPatch}, replacements applied ${nApplied}/${nRep}; core patched ${stats.patched} module(s) of ${stats.modules} seen in ${stats.patchMs.toFixed(1)} ms (eval of all chunks ${(r.evalMs / 1000).toFixed(1)} s)`);
    out.push(bad ? `RESULT: ${bad} problem(s)` : "RESULT: ok");
    console.log(out.join("\n"));
    process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error("patch-check:", e.stack ?? e); process.exit(2); });
