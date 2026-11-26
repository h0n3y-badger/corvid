// What Discord's own page scripts can see of corvid, on a normal (non
// --smoke-js) run. corvid must run with --remote-debugging-port=PORT:
//   node tests/cdp-page-global.mjs PORT [seconds]
// Checks the page global only exposes the $self facade (no host bridge,
// settings or plugin objects), that facade calls work, and reports page
// exceptions that mention corvid while Discord loads.
const [port, secs = "20"] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === "page" && t.url.startsWith("https://discord.com"));
if (!page) { console.error("no discord page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const errors = [];
ws.addEventListener("message", e => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(d.exception?.description ?? d.text);
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        errors.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
    }
});
const send = (method, params) => new Promise(res => {
    const my = ++id;
    ws.addEventListener("message", function h(e) { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } });
    ws.send(JSON.stringify({ id: my, method, params }));
});
await send("Runtime.enable");
await new Promise(r => setTimeout(r, Number(secs) * 1000));
const probe = `(() => {
    const names = Object.getOwnPropertyNames(window).filter(n => n.startsWith("__cv") || n.startsWith("_cv") || n.startsWith("__corvid"));
    const out = { names, globals: {} };
    for (const n of names) {
        const g = window[n];
        out.globals[n] = { keys: Object.getOwnPropertyNames(g), frozen: Object.isFrozen(g),
            hasNative: typeof g.native, hasSettings: typeof g.settings };
        if (g.plugins) out.globals[n].plugins = Object.fromEntries(Object.keys(g.plugins).map(p => [p, Object.getOwnPropertyNames(g.plugins[p])]));
    }
    const face = names.map(n => window[n]).find(g => g.plugins?.FakeNitro);
    try { out.facadeCall = typeof face?.plugins.FakeNitro.stickerBypassOn?.(); } catch (e) { out.facadeCall = "threw " + e; }
    out.guildsRendered = !!document.querySelector('[data-list-id="guildsnav"]');
    return out;
})()`;
const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
ws.close();
console.log(JSON.stringify(r.result.value, null, 1));
const ours = errors.filter(e => /corvid|__cv|\$self/i.test(e));
console.log(`page errors: ${errors.length} total, ${ours.length} mentioning corvid`);
for (const e of ours.slice(0, 10)) console.log("  " + e.split("\n")[0]);
