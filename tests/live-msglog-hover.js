// MessageLogger: re-render cost of a message with edit history. Hovers it in
// and out 200 times and times it. On first run it SENDS one message in the
// server you own with "test" in its name (its "test" text channel) and edits it 10 times (kept for
// repeated A/B runs); tests/live-msglog-hover-cleanup.js deletes it.
//   CORVID_JS_DIR=<js dir parent> corvid --smoke-js=tests/live-msglog-hover.js
const TAG = "msglog perf edit-history";
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], wp = c.webpack;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = performance.now();
while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 30000) await sleep(100);
await sleep(2000);
const me = c.stores.UserStore.getCurrentUser();
const guild = (() => { const mine = Object.values(c.stores.GuildStore.getGuilds()).filter(g => g.ownerId === c.stores.UserStore.getCurrentUser().id && /test/i.test(g.name)); return mine.length === 1 ? mine[0] : null; })();
if (!guild || guild.ownerId !== me.id) return JSON.stringify({ error: "need exactly one server you own with \"test\" in its name" });
const ch = c.stores.GuildChannelStore.getChannels(guild.id).SELECTABLE.map(x => x.channel).find(x => /test/i.test(x.name) && x.type === 0);
if (!ch) return JSON.stringify({ error: "no text channel with \"test\" in its name" });
const navMod = wp.findModuleByCode("transitionTo - Transitioning to");
Object.values(navMod).find(f => typeof f === "function" && String(f).includes("Transitioning to"))(`/channels/${guild.id}/${ch.id}`);
await sleep(4000);
const MA = wp.findByProps("sendMessage", "editMessage", "deleteMessage");
const find = () => c.stores.MessageStore.getMessages(ch.id).toArray().find(m => m.content.startsWith(TAG) && m.author.id === me.id);
let m = find();
if (!m) {
    await MA.sendMessage(ch.id, { content: `${TAG} v0 **bold** <@${me.id}> :) https://example.com`, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
    for (let i = 0; i < 30 && !(m = find())?.id?.match(/^\d+$/); i++) await sleep(300);
    for (let v = 1; v <= 10; v++) {
        await sleep(2200);
        await MA.editMessage(ch.id, m.id, { content: `${TAG} v${v} **bold** <@${me.id}> _it_ \`code\` https://example.com` });
    }
    await sleep(2500);
    m = find();
}
const edits = m.corvidLog?.edits?.length ?? 0;
const row = () => document.getElementById(`chat-messages-${ch.id}-${m.id}`);
if (!row()) return JSON.stringify({ error: "row not rendered", edits });
row().scrollIntoView({ block: "center" });
await sleep(500);
// warmup
for (let i = 0; i < 20; i++) { row().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); row().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })); }
const times = [];
for (let r = 0; r < 5; r++) {
    const t = performance.now();
    for (let i = 0; i < 200; i++) {
        row().dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        row().dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    }
    times.push(performance.now() - t);
    await sleep(200);
}
times.sort((a, b) => a - b);
return JSON.stringify({ edits, renderedEdits: row().querySelectorAll(".corvid-ml-edit").length, ms200: times.map(x => +x.toFixed(1)), median: +times[2].toFixed(1) });
