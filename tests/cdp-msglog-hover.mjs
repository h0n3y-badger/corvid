// MessageLogger re-render cost with REAL mouse hovers (CDP Input events).
// Needs the "msglog perf edit-history" message from tests/live-msglog-hover.js
// and corvid running with both:
//   --remote-debugging-port=PORT --smoke-js=tests/smoke-wait.js
//   node tests/cdp-msglog-hover.mjs PORT
const port = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let page;
for (let i = 0; i < 60 && !page; i++) {
    try {
        const ts = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        page = ts.find(t => t.type === "page" && t.url.startsWith("https://discord.com"));
    } catch {}
    if (!page) await sleep(500);
}
if (!page) { console.error("no discord page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const send = (method, params) => new Promise(res => {
    const my = ++id;
    ws.addEventListener("message", function h(e) { const m = JSON.parse(e.data); if (m.id === my) { ws.removeEventListener("message", h); res(m.result); } });
    ws.send(JSON.stringify({ id: my, method, params }));
});
const ev = async expr => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
const setup = await ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
    const c = window[k], wp = c.webpack;
    const t0 = performance.now();
    while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 30000) await sleep(100);
    await sleep(2000);
    const me = c.stores.UserStore.getCurrentUser();
    const guild = (() => { const mine = Object.values(c.stores.GuildStore.getGuilds()).filter(g => g.ownerId === c.stores.UserStore.getCurrentUser().id && /test/i.test(g.name)); return mine.length === 1 ? mine[0] : null; })();
    if (!guild) return { error: "need exactly one server you own with \"test\" in its name" };
    const ch = c.stores.GuildChannelStore.getChannels(guild.id).SELECTABLE.map(x => x.channel).find(x => /test/i.test(x.name) && x.type === 0);
    if (!ch) return { error: "no text channel with \"test\" in its name" };
    const navMod = wp.findModuleByCode("transitionTo - Transitioning to");
    Object.values(navMod).find(f => typeof f === "function" && String(f).includes("Transitioning to"))("/channels/" + guild.id + "/" + ch.id);
    await sleep(4000);
    const m = c.stores.MessageStore.getMessages(ch.id).toArray().find(m => m.content.startsWith("msglog perf edit-history") && m.author.id === me.id);
    if (!m) return { error: "no test message" };
    const row = document.getElementById("chat-messages-" + ch.id + "-" + m.id);
    row.scrollIntoView({ block: "center" });
    await sleep(500);
    const ML = c.plugins.MessageLogger;
    // microbench: one content() call
    let t = performance.now();
    for (let i = 0; i < 300; i++) ML.content(m, null);
    const perCallUs = (performance.now() - t) / 300 * 1000;
    window.__mlStat = { calls: 0, ms: 0 };
    const orig = ML.content;
    ML.content = function (...a) { const t = performance.now(); try { return orig.apply(this, a); } finally { __mlStat.calls++; __mlStat.ms += performance.now() - t; } };
    const r = row.getBoundingClientRect();
    return { perCallUs: +perCallUs.toFixed(1), x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2), outY: r.top - 200 };
})()`);
if (!setup || setup.error) { console.log(JSON.stringify(setup)); process.exit(1); }
const N = 100;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: setup.x, y: setup.y });
    await sleep(30);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: setup.x, y: setup.outY });
    await sleep(30);
}
const stat = await ev("window.__mlStat");
console.log(JSON.stringify({ contentCallUs: setup.perCallUs, hovers: N, renders: stat.calls, contentMsTotal: +stat.ms.toFixed(1), perHoverUs: +(stat.ms / N * 1000).toFixed(1), wallMs: Math.round(performance.now() - t0) }));
ws.close();
