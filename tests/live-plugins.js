// Read-only plugin checks inside the real Discord client (sends nothing):
//   corvid --smoke-js=tests/live-plugins.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], wp = c.webpack;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = performance.now();
while (!document.querySelector('[data-list-id="guildsnav"]') && performance.now() - t0 < 30000) await sleep(50);
await sleep(1500);
const out = {};
out.started = Object.values(c.plugins).map(p => p.name + (p.started ? "" : p.enabled ? "(NOT STARTED)" : "(off)"));
out.patchProblems = c._internal.patches.filter(p => !p.hits || p.failed || p.reps.some(r => !r.applied && !r.predicate))
    .map(p => `${p.plugin}: ${String(p.src).slice(0, 50)} hits=${p.hits} failed=${p.failed}`);
out.finds = {
    iconUtils: !!wp.findByProps("getGuildBannerURL", "getUserAvatarURL", "getEmojiURL"),
    permBits: !!wp.find(m => typeof m.ADMINISTRATOR === "bigint"),
    getUserIsAdmin: !!wp.findByCode(".getUserIsAdmin("),
    readerFactory: !!wp.findByProps("readerFactory"),
    startTyping: !!wp.findByProps("startTyping", "stopTyping"),
    getUploadPayload: !!wp.findByProps("getUploadPayload"),
    analytics: !!wp.findByProps("AnalyticsActionHandlers", "analyticsTrackingStoreMaker"),
};
out.sendHooked = String(wp.findByProps("sendMessage", "editMessage").sendMessage).includes("preSend");
out.sentryClient = typeof window.DiscordSentry?.getClient?.();
out.imageDecoder = typeof ImageDecoder, out.offscreen = typeof OffscreenCanvas;
// Emoji gate: would Discord let us use an emoji from a server we don't share with this channel?
const ES = c.stores.EmojiStore;
out.emojiBypassPatched = c._internal.patches.some(p => p.plugin === "FakeNitro" && String(p.src).includes("GUILD_SUBSCRIPTION_UNAVAILABLE") && p.hits);
out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
return JSON.stringify(out);
