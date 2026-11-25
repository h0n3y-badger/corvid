// FakeNitro transforms, run on objects only: nothing is sent.
//   corvid --smoke-js=tests/live-fakenitro.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], S = c.stores, p = c.plugins.FakeNitro;
const sleep = ms => new Promise(r => setTimeout(r, ms));
while (!document.querySelector('[data-list-id="guildsnav"]')) await sleep(50);
await sleep(2000);
const out = { premiumType: S.UserStore.getCurrentUser()?.premiumType ?? 0 };
const guilds = Object.values(S.GuildStore.getGuilds());
// an emoji from guild A (animated if possible), a text channel in guild B
let emoji, animated;
for (const g of guilds) {
    const list = S.EmojiStore.getGuildEmoji(g.id) ?? [];
    animated ??= list.find(e => e.animated);
    emoji ??= list.find(e => !e.animated);
}
const target = guilds.find(g => g.id !== emoji?.guildId && g.id !== animated?.guildId);
const gchans = target && (S.ChannelStore.getMutableGuildChannelsForGuild?.(target.id) ?? {});
const chan = gchans && Object.values(gchans).find(ch => ch.type === 0);
out.have = { emoji: !!emoji, animated: !!animated, channel: !!chan };
for (const [label, e] of [["static", emoji], ["animated", animated]]) {
    if (!e || !chan) continue;
    const msg = { content: `hi <${e.animated ? "a" : ""}:${e.name}:${e.id}>`, validNonShortcutEmojis: [e], invalidEmojis: [], tts: false };
    const r = await p.onPreSend(chan.id, msg, {});
    out[label] = { cancel: !!r?.cancel, content: msg.content.replace(/\d{6,}/g, "<id>") };
}
// a guild sticker from another server
let sticker;
for (const g of guilds) {
    sticker = (S.StickersStore.getStickersByGuildId?.(g.id) ?? []).find(s => s.format_type === 1 && g.id !== target?.id);
    if (sticker) break;
}
if (sticker && chan) {
    const msg = { content: "", validNonShortcutEmojis: [], invalidEmojis: [] };
    const r = await p.onPreSend(chan.id, msg, { stickerIds: [sticker.id] });
    out.sticker = { cancel: !!r?.cancel, content: msg.content.replace(/\d{6,}/g, "<id>") };
}
return JSON.stringify(out);
