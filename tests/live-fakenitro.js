// Read-only FakeNitro checks inside the real Discord client. Sends nothing:
// onPreSend is only called on hand-built objects, the APNG sticker is only
// downloaded and converted (never uploaded), no dialog is opened.
//   CORVID_JS_DIR=$PWD/js corvid --new-instance --smoke-js=tests/live-fakenitro.js
// SPDX-License-Identifier: MIT
const k = Object.getOwnPropertyNames(window).find(n => n.startsWith("__cv"));
const c = window[k], wp = c.webpack, st = c.stores;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = performance.now();
while (!(c._internal.ready && st.UserStore?.getCurrentUser?.() && document.querySelector('[data-list-id="guildsnav"]')) && performance.now() - t0 < 30000) await sleep(100);
await sleep(1500);
const out = {};
const FN = c.plugins.FakeNitro;
out.started = !!FN?.started;
out.patches = c._internal.patches.filter(p => p.plugin === "FakeNitro")
    .map(p => `${String(p.src).slice(0, 40)} hits=${p.hits} failed=${p.failed} applied=${p.reps.map(r => r.applied).join("/")}`);
const me = st.UserStore.getCurrentUser();
out.premiumType = me?.premiumType ?? 0;
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => "TIMEOUT (dialog?)")]);
const Perms = wp.find(m => typeof m.ADMINISTRATOR === "bigint");
const can = (perm, ch) => !ch.guild_id || st.PermissionStore.can(Perms[perm], ch);

// Guild A: has a static and an animated emoji. Guild B: another guild with a text channel we can embed in.
const guildIds = Object.keys(st.GuildStore.getGuilds());
let A = null, sEmoji = null, aEmoji = null;
for (const g of guildIds) {
    const emojis = st.EmojiStore.getGuildEmoji(g) ?? [];
    const s = emojis.find(e => !e.animated && e.available !== false), a = emojis.find(e => e.animated && e.available !== false);
    if (s && a) { A = g; sEmoji = s; aEmoji = a; break; }
}
let B = null;
for (const g of guildIds) {
    if (g === A) continue;
    const chans = st.GuildChannelStore?.getChannels?.(g)?.SELECTABLE?.map(x => x.channel) ?? [];
    const ch = chans.find(ch => ch.type === 0 && can("VIEW_CHANNEL", ch) && can("EMBED_LINKS", ch));
    if (ch) { B = ch; break; }
}
out.picked = { guildA: !!A, staticEmoji: sEmoji?.name, animatedEmoji: aEmoji?.name, channelB: B ? `#${B.name}` : null,
    useExternalEmojisInB: B ? can("USE_EXTERNAL_EMOJIS", B) : null };

// Emoji gate patch: CHAT is unlocked, REACTION follows Discord's rules.
const EU = wp.findByProps("getEmojiUnavailableReason", "isEmojiFiltered");
const Intent = wp.find(m => m.EmojiIntention?.CHAT === 3)?.EmojiIntention;
if (EU && Intent && sEmoji && B) {
    out.gate = {
        chat: EU.getEmojiUnavailableReason({ emoji: aEmoji, channel: B, intention: Intent.CHAT }),
        reaction: EU.getEmojiUnavailableReason({ emoji: aEmoji, channel: B, intention: Intent.REACTION }),
        status: EU.getEmojiUnavailableReason({ emoji: aEmoji, channel: null, intention: Intent.STATUS }),
        voiceStampChat: EU.getEmojiUnavailableReason({ emoji: aEmoji, channel: FN.noBypassChannel(B), intention: Intent.CHAT }),
    };
}

if (sEmoji && B) {
    const msg = { content: `hi <:${sEmoji.name}:${sEmoji.id}>and<a:${aEmoji.name}:${aEmoji.id}> \\<:${sEmoji.name}:${sEmoji.id}>`,
        validNonShortcutEmojis: [sEmoji, aEmoji], invalidEmojis: [], tts: false };
    const options = {};
    const r = await withTimeout(FN.onPreSend(B.id, msg, options), 5000);
    out.emojiSend = { result: r, content: msg.content };
    const edit = { content: `edit <a:${aEmoji.name}:${aEmoji.id}>` };
    await FN.onPreEdit(B.id, "0", edit);
    out.emojiEdit = edit.content;
}

// A PNG guild sticker from a guild other than B's.
const all = st.StickersStore.getAllGuildStickers();
let png = null, apng = null;
for (const [g, list] of all) {
    for (const s of list) {
        if (!png && s.format_type === 1 && g !== B?.guild_id) png = s;
        if (!apng && s.format_type === 2) apng = s;
    }
}
const formats = {};
for (const [, list] of all) for (const s of list) formats[s.format_type] = (formats[s.format_type] ?? 0) + 1;
out.guildStickerFormats = formats;
let apngSource = apng ? "guild" : null;
if (!apng) {
    // No animated guild sticker: use one of Discord's own pack stickers (fetch only;
    // loading the pack list is the same GET the sticker picker does).
    if (!(st.StickersStore.getPremiumPacks?.() ?? []).length) {
        try { await wp.findByCode("STICKER_PACKS_FETCH_START")?.(); } catch (e) { out.packFetchError = String(e); }
    }
    for (const pack of st.StickersStore.getPremiumPacks?.() ?? []) {
        apng = pack.stickers?.find(s => s.format_type === 2);
        if (apng) { apngSource = "pack"; break; }
    }
}
out.apngSource = apngSource;
if (png && B) {
    const msg = { content: "", validNonShortcutEmojis: [], invalidEmojis: [], tts: false };
    const options = { stickerIds: [png.id] };
    const r = await withTimeout(FN.onPreSend(B.id, msg, options), 5000);
    out.stickerSend = { sticker: png.name, result: r, content: msg.content, stickerIds: options.stickerIds ?? null };
}

// Receive side: pure transforms on hand-built message objects.
if (sEmoji) {
    const url = `https://cdn.discordapp.com/emojis/${aEmoji.id}.gif?size=48&name=${aEmoji.name}&lossless=true`;
    const m1 = { content: `[${aEmoji.name}](${url})`, attachments: [], embeds: [] };
    const ast = FN.transformAst([{ type: "link", target: url, content: [{ type: "text", content: aEmoji.name }] }], m1);
    out.receiveEmoji = ast[0];
    out.receiveEmojiEmbedHidden = FN.hideEmbed({ url, type: "image" }, m1);
    const m2 = { content: `hello [${aEmoji.name}](${url})`, attachments: [], embeds: [] };
    out.compoundUntouched = FN.transformAst([{ type: "link", target: url, content: [] }], m2)[0].type;
    // Through Discord's own (patched) message parser, AST and React variants.
    try {
        const toAST = wp.findByCode("parseToAST", "toAST:!0");
        const render = wp.findByCode("parseInlineReply", ".parse,");
        const fake = { id: "0", channel_id: B?.id ?? "0", content: m1.content, type: 0, author: me, mentionChannels: [],
            embeds: [{ type: "image", url, image: { url } }], attachments: [] };
        const ast = toAST(fake, { hideSimpleEmbedContent: true, allowLinks: true }).content;
        out.discordParser = { ast: JSON.stringify(ast).slice(0, 200), reactOk: !!render(fake, { allowLinks: true }).content };
    } catch (e) { out.discordParser = { error: String(e) }; }
}
if (png) {
    const url = `https://media.discordapp.net/stickers/${png.id}.png?size=160&name=x&lossless=true`;
    const m = { content: url, attachments: [], embeds: [] };
    out.receiveSticker = { stickers: FN.addFakeStickers([], m), ast: FN.transformAst([{ type: "link", target: url, content: [] }], m) };
}
if (apng) {
    const m = { content: "", attachments: [{ id: "1", filename: `${apng.id}.gif` }, { id: "2", filename: "123.gif" }], embeds: [] };
    out.receiveGifAttachment = { stickers: FN.addFakeStickers([], m).map(s => s.name), keptAttachments: FN.filterAttachments(m.attachments, m).map(a => a.filename) };
}

// APNG -> GIF: download + convert only.
if (apng) {
    const url = `https://media.discordapp.net/stickers/${apng.id}.png?size=320`;
    const times = [];
    let gif;
    try {
        for (let i = 0; i < 3; i++) {
            const t = performance.now();
            gif = await FN.apngToGif(url, 160);
            times.push(Math.round(performance.now() - t));
        }
        const dec = new ImageDecoder({ data: gif, type: "image/gif" });
        await dec.tracks.ready; await dec.completed;
        const src = new ImageDecoder({ data: await (await fetch(url)).arrayBuffer(), type: "image/png" });
        await src.tracks.ready; await src.completed;
        const f0 = await dec.decode({ frameIndex: 0 });
        out.apng = { sticker: apng.name, msTotal: times, gifBytes: gif.length, gifFrames: dec.tracks.selectedTrack.frameCount,
            sourceFrames: src.tracks.selectedTrack.frameCount, size: `${f0.image.displayWidth}x${f0.image.displayHeight}`,
            firstDelayMs: f0.image.duration / 1000 };
        f0.image.close(); dec.close(); src.close();
        // Split timing: decode vs encode.
        const tools = FN._gifTools();
        const buf = await (await fetch(url)).arrayBuffer();
        let t = performance.now();
        const frames = await tools.decodeFrames(buf, "image/png", 160);
        const decodeMs = performance.now() - t;
        t = performance.now();
        tools.encode(frames, 160, 160);
        out.apng.split = { frames: frames.length, decodeMs: Math.round(decodeMs), encodeMs: Math.round(performance.now() - t) };
    } catch (e) { out.apng = { error: String(e) }; }
}

// Other unlocks (read-only calls).
const streamCheck = wp.findByCode('"canStreamWithSettings"');
out.streamCustom1080p60 = typeof streamCheck === "function" ? streamCheck(undefined, 1080, 60, me, 0, null) : "not found";
out.themes = { keepLocalGradient: FN.keepLocalGradient(), isPreview: st.ClientThemesBackgroundStore?.isPreview };
// Local-only gradient survives a settings sync and editor close (in-memory
// dispatches in this throwaway instance; reset afterwards; nothing is saved).
{
    const CT = st.ClientThemesBackgroundStore;
    const preset = wp.find(m => typeof m.MINT_APPLE === "number")?.MINT_APPLE;
    if (CT && preset != null && CT.isPreview && CT.gradientPreset == null) {
        const d = a => c.flux.dispatch(a);
        const cur = () => CT.gradientPreset?.id ?? null;
        await d({ type: "UPDATE_BACKGROUND_GRADIENT_PRESET", presetId: preset });
        const picked = cur();
        await d({ type: "UNSYNCED_USER_SETTINGS_UPDATE", settings: {} });
        const afterSync = cur();
        await d({ type: "CLIENT_THEMES_EDITOR_CLOSE" });
        const afterEditorClose = cur();
        await d({ type: "RESET_PREVIEW_CLIENT_THEME" });
        out.themes.gradient = { preset, picked, afterSync, afterEditorClose, afterReset: cur() };
    } else out.themes.gradient = "skipped (Nitro, or a gradient is already set)";
}
out.appIconUpsell = st.AppIconPersistedStoreState?.isUpsellPreview;
out.finders = {
    alerts: !!wp.find(m => typeof m.show === "function" && typeof m.confirm === "function" && typeof m.close === "function"),
    promptToUploadLoaded: typeof wp.findByCode("filesMetadata", "requireConfirm", ".getUploadCount(") === "function",
    uploadFlow: FN._uploadFlowFound(),
    roleSubCheck: typeof wp.findByCode(".getUserIsAdmin(", ".getUserSubscriptionRoles(") === "function",
};
return JSON.stringify(out, null, 1);
