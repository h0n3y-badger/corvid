// Deletes the "msglog perf edit-history" test message (tests/live-msglog-hover.js)
// from a server you own with "test" in its name (its "test" text channel) and removes its log entry.
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
const ML = c.plugins.MessageLogger;
const mine = c.stores.MessageStore.getMessages(ch.id).toArray().filter(m => m.content.startsWith(TAG) && m.author.id === me.id);
const done = [];
for (const m of mine) {
    if (!ML.isDeleted(m)) { await MA.deleteMessage(ch.id, m.id); await sleep(2500); }
    ML.removeHistory(ch.id, m.id);
    done.push(m.id);
    await sleep(500);
}
await sleep(1500);
const left = c.stores.MessageStore.getMessages(ch.id).toArray().filter(m => m.content.startsWith(TAG)).length;
return JSON.stringify({ removed: done.length, left });
