// MessageLogger: exactly one "deleted" marker per deleted message, also after
// re-renders. SENDS messages: only in a server you own with "test" in its name (its "test" text channel)
// (ownership checked), and removes them + their log entries afterwards.
//   CORVID_JS_DIR=$PWD/js corvid --smoke-js=tests/live-msglog-marker.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], wp = c.webpack;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = performance.now();
while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 30000) await sleep(100);
await sleep(2000);
const ML = c.plugins.MessageLogger;
const me = c.stores.UserStore.getCurrentUser();
const guild = (() => { const mine = Object.values(c.stores.GuildStore.getGuilds()).filter(g => g.ownerId === c.stores.UserStore.getCurrentUser().id && /test/i.test(g.name)); return mine.length === 1 ? mine[0] : null; })();
if (!guild || guild.ownerId !== me.id) return JSON.stringify({ error: "need exactly one server you own with \"test\" in its name" });
const chans = c.stores.GuildChannelStore.getChannels(guild.id).SELECTABLE.map(x => x.channel);
const ch = chans.find(x => /test/i.test(x.name) && x.type === 0);
if (!ch) return JSON.stringify({ error: "no #testing" });
// Discord's router: the module that logs "transitionTo - Transitioning to".
const navMod = wp.findModuleByCode("transitionTo - Transitioning to");
const go = navMod && Object.values(navMod).find(f => typeof f === "function" && String(f).includes("Transitioning to"));
if (!go) return JSON.stringify({ error: "router transitionTo not found" });
go(`/channels/${guild.id}/${ch.id}`);
await sleep(3000);
const MA = wp.findByProps("sendMessage", "editMessage", "deleteMessage");
const send = async text => {
    const before = new Set(c.stores.MessageStore.getMessages(ch.id).toArray().map(m => m.id));
    await MA.sendMessage(ch.id, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
    for (let i = 0; i < 50; i++) {
        const m = c.stores.MessageStore.getMessages(ch.id).toArray().find(m => !before.has(m.id) && m.content === text && m.state === "SENT");
        if (m) return m.id;
        await sleep(200);
    }
    throw new Error("send timed out");
};
const count = id => {
    const row = document.getElementById(`chat-messages-${ch.id}-${id}`);
    return row ? row.querySelectorAll(".corvid-ml-marker").length : -1;
};
const out = {};
const a = await send("msglog marker test A");
await sleep(2500);
const b = await send("msglog marker test B (grouped)");
await sleep(2500);
await MA.deleteMessage(ch.id, a);
await sleep(2500);
await MA.deleteMessage(ch.id, b);
await sleep(2500);
out.afterDelete = { header: count(a), grouped: count(b) };
// Re-render a lot: hover in/out of both rows, toggle the style setting.
for (let i = 0; i < 15; i++) {
    for (const id of [a, b]) {
        const row = document.getElementById(`chat-messages-${ch.id}-${id}`);
        row?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await sleep(60);
        row?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    }
    ML.settings.store.deleteStyle = i % 2 ? "text" : "overlay";
    await sleep(100);
}
ML.settings.store.deleteStyle = "text";
await sleep(800);
out.afterRerender = { header: count(a), grouped: count(b) };
out.markerText = document.getElementById(`chat-messages-${ch.id}-${a}`)?.querySelector(".corvid-ml-marker")?.textContent;
// cleanup: the plugin's own "Remove message history"
ML.removeHistory(ch.id, a);
ML.removeHistory(ch.id, b);
await sleep(1500);
out.cleanedUp = count(a) === -1 && count(b) === -1;
out.pass = out.afterDelete.header === 1 && out.afterDelete.grouped === 1 && out.afterRerender.header === 1 && out.afterRerender.grouped === 1 && out.cleanedUp;
return JSON.stringify(out);
