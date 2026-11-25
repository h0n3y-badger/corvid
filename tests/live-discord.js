// Read-only checks inside the real Discord client (sends nothing):
//   corvid --smoke-js=tests/live-discord.js
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k];
const t0 = performance.now();
while (!(c._internal.ready && c.stores.UserStore?.getCurrentUser?.()) && performance.now() - t0 < 30000)
    await new Promise(r => setTimeout(r, 100));
const out = { readyMs: Math.round(performance.now()), ready: c._internal.ready, stats: c._internal.stats };
out.loggedIn = !!c.stores.UserStore?.getCurrentUser?.();
out.stores = Object.fromEntries(["EmojiStore", "StickersStore", "PermissionStore", "ChannelStore", "GuildMemberStore",
    "UserSettingsProtoStore", "OverridePremiumTypeStore", "SelectedChannelStore"].map(n => [n, !!c.stores[n]]));
const MA = c.webpack.findByProps("sendMessage", "editMessage");
const d = MA && Object.getOwnPropertyDescriptor(MA, "sendMessage");
out.messageActions = MA ? { writable: !!(d?.writable || d?.set), hooked: String(MA.sendMessage).includes("preSend") } : null;
out.patches = c._internal.patches.map(p => ({ plugin: p.plugin, hits: p.hits, failed: p.failed,
    noEffect: p.reps.filter(r => !r.applied).map(r => String(r.match).slice(0, 60)) }))
    .filter(p => p.hits !== 1 || p.failed || p.noEffect.length);
out.plugins = Object.values(c.plugins).map(p => p.name + (p.started ? "" : p.enabled ? "(not started)" : "(off)"));
out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
return JSON.stringify(out);
