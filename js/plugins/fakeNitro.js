// fakeNitro: use custom emojis and stickers anywhere by sending them as image
// links (APNG stickers as an uploaded GIF), show such links from other corvid
// users as real emojis/stickers again, and unlock a few client-side Nitro
// cosmetics (stream quality options, client themes, app icons, soundboard).
// SPDX-License-Identifier: MIT
//
// Hooks, all found in Discord's own web build (see tests/patch-check.mjs):
//   - getEmojiUnavailableReason({emoji, channel, intention, ...}): the single
//     emoji gate behind the picker, autocomplete and the send-time
//     invalidEmojis split. Custom emojis are let through for CHAT and
//     GUILD_STICKER_RELATED_EMOJI only.
//   - the sticker sendability function (SENDABLE / SENDABLE_WITH_PREMIUM /
//     NONSENDABLE / SENDABLE_WITH_BOOSTED_GUILD) and the sticker picker's
//     USE_EXTERNAL_EMOJIS category filter.
//   - corvid.messages.onPreSend / onPreEdit rewrite what is actually sent.
//   - the message markdown parser (its AST, before Discord's own post
//     processing), MessageAccessories' renderEmbeds / renderAttachments /
//     renderStickersAccessories, and the emoji / sticker popouts.
const SIZES = [16, 32, 48, 56, 64, 96, 128, 160, 256, 512, 1024];
const sizeOptions = SIZES.map(n => ({ label: String(n), value: n }));

// Sticker format_type values.
const F_PNG = 1, F_APNG = 2, F_LOTTIE = 3, F_GIF = 4;
// Discord's DraftType.ChannelMessage.
const DRAFT_CHANNEL_MESSAGE = 0;

const EMOJI_URL_RE = /^https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/emojis\/(\d+)\.(png|webp|gif|jpe?g|avif)(?:\?([^\s#]*))?/i;
const STICKER_URL_RE = /^https?:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/(\d+)\.(png|gif|webp|json)(?:\?([^\s#]*))?/i;
// Same, unanchored and global, for scanning message text.
const ANY_FAKE_RE = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(emojis|stickers)\/(\d+)\.(\w+)(?:\?[^\s<>()[\]]*)?/gi;

const S = () => corvid.plugins.FakeNitro.settings.store;
const NO_BYPASS = Symbol("corvid.fakeNitro.noBypass");
const noBypassChannels = new WeakMap();
const analysisCache = new WeakMap();

// ------------------------------------------------------------ discord lookups
const wp = corvid.webpack;
const lazyFind = fn => { let v; return () => v ?? (v = fn()); };
const Perms = lazyFind(() => wp.find(m => typeof m.ADMINISTRATOR === "bigint" && typeof m.EMBED_LINKS === "bigint"));
const Alerts = lazyFind(() => wp.find(m => typeof m.show === "function" && typeof m.confirm === "function" && typeof m.close === "function" && String(m.show).includes("confirmText")));
// Discord's role-subscription check: (emoji, currentGuildId) -> locked?
const roleSubLocked = lazyFind(() => wp.findByCode(".getUserIsAdmin(", ".getUserSubscriptionRoles("));
// Discord's "add files to the chat bar" flow (size/count checks, upload UI).
// It lives in the chat input's lazy chunk; when that isn't loaded, fall back
// to the attachment action creator it calls (same chat-bar upload UI, minus
// the size/count pre-checks).
const PROMPT_CODE = ["filesMetadata", "requireConfirm", ".getUploadCount("];
function uploadFlow() {
    let prompt = wp.findByCode(...PROMPT_CODE);
    if (typeof prompt !== "function") {
        const mod = wp.findModuleByCode(...PROMPT_CODE);
        if (mod) for (const k in mod) { try { if (typeof mod[k] === "function" && wp.filters.byCode(...PROMPT_CODE)(mod[k])) { prompt = mod[k]; break; } } catch {} }
    }
    if (typeof prompt === "function") return (file, channel) => prompt([file], channel, DRAFT_CHANNEL_MESSAGE);
    const actions = wp.findByProps("addFiles", "popFirstFile");
    if (typeof actions?.addFiles !== "function") return null;
    return async (file, channel) => actions.addFiles({
        channelId: channel.id, draftType: DRAFT_CHANNEL_MESSAGE,
        files: [{ file, platform: 1 /* WEB */, isThumbnail: false, compressionMetadata: { originalContentType: file.type, preCompressionSize: file.size } }],
    });
}

function currentUser() { return corvid.stores.UserStore?.getCurrentUser?.(); }

/** The real premium tier (ignores the developer "override premium type"). */
function realPremiumType() {
    const o = corvid.stores.OverridePremiumTypeStore;
    try {
        if (o && o.getPremiumTypeOverride?.() !== undefined) return o.getPremiumTypeActual?.() ?? 0;
    } catch {}
    return currentUser()?.premiumType ?? 0;
}
const hasEmojiPerks = () => realPremiumType() >= 1;
const hasStickerPerks = () => realPremiumType() > 1;

function getChannel(id) { return corvid.stores.ChannelStore?.getChannel?.(id); }

/** Permission check; DMs and group DMs have everything. */
function can(name, channel) {
    if (!channel || !channel.guild_id) return true;
    const bit = Perms()?.[name];
    const PS = corvid.stores.PermissionStore;
    if (bit == null || !PS?.can) return true;
    try { return !!PS.can(bit, channel); } catch { return true; }
}

function emojiById(id) {
    const ES = corvid.stores.EmojiStore;
    return ES?.getCustomEmojiById?.(id) ?? ES?.getUsableCustomEmojiById?.(id) ?? null;
}
function stickerById(id) { return corvid.stores.StickersStore?.getStickerById?.(id) ?? null; }

function canReallyUseEmoji(emoji, channel) {
    if (!emoji || emoji.id == null) return true;  // unicode
    if (emoji.available === false) return false;
    const guildId = channel?.guild_id ?? null;
    try { if (roleSubLocked()?.(emoji, guildId ?? undefined)) return false; } catch {}
    const sameGuild = guildId != null && emoji.guildId === guildId;
    let perks = hasEmojiPerks();
    if (!perks && emoji.managed && emoji.guildId && Array.isArray(emoji.roles) && emoji.roles.length) {
        const me = currentUser();
        const member = me && corvid.stores.GuildMemberStore?.getMember?.(emoji.guildId, me.id);
        perks = !!member?.roles?.some(r => emoji.roles.includes(r));
    }
    if (perks && (sameGuild || can("USE_EXTERNAL_EMOJIS", channel))) return true;
    return !emoji.animated && sameGuild;
}

function canReallyUseSticker(sticker, channel) {
    if (sticker.pack_id != null) return true;  // Discord's own packs: free for everyone
    if (sticker.available === false) return false;
    const guildId = channel?.guild_id ?? null;
    if (guildId != null && sticker.guild_id === guildId) return true;
    return hasStickerPerks() && can("USE_EXTERNAL_STICKERS", channel);
}

// ------------------------------------------------------------ link building
function cleanName(name) { return String(name ?? "").replace(/[[\]\\]/g, "").trim(); }

function linkText(url, name, masked) {
    if (!masked) return url;
    let text = String(S().hyperLinkText ?? "{{NAME}}").replaceAll("{{NAME}}", cleanName(name));
    text = text.replace(/[[\]]/g, "").trim() || cleanName(name) || "emoji";
    return `[${text}](${url})`;
}

function emojiUrl(emoji) {
    const ext = emoji.animated ? "gif" : "webp";
    const q = new URLSearchParams({ size: String(S().emojiSize), name: String(emoji.name ?? ""), lossless: "true" });
    return `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?${q}`;
}

function stickerUrl(sticker) {
    const ext = sticker.format_type === F_GIF ? "gif" : "png";
    const q = new URLSearchParams({ size: String(S().stickerSize), name: String(sticker.name ?? ""), lossless: "true" });
    return `https://media.discordapp.net/stickers/${sticker.id}.${ext}?${q}`;
}

/** Replace [start, end) of s with repl, padding with spaces where it would touch text. */
function spliceSpaced(s, start, end, repl) {
    const before = s.slice(0, start), after = s.slice(end);
    const padL = before.length && !/\s$/.test(before) ? " " : "";
    const padR = after.length && !/^\s/.test(after) ? " " : "";
    return before + padL + repl + padR + after;
}

/** Rewrite unusable custom emoji tokens in `content`. Returns [newContent, count]. */
function rewriteEmojis(content, channel, extra) {
    const known = new Map();
    for (const e of extra ?? []) if (e?.id != null) known.set(String(e.id), e);
    const re = /<(a?):(\w+):(\d+)>/g;
    let m;
    const masked = !!S().useEmojiHyperLinks;
    const parts = [];
    while ((m = re.exec(content))) {
        if (m.index > 0 && content[m.index - 1] === "\\") continue;
        const id = m[3];
        const emoji = known.get(id) ?? emojiById(id);
        if (!emoji) continue;
        if (canReallyUseEmoji(emoji, channel)) continue;
        const e = { id, name: emoji.name ?? m[2], animated: emoji.animated ?? m[1] === "a" };
        parts.push([m.index, m.index + m[0].length, linkText(emojiUrl(e), e.name, masked)]);
    }
    if (!parts.length) return [content, 0];
    // Splice right to left so earlier offsets stay valid; spacing looks at the final neighbours.
    let out = content;
    for (let i = parts.length - 1; i >= 0; i--) {
        const [s, e, r] = parts[i];
        out = spliceSpaced(out, s, e, r);
    }
    return [out, parts.length];
}

// ------------------------------------------------------------ received-message analysis
function isOnlyLink(content) {
    const c = content.trim();
    return /^\S+$/.test(c) || /^\[[^\]\n]*\]\(<?\S+?>?\)$/.test(c);
}

function queryParam(q, key) {
    if (!q) return null;
    try { return new URLSearchParams(q).get(key); } catch { return null; }
}

/** What to transform in a message: {emojis: Map id->info, stickers: [...], hideIds: Set, hideAttachments: Set}. */
function analyse(message) {
    if (!message || typeof message !== "object") return null;
    let a = analysisCache.get(message);
    if (a !== undefined) return a;
    a = null;
    try { a = computeAnalysis(message); } catch (e) { corvid.err("FakeNitro: analyse", e); }
    analysisCache.set(message, a);
    return a;
}

function computeAnalysis(message) {
    const s = S();
    const content = typeof message.content === "string" ? message.content : "";
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const res = { emojis: new Map(), stickers: [], hideIds: new Set(), hideAttachments: new Set() };
    const textAllowed = s.transformCompoundSentence || isOnlyLink(content);
    if (textAllowed && (s.transformEmojis || s.transformStickers) && content.includes("discordapp.")) {
        ANY_FAKE_RE.lastIndex = 0;
        for (const m of content.matchAll(ANY_FAKE_RE)) {
            const url = m[0];
            if (m[1].toLowerCase() === "emojis" && s.transformEmojis) {
                const mm = EMOJI_URL_RE.exec(url);
                if (!mm) continue;
                const id = mm[1];
                const known = emojiById(id);
                const name = known?.name ?? queryParam(mm[3], "name") ?? "FakeNitroEmoji";
                const animated = mm[2].toLowerCase() === "gif" || queryParam(mm[3], "animated") === "true";
                res.emojis.set(id, { id, name, animated });
                res.hideIds.add(id);
            } else if (m[1].toLowerCase() === "stickers" && s.transformStickers) {
                const mm = STICKER_URL_RE.exec(url);
                if (!mm || mm[2].toLowerCase() === "json") continue;
                const id = mm[1];
                if (res.stickers.some(x => x.id === id)) continue;
                const known = stickerById(id);
                const format = known?.format_type ?? (mm[2].toLowerCase() === "gif" ? F_GIF : F_PNG);
                res.stickers.push({ id, name: known?.name ?? queryParam(mm[3], "name") ?? "FakeNitro Sticker", format_type: format, fakeNitro: true });
                res.hideIds.add(id);
            }
        }
    }
    if (s.transformStickers && attachments.length && (s.transformCompoundSentence || content.trim() === "")) {
        for (const att of attachments) {
            const name = att?.filename ?? att?.title ?? "";
            const m = /^(\d{15,22})\.gif$/i.exec(name);
            if (!m) continue;
            const sticker = stickerById(m[1]);
            if (!sticker) continue;
            if (!res.stickers.some(x => x.id === sticker.id))
                res.stickers.push({ id: sticker.id, name: sticker.name, format_type: sticker.format_type, fakeNitro: true });
            res.hideAttachments.add(att.id);
        }
    }
    if (!res.emojis.size && !res.stickers.length && !res.hideAttachments.size) return null;
    return res;
}

/** Walk a markdown AST (array or node) and rewrite fake links in place. */
function rewriteAst(nodes, a) {
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node || typeof node !== "object") continue;
        if (node.type === "link" && typeof node.target === "string") {
            const em = EMOJI_URL_RE.exec(node.target);
            if (em && a.emojis.has(em[1])) {
                const info = a.emojis.get(em[1]);
                nodes[i] = {
                    type: "customEmoji", emojiId: info.id, name: `:${info.name}:`, animated: info.animated,
                    jumboable: false, fakeNitro: true,
                };
                continue;
            }
            const st = STICKER_URL_RE.exec(node.target);
            if (st && a.stickers.some(x => x.id === st[1])) {
                nodes.splice(i, 1);
                i--;
                continue;
            }
        }
        if (Array.isArray(node.content)) rewriteAst(node.content, a);
    }
}

// ------------------------------------------------------------ APNG -> GIF
// Built on first use only.
let gifTools = null;
function getGifTools() {
    return gifTools ??= makeGifTools();
}

function makeGifTools() {
    const TRANSPARENT = 255;  // palette index reserved for transparency

    /** Median-cut a 15-bit colour histogram down to <= 255 colours. */
    function buildPalette(hist, sumR, sumG, sumB) {
        const bins = [];
        for (let k = 0; k < 32768; k++) if (hist[k]) bins.push(k);
        const comp = (k, c) => c === 0 ? (k >> 10) & 31 : c === 1 ? (k >> 5) & 31 : k & 31;
        const boxes = [{ bins, count: bins.reduce((s, k) => s + hist[k], 0) }];
        const rangeOf = box => {
            let best = -1, axis = 0;
            for (let c = 0; c < 3; c++) {
                let lo = 31, hi = 0;
                for (const k of box.bins) { const v = comp(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
                if (hi - lo > best) { best = hi - lo; axis = c; }
            }
            return [best, axis];
        };
        while (boxes.length < 255) {
            // Split the box with the most pixels that can still be split.
            let pick = -1, pickScore = -1, pickAxis = 0;
            for (let i = 0; i < boxes.length; i++) {
                const b = boxes[i];
                if (b.bins.length < 2) continue;
                const [range, axis] = b.range ?? (b.range = rangeOf(b));
                if (range === 0) continue;
                const score = b.count * range;
                if (score > pickScore) { pickScore = score; pick = i; pickAxis = axis; }
            }
            if (pick < 0) break;
            const box = boxes[pick];
            box.bins.sort((x, y) => comp(x, pickAxis) - comp(y, pickAxis));
            const half = box.count / 2;
            let acc = 0, cut = 1;
            for (let i = 0; i < box.bins.length - 1; i++) {
                acc += hist[box.bins[i]];
                if (acc >= half) { cut = i + 1; break; }
                cut = i + 1;
            }
            const a = box.bins.slice(0, cut), b = box.bins.slice(cut);
            const cnt = arr => arr.reduce((s, k) => s + hist[k], 0);
            boxes.splice(pick, 1, { bins: a, count: cnt(a) }, { bins: b, count: cnt(b) });
        }
        const palette = new Uint8Array(256 * 3);
        boxes.forEach((box, i) => {
            let r = 0, g = 0, bl = 0, n = 0;
            for (const k of box.bins) { r += sumR[k]; g += sumG[k]; bl += sumB[k]; n += hist[k]; }
            palette[i * 3] = Math.round(r / n);
            palette[i * 3 + 1] = Math.round(g / n);
            palette[i * 3 + 2] = Math.round(bl / n);
        });
        return { palette, size: boxes.length };
    }

    function nearest(palette, size, r, g, b) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < size; i++) {
            const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
            const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
            if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
        }
        return best;
    }

    /** Growable byte buffer. */
    class Bytes {
        constructor(n = 65536) { this.buf = new Uint8Array(n); this.len = 0; }
        ensure(n) {
            if (this.len + n <= this.buf.length) return;
            let cap = this.buf.length * 2;
            while (cap < this.len + n) cap *= 2;
            const b = new Uint8Array(cap);
            b.set(this.buf.subarray(0, this.len));
            this.buf = b;
        }
        byte(v) { this.ensure(1); this.buf[this.len++] = v; }
        u16(v) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; }
        bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
        str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
        result() { return this.buf.slice(0, this.len); }
    }

    // LZW dictionary: key = prefix * 256 + byte; value = (generation << 12) | code.
    const dict = new Uint32Array(4096 * 256);
    let gen = 0;

    /** GIF-flavoured LZW of 8-bit indices, written as data sub-blocks. */
    function lzw(out, indices) {
        const MIN = 8, CLEAR = 256, EOI = 257;
        out.byte(MIN);
        const block = new Uint8Array(255);
        let blen = 0, acc = 0, nbits = 0;
        const flushBlock = () => { if (blen) { out.byte(blen); out.bytes(block.subarray(0, blen)); blen = 0; } };
        let size = MIN + 1;
        const emit = code => {
            acc |= code << nbits;
            nbits += size;
            while (nbits >= 8) {
                block[blen++] = acc & 255;
                if (blen === 255) flushBlock();
                acc >>>= 8;
                nbits -= 8;
            }
        };
        const reset = () => { gen = (gen + 1) & 0xfffff; if (gen === 0) { dict.fill(0); gen = 1; } };
        reset();
        let next = EOI + 1;
        emit(CLEAR);
        let prefix = indices[0];
        const stamp = gen << 12;
        let curStamp = stamp;
        for (let i = 1; i < indices.length; i++) {
            const k = indices[i];
            const key = prefix * 256 + k;
            const v = dict[key];
            if ((v & 0xfffff000) === curStamp && v !== 0) { prefix = v & 0xfff; continue; }
            emit(prefix);
            if (next === 4096) {
                emit(CLEAR);
                size = MIN + 1;
                next = EOI + 1;
                reset();
                curStamp = gen << 12;
            } else {
                if (next >= (1 << size)) size++;
                dict[key] = curStamp | next;
                next++;
            }
            prefix = k;
        }
        emit(prefix);
        emit(EOI);
        if (nbits > 0) { block[blen++] = acc & 255; if (blen === 255) flushBlock(); }
        flushBlock();
        out.byte(0);  // block terminator
    }

    /**
     * Encode RGBA frames ({data: Uint8ClampedArray, delayMs}) of w x h into an
     * animated GIF89a (global palette, transparency, loop forever).
     */
    function encode(frames, w, h) {
        const hist = new Uint32Array(32768), sumR = new Float64Array(32768), sumG = new Float64Array(32768), sumB = new Float64Array(32768);
        for (const f of frames) {
            const d = f.data;
            for (let p = 0; p < d.length; p += 4) {
                if (d[p + 3] < 128) continue;
                const k = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
                hist[k]++; sumR[k] += d[p]; sumG[k] += d[p + 1]; sumB[k] += d[p + 2];
            }
        }
        const { palette, size } = buildPalette(hist, sumR, sumG, sumB);
        const map = new Int16Array(32768).fill(-1);
        const out = new Bytes(w * h * frames.length / 2 + 1024);
        out.str("GIF89a");
        out.u16(w); out.u16(h);
        out.byte(0xf7);  // global colour table, 8 bits/channel, 256 entries
        out.byte(TRANSPARENT);  // background colour index
        out.byte(0);  // aspect ratio
        out.bytes(palette);
        // NETSCAPE2.0: loop forever
        out.byte(0x21); out.byte(0xff); out.byte(11); out.str("NETSCAPE2.0");
        out.byte(3); out.byte(1); out.u16(0); out.byte(0);
        const idx = new Uint8Array(w * h);
        for (const f of frames) {
            const d = f.data;
            for (let p = 0, i = 0; i < idx.length; p += 4, i++) {
                if (d[p + 3] < 128) { idx[i] = TRANSPARENT; continue; }
                const k = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
                let c = map[k];
                if (c < 0) c = map[k] = nearest(palette, size, sumR[k] / hist[k], sumG[k] / hist[k], sumB[k] / hist[k]);
                idx[i] = c;
            }
            const cs = Math.max(1, Math.round(f.delayMs / 10));
            // Graphic control extension: dispose to background, transparent index set.
            out.byte(0x21); out.byte(0xf9); out.byte(4);
            out.byte((2 << 2) | 1);
            out.u16(cs);
            out.byte(TRANSPARENT);
            out.byte(0);
            // Image descriptor: full frame, no local table, not interlaced.
            out.byte(0x2c); out.u16(0); out.u16(0); out.u16(w); out.u16(h); out.byte(0);
            lzw(out, idx);
        }
        out.byte(0x3b);
        return out.result();
    }

    /** Decode an animated image with ImageDecoder and fit every frame into size x size. */
    async function decodeFrames(buffer, type, size) {
        if (typeof ImageDecoder !== "function") throw new Error("ImageDecoder is not available");
        const dec = new ImageDecoder({ data: buffer, type });
        try {
            await dec.tracks.ready;
            const track = dec.tracks.selectedTrack;
            await dec.completed.catch(() => {});
            const count = Math.max(1, track?.frameCount ?? 1);
            const canvas = new OffscreenCanvas(size, size);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            const frames = [];
            for (let i = 0; i < count; i++) {
                const { image } = await dec.decode({ frameIndex: i });
                try {
                    const iw = image.displayWidth, ih = image.displayHeight;
                    const scale = Math.min(size / iw, size / ih);
                    const dw = Math.max(1, Math.round(iw * scale)), dh = Math.max(1, Math.round(ih * scale));
                    ctx.clearRect(0, 0, size, size);
                    ctx.drawImage(image, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
                    let ms = image.duration == null ? 100 : image.duration / 1000;
                    if (!(ms > 10)) ms = 100;
                    frames.push({ data: ctx.getImageData(0, 0, size, size).data, delayMs: ms });
                } finally { image.close(); }
            }
            return frames;
        } finally { dec.close(); }
    }

    return { encode, decodeFrames };
}

/** Download an APNG and return it as GIF bytes, size x size. */
async function apngToGif(url, size) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const tools = getGifTools();
    const frames = await tools.decodeFrames(buf, "image/png", size);
    return tools.encode(frames, size, size);
}

// ------------------------------------------------------------ dialogs
function alertBox(title, body) {
    try {
        const A = Alerts();
        if (A) { A.show({ title, body, confirmText: "OK" }); return; }
    } catch (e) { corvid.err("FakeNitro: alert", e); }
    corvid.warn("FakeNitro:", title, body);
}

/** Discord-styled confirm. Resolves true on confirm; false on cancel or dismiss; true if no dialog module. */
function confirmBox(title, body, confirmText, cancelText) {
    const A = Alerts();
    if (!A) return Promise.resolve(true);
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v); } };
        try {
            A.show({
                title, body, confirmText, cancelText,
                onConfirm: () => finish(true),
                onCancel: () => finish(false),
                onCloseCallback: () => finish(false),
            });
        } catch (e) { corvid.err("FakeNitro: confirm", e); finish(true); }
    });
}

// ------------------------------------------------------------ plugin
const plugin = corvid.definePlugin({
    name: "FakeNitro",
    description: "Send custom emojis and stickers anywhere as image links, see other corvid users' links as the real thing, and unlock client-side Nitro extras.",
    enabledByDefault: true,
    settings: {
        enableEmojiBypass: { type: "boolean", default: true, restartNeeded: true, description: "Let the emoji picker and autocomplete offer every custom emoji in chat, and send the ones you can't use as image links." },
        emojiSize: { type: "select", default: 48, options: sizeOptions, description: "Pixel size of emoji images you send as links." },
        transformEmojis: { type: "boolean", default: true, restartNeeded: true, description: "Show emoji links in received messages as inline emojis." },
        enableStickerBypass: { type: "boolean", default: true, restartNeeded: true, description: "Let you pick stickers from any server, and send the ones you can't use as image links (animated ones as an uploaded GIF)." },
        stickerSize: { type: "select", default: 160, options: sizeOptions, description: "Pixel size of sticker links and converted GIFs." },
        transformStickers: { type: "boolean", default: true, restartNeeded: true, description: "Show sticker links (and converted sticker GIFs) in received messages as stickers." },
        transformCompoundSentence: { type: "boolean", default: false, description: "Also transform emoji and sticker links in messages that contain other text." },
        enableStreamQualityBypass: { type: "boolean", default: true, restartNeeded: true, description: "Make every stream resolution and frame rate selectable." },
        useStickerHyperLinks: { type: "boolean", default: true, description: "Send stickers as a masked link [text](url) instead of a bare URL." },
        useEmojiHyperLinks: { type: "boolean", default: true, description: "Send emojis as a masked link [text](url) instead of a bare URL." },
        hyperLinkText: { type: "string", default: "{{NAME}}", description: "Text of masked links. {{NAME}} becomes the emoji or sticker name." },
        disableEmbedPermissionCheck: { type: "boolean", default: false, description: "Don't warn before sending links into channels where you can't embed them." },
    },

    patches: [
        // Emoji gate: custom emojis are usable for chat messages (and the
        // emoji tied to a guild sticker). Reactions, status etc. untouched.
        {
            find: "getEmojiUnavailableReason:",
            predicate: () => S().enableEmojiBypass,
            replacement: {
                match: /(if\(!\i\(\i\)\)return null;)(if\((\i)===(\i)\.EmojiIntention\.GUILD_PROFILE)/,
                replace: "$1if($self.unlockEmoji($3,$4.EmojiIntention,arguments[0]?.channel))return null;$2",
            },
        },
        // The emoji picker of the stream drawing ("stamp") tool in voice calls
        // uses the CHAT intention; tag its channel so the gate stays normal.
        {
            find: ['"stamp"', "pickerIntention:"],
            predicate: () => S().enableEmojiBypass,
            replacement: {
                match: /(onOpenPicker:\(\)=>\{\i\("stamp"\)[^]{0,200}?\{channel:)(\i)(,guildId:\i\?\?void 0,pickerIntention:\i\.EmojiIntention\.CHAT)/,
                replace: "$1$self.noBypassChannel($2)$3",
            },
        },
        // Sticker sendability: guild stickers are SENDABLE.
        {
            find: ["SENDABLE_WITH_BOOSTED_GUILD", "USE_EXTERNAL_STICKERS", "getSelfMember("],
            predicate: () => S().enableStickerBypass,
            replacement: {
                match: /function\((\i),\i,\i\)\{if\(null==\i\)return 2;(?=let \i=\i\.\i\.canUseCustomStickersEverywhere)/,
                replace: "$&if($self.stickerSendable($1))return 0;",
            },
        },
        // Sticker picker: don't drop other servers' sticker categories.
        {
            find: ".EMPTY_GUILD_UPSELL,id:",
            predicate: () => S().enableStickerBypass,
            all: true,
            noWarn: true,
            replacement: {
                match: /(\|\|\i\.\i\(\{permission:\i\.\i\.USE_EXTERNAL_EMOJIS,user:\i,context:\i\}\))(\|\|\(\i=\i\.filter\(\i=>\i\.id===\i\.getGuildId\(\)\)\))/,
                replace: "$1||$self.stickerBypassOn()$2",
            },
        },
        // Message markdown: see the raw AST before Discord's post-processing.
        {
            find: ["hasBailedAst:", "toAST:"],
            predicate: () => S().transformEmojis || S().transformStickers,
            replacement: {
                match: /\(\{ast:(\i),inline:(\i),hasBailedAst:(\i=\i\?\?!1),message:(\i),/,
                replace: "({ast:$self.transformAst($1,$4),inline:$2,hasBailedAst:$3,message:$4,",
            },
        },
        // Native-markdown experiment renders without that AST: fall back to
        // the classic renderer for messages we transform.
        {
            find: 'location:"MessageRenderedContent"',
            predicate: () => S().transformEmojis || S().transformStickers,
            replacement: {
                match: /let (\i)=(\i\((\i)\));return null!=\1\?\1\.content:(\i)\?/,
                replace: "let $1=$2;return null!=$1?$1.content:$4&&!$self.needsClassicRender($3)?",
            },
        },
        // MessageAccessories: hide embeds/attachments, add fake stickers.
        {
            find: "renderStickersAccessories(",
            predicate: () => S().transformEmojis || S().transformStickers,
            replacement: [
                {
                    match: /(renderEmbeds\((\i)\)\{.{0,200}?\.embeds\.map\(\((\i),\i\)=>\{let \i;if\()/,
                    replace: "$1$self.hideEmbed($3,$2)||",
                },
                {
                    match: /(renderAttachments\((\i)\)\{.{0,300}?\{attachments:(\i),flags:\i\}=\2;)/,
                    replace: "$1$3=$self.filterAttachments($3,$2);",
                },
                {
                    match: /(renderStickersAccessories\((\i)\)\{let (\i)=)(\(0,\i\.\i\)\(\2\))/,
                    replace: "$1$self.addFakeStickers($4,$2)",
                },
            ],
        },
        // Emoji popout: explain fake emojis.
        {
            find: '"message_emoji_details"',
            predicate: () => S().transformEmojis,
            replacement: {
                match: /(\{node:(\i),sourceType:[^]{0,3000}?,\i=)(\i)\.emojiDescription,/,
                replace: "$1$self.emojiPopoutNote($2,$3.emojiDescription),",
            },
        },
        // Sticker popout: explain fake stickers.
        {
            find: ["renderableSticker:", "renderStickersAccessories("],
            predicate: () => S().transformStickers,
            noWarn: true,
            replacement: {
                match: /(\{let\{renderableSticker:(\i),channel:\i,closePopout:\i,refreshPositionKey:\i\}=\i,\[\i,\i\]=\(0,\i\.\i\)\(\2,!0\);return )(.+?\(0,(\i)\.jsx\)\(\i\.Y0,\{\}\))\}/,
                replace: "$1$self.stickerPopout($2,$3,$4)}",
            },
        },
        // Stream quality: every preset passes the premium check.
        {
            find: '"canStreamWithSettings"',
            predicate: () => S().enableStreamQualityBypass,
            replacement: {
                match: /(function\(\i,\i,\i\)\{)(if\(null==\i\|\|null==\i\.quality&&null==\i\.guildPremiumTier\)return!0;)/,
                replace: "$1if($self.streamUnlocked())return!0;$2",
            },
        },
        // Client themes: keep a locally chosen gradient through editor close
        // and through Discord's settings sync; it is never saved server-side
        // because the store stays in "preview" mode for non-Nitro users.
        {
            find: 'displayName="ClientThemesBackgroundStore"',
            replacement: [
                {
                    match: /function (\i)\(\)\{(\i&&\(\i=\i\(\)\),\i=!1),(\i=!1)\}/,
                    replace: "function $1(){$self.keepLocalGradient()||($2),$3}",
                },
                {
                    match: /\{null!=(\i)&&\(\1=void 0\);return\}/,
                    replace: "{$self.keepLocalGradient()||null!=$1&&($1=void 0);return}",
                },
            ],
        },
        // Custom theme editor: show "Apply" without Nitro; applying keeps the
        // theme locally instead of saving it to Discord.
        {
            find: ["PREMIUM_WISHLIST_CUSTOM_THEMES_EDITOR", "customUserThemeSettings:{colors:"],
            replacement: [
                {
                    match: /\(0,\i\.L\)\(\i\.PremiumTypes\.TIER_2\)/g,
                    replace: "($&||$self.themesUnlocked())",
                },
                {
                    match: /await \(0,(\i\.\i)\)\((\{theme:\i\(\i\),customUserThemeSettings:\{colors:\i,gradientColorStops:\[\],gradientAngle:\i,baseMix:\i\}\})\)/,
                    replace: "await $self.applyCustomTheme(()=>(0,$1)($2))",
                },
            ],
        },
        // App icons.
        {
            find: 'displayName="AppIconPersistedStoreState"',
            replacement: {
                match: /(\i=!)(\i\.\i\.canUsePremiumAppIcons\()/,
                replace: "$1$self.themesUnlocked()&&!$2",
            },
        },
        {
            find: ['"APP_ICON_UPDATED",id:', ".isPremium"],
            replacement: {
                match: /(\i=\i\|\|!0===\i&&\i\.isPremium)/,
                replace: "$1&&!$self.themesUnlocked()",
            },
        },
        // Soundboard: sounds from every server are available.
        {
            find: 'displayName="SoundboardStore"',
            replacement: [
                {
                    match: /(GUILD_SOUNDBOARD_SOUNDS_UPDATE:function\(\i\)\{let\{guildId:\i,soundboardSounds:(\i)\}=\i;)/,
                    replace: "$1$self.markSoundsAvailable($2);",
                },
                {
                    match: /(SOUNDBOARD_SOUNDS_RECEIVED:function\(\i\)\{let\{updates:(\i)\}=\i;)/,
                    replace: "$1$2.forEach(u=>$self.markSoundsAvailable(u.sounds));",
                },
                {
                    match: /(function \i\(\i\)\{let\{sound:(\i)\}=\i),/,
                    replace: "$1;$self.markSoundsAvailable([$2]);let ",
                },
            ],
        },
    ],

    start() {
        this._unhook = [
            corvid.messages.onPreSend((c, m, o) => this.onPreSend(c, m, o)),
            corvid.messages.onPreEdit((c, id, m) => this.onPreEdit(c, id, m)),
        ];
    },
    stop() {
        for (const u of this._unhook ?? []) u();
        this._unhook = null;
    },

    // ---------------------------------------------------------------- patch helpers
    unlockEmoji(intention, Intention, channel) {
        try {
            if (!this.started || !S().enableEmojiBypass) return false;
            if (channel && channel[NO_BYPASS]) return false;
            return intention === Intention?.CHAT || intention === Intention?.GUILD_STICKER_RELATED_EMOJI;
        } catch { return false; }
    },
    noBypassChannel(channel) {
        try {
            if (!channel || typeof channel !== "object") return channel;
            let c = noBypassChannels.get(channel);
            if (!c) {
                c = Object.create(channel, { [NO_BYPASS]: { value: true } });
                noBypassChannels.set(channel, c);
            }
            return c;
        } catch { return channel; }
    },
    stickerBypassOn() { return !!(this.started && S().enableStickerBypass); },
    stickerSendable(sticker) {
        try { return this.stickerBypassOn() && sticker != null && sticker.guild_id != null && sticker.pack_id == null; }
        catch { return false; }
    },
    transformAst(ast, message) {
        try {
            if (!this.started) return ast;
            const a = analyse(message);
            if (!a || (!a.emojis.size && !a.stickers.length)) return ast;
            if (Array.isArray(ast)) { rewriteAst(ast, a); return ast; }
            const arr = [ast];
            rewriteAst(arr, a);
            return arr.length === 1 ? arr[0] : arr;
        } catch (e) { corvid.err("FakeNitro: transformAst", e); return ast; }
    },
    needsClassicRender(message) {
        try {
            if (!this.started) return false;
            const a = analyse(message);
            return !!a && (a.emojis.size > 0 || a.stickers.length > 0);
        } catch { return false; }
    },
    hideEmbed(embed, message) {
        try {
            if (!this.started) return false;
            const a = analyse(message);
            if (!a || !a.hideIds.size) return false;
            for (const u of [embed?.url, embed?.image?.url, embed?.thumbnail?.url]) {
                if (typeof u !== "string") continue;
                const m = EMOJI_URL_RE.exec(u) ?? STICKER_URL_RE.exec(u);
                if (m && a.hideIds.has(m[1])) return true;
            }
        } catch (e) { corvid.err("FakeNitro: hideEmbed", e); }
        return false;
    },
    filterAttachments(attachments, message) {
        try {
            if (!this.started) return attachments;
            const a = analyse(message);
            if (!a || !a.hideAttachments.size) return attachments;
            return attachments.filter(x => !a.hideAttachments.has(x.id));
        } catch (e) { corvid.err("FakeNitro: filterAttachments", e); return attachments; }
    },
    addFakeStickers(items, message) {
        try {
            if (!this.started) return items;
            const a = analyse(message);
            if (!a || !a.stickers.length) return items;
            const have = new Set((items ?? []).map(x => x.id));
            const extra = a.stickers.filter(x => !have.has(x.id));
            return extra.length ? [...(items ?? []), ...extra] : items;
        } catch (e) { corvid.err("FakeNitro: addFakeStickers", e); return items; }
    },
    emojiPopoutNote(node, description) {
        if (!node?.fakeNitro) return description;
        const note = "This is a FakeNitro emoji. It shows as an emoji only for corvid users; everyone else sees a link.";
        return description ? `${description} ${note}` : note;
    },
    stickerPopout(renderable, element, R) {
        try {
            if (!renderable?.fakeNitro || !R?.jsx) return element;
            const note = R.jsx("div", {
                style: {
                    marginTop: "8px", padding: "8px 12px", borderRadius: "8px", maxWidth: "260px",
                    background: "var(--background-floating, var(--background-surface-highest, #111214))",
                    color: "var(--text-default, var(--text-normal, #dbdee1))", fontSize: "13px", lineHeight: "18px",
                    border: "1px solid var(--border-subtle, transparent)",
                },
                children: "This is a FakeNitro sticker. It shows as a sticker only for corvid users; everyone else sees a link or a GIF.",
            });
            return R.jsxs("div", { children: [element, note] });
        } catch (e) { corvid.err("FakeNitro: stickerPopout", e); return element; }
    },
    streamUnlocked() { return !!(this.started && S().enableStreamQualityBypass); },
    themesUnlocked() { return !!this.started; },
    keepLocalGradient() {
        try { return !!this.started && !!corvid.stores.ClientThemesBackgroundStore?.isPreview; } catch { return false; }
    },
    async applyCustomTheme(save) {
        // Real Nitro users save as usual; everyone else keeps the editor's
        // draft, which Discord already renders, and nothing goes to the server.
        try {
            const U = corvid.webpack.findByProps("canUseClientThemes", "canStreamQuality");
            if (U?.canUseClientThemes?.(currentUser())) return await save();
        } catch (e) { corvid.err("FakeNitro: applyCustomTheme", e); }
    },
    markSoundsAvailable(sounds) {
        try {
            if (!this.started || !Array.isArray(sounds)) return;
            for (const s of sounds) if (s && typeof s === "object" && s.available === false) s.available = true;
        } catch {}
    },

    // ---------------------------------------------------------------- sending
    /** Mutates msg.content / options.stickerIds; resolves {cancel}. */
    async onPreSend(channelId, msg, options) {
        try {
            if (!msg || typeof msg !== "object") return { cancel: false };
            options ??= {};
            const s = S();
            const channel = getChannel(channelId);
            let faked = 0;

            if (s.enableStickerBypass && Array.isArray(options.stickerIds) && options.stickerIds.length) {
                const keep = [];
                for (const id of options.stickerIds) {
                    const sticker = stickerById(id);
                    if (!sticker || canReallyUseSticker(sticker, channel)) { keep.push(id); continue; }
                    if (sticker.format_type === F_LOTTIE) {
                        alertBox("Can't send this sticker", "Animated vector (Lottie) stickers can't be faked. Only Nitro users can send them here.");
                        return { cancel: true };
                    }
                    if (sticker.format_type === F_APNG) {
                        if (!can("ATTACH_FILES", channel)) {
                            alertBox("Can't send this sticker", "This animated sticker is sent as a GIF upload, and you can't attach files in this channel.");
                            return { cancel: true };
                        }
                        this.sendApngAsGif(sticker, channel ?? channelId);
                        return { cancel: true };
                    }
                    const link = linkText(stickerUrl(sticker), sticker.name, !!s.useStickerHyperLinks);
                    const c = String(msg.content ?? "");
                    msg.content = c.length ? spliceSpaced(c, c.length, c.length, link) : link;
                    faked++;
                }
                if (keep.length) options.stickerIds = keep;
                else delete options.stickerIds;
            }

            if (s.enableEmojiBypass && typeof msg.content === "string" && msg.content.includes("<")) {
                const [content, n] = rewriteEmojis(msg.content, channel, msg.validNonShortcutEmojis);
                if (n) {
                    msg.content = content;
                    faked += n;
                    if (Array.isArray(msg.validNonShortcutEmojis))
                        msg.validNonShortcutEmojis = msg.validNonShortcutEmojis.filter(e => e?.id == null || content.includes(`:${e.id}>`));
                }
            }

            if (faked && !s.disableEmbedPermissionCheck && !can("EMBED_LINKS", channel)) {
                const ok = await confirmBox(
                    "Links won't embed here",
                    "You can't embed links in this channel, so the emojis/stickers you're faking will show up as plain links. Send anyway?",
                    "Send anyway", "Cancel");
                if (!ok) return { cancel: true };
            }
        } catch (e) { corvid.err("FakeNitro: onPreSend", e); }
        return { cancel: false };
    },

    async onPreEdit(channelId, messageId, msg) {
        try {
            if (!msg || typeof msg.content !== "string" || !S().enableEmojiBypass) return { cancel: false };
            const [content, n] = rewriteEmojis(msg.content, getChannel(channelId));
            if (n) msg.content = content;
        } catch (e) { corvid.err("FakeNitro: onPreEdit", e); }
        return { cancel: false };
    },

    async sendApngAsGif(sticker, channel) {
        try {
            const size = Number(S().stickerSize) || 160;
            const url = `https://media.discordapp.net/stickers/${sticker.id}.png?size=${Math.min(1024, Math.max(160, size * 2))}`;
            const gif = await apngToGif(url, size);
            const ch = typeof channel === "string" ? getChannel(channel) : channel;
            if (!ch) throw new Error("unknown channel");
            const file = new File([gif], `${sticker.id}.gif`, { type: "image/gif" });
            const up = uploadFlow();
            if (!up) throw new Error("Discord's upload flow wasn't found");
            await up(file, ch);
        } catch (e) {
            corvid.err("FakeNitro: APNG sticker", e);
            alertBox("Couldn't send sticker", `Converting the animated sticker to a GIF failed: ${e?.message ?? e}`);
        }
    },

    // For tests: lookups and download + convert only, never uploads.
    _uploadFlowFound() { return typeof uploadFlow() === "function"; },
    apngToGif,
    _gifTools: getGifTools,
});
void plugin;
