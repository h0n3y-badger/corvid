// MessageLogger: how long LOAD_MESSAGES_SUCCESS is held for the host's
// msglog.page round trip. Read-only: refetches the "test" text channel of a server you own with "test" in its name
// a few times (no sends).
//   CORVID_JS_DIR=$PWD/js corvid --smoke-js=tests/live-msglog-hold.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], wp = c.webpack;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = performance.now();
while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 30000) await sleep(100);
await sleep(3000);
const ML = c.plugins.MessageLogger;
const guild = (() => { const mine = Object.values(c.stores.GuildStore.getGuilds()).filter(g => g.ownerId === c.stores.UserStore.getCurrentUser().id && /test/i.test(g.name)); return mine.length === 1 ? mine[0] : null; })();
if (!guild) return JSON.stringify({ error: "need exactly one server you own with \"test\" in its name" });
const ch = c.stores.GuildChannelStore.getChannels(guild.id).SELECTABLE.map(x => x.channel).find(x => /test/i.test(x.name) && x.type === 0);
if (!ch) return JSON.stringify({ error: "no text channel with \"test\" in its name" });
const holds = [], hostMs = [];
const origHold = ML.holdPage, origHost = ML.host;
const started = new Map();
ML.holdPage = function (a) { started.set(a, performance.now()); return origHold.call(this, a); };
ML.host = function (cmd, args) {
    const t = performance.now();
    const r = origHost.call(this, cmd, args);
    if (cmd === "page") r.then(() => hostMs.push(performance.now() - t));
    return r;
};
const flux = c.flux, origDispatch = flux.dispatch;
flux.dispatch = function (a) {
    if (a?.corvidML && started.has(a)) holds.push(performance.now() - started.get(a));
    return origDispatch.apply(this, arguments);
};
const MA = wp.findByProps("fetchMessages", "sendMessage");
for (let i = 0; i < 10; i++) {
    await MA.fetchMessages({ channelId: ch.id, limit: 50 });
    await sleep(700);
}
flux.dispatch = origDispatch; ML.holdPage = origHold; ML.host = origHost;
const st = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? { n: s.length, median: +s[s.length >> 1].toFixed(2), max: +s[s.length - 1].toFixed(2) } : null; };
return JSON.stringify({ held: st(holds), hostRoundTrip: st(hostMs), pageSize: c.stores.MessageStore.getMessages(ch.id).length });
