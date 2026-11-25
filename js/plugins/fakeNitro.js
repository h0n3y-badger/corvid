/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * FakeNitro by Arjix, D3SOX, Ven, fawn, captain, Nuckyz, AutumnVN, sadan
 * (Equicord src/plugins/fakeNitro). Ported to corvid: plain JS on corvid's
 * plugin API, patches re-validated against the live build with
 * tests/patch-check.mjs, React modals replaced by Discord's Alerts, APNG
 * stickers decoded with the browser's ImageDecoder and encoded by a compact
 * GIF encoder adapted from gifenc (MIT, (c) 2017 Matt DesLauriers; LZW after
 * Kevin Weiner / Johan Nordberg; PNN quantizer after Mark Tyler, Dmitry
 * Groshev and Miller Cy Chan), built lazily on first use.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later (gifenc parts: MIT, see
 * LICENSES/gifenc-MIT.txt)
 */

const { stores, webpack } = corvid;
const { find, findByProps, findByCode, lazy } = webpack;

// EmojiIntentions: REACTION 0, STATUS 1, COMMUNITY_CONTENT 2, CHAT 3,
// GUILD_STICKER_RELATED_EMOJI 4, ...
const IS_BYPASSEABLE_INTENTION = "[3,4].includes(fakeNitroIntention)";
const StickerFormat = { PNG: 1, APNG: 2, LOTTIE: 3, GIF: 4 };
const FakeNotice = { Sticker: 0, Emoji: 1 };

const fakeNitroEmojiRegex = /\/emojis\/(\d+?)\.(png|webp|gif)/;
const fakeNitroStickerRegex = /\/stickers\/(\d+?)\./;
const fakeNitroGifStickerRegex = /\/attachments\/\d+?\/\d+?\/(\d+?)\.gif/;
const hyperLinkRegex = /\[.+?\]\((https?:\/\/.+?)\)/;
const hyperLinkOnlyRegex = new RegExp(`^${hyperLinkRegex.source}$`);
const mediaSizes = [16, 32, 48, 56, 64, 96, 128, 160, 256, 512, 1024];

// ------------------------------------------------------------ lazy finds
const getPermissionsBits = lazy(() => find(m => typeof m.ADMINISTRATOR === "bigint"));
const getIconUtils = lazy(() => findByProps("getGuildBannerURL", "getUserAvatarURL", "getEmojiURL"));
const getIsUnusableRoleSubscriptionEmoji = lazy(() => findByCode(".getUserIsAdmin("));
const getAlerts = lazy(() => findByProps("show", "close", "confirm") ?? findByProps("show", "close"));
const getPromptToUpload = lazy(() => findByCode("Unexpected mismatch between files and file metadata"));
const getDraftType = lazy(() => findByProps("ChannelMessage", "SlashCommand"));
const getBinaryReadOptions = lazy(() => findByProps("readerFactory"));
const getPreloadedUserSettings = lazy(() => find(m => m.ProtoClass?.typeName?.endsWith(".PreloadedUserSettings")));
function protoField(localName, protoClass) {
    const field = protoClass?.fields?.find(f => f.localName === localName);
    const getter = field && Object.values(field).find(v => typeof v === "function");
    return getter?.();
}
const getAppearanceProto = lazy(() => protoField("appearance", getPreloadedUserSettings()?.ProtoClass));
const getClientThemeProto = lazy(() => protoField("clientThemeSettings", getAppearanceProto()));

function alert(title, body, extra) {
    const A = getAlerts();
    if (A?.show) A.show({ title, body, confirmText: "OK", ...extra });
    else if (!extra) corvid.warn(`FakeNitro: ${title}: ${body}`);
    return !!A?.show;
}

function hasPermission(channelId, permName) {
    const channel = stores.ChannelStore?.getChannel(channelId);
    if (!channel || channel.isPrivate()) return true;
    const bit = getPermissionsBits()?.[permName];
    if (bit == null) return true;
    return stores.PermissionStore.can(bit, channel);
}
const hasExternalEmojiPerms = id => hasPermission(id, "USE_EXTERNAL_EMOJIS");
const hasExternalStickerPerms = id => hasPermission(id, "USE_EXTERNAL_STICKERS");
const hasEmbedPerms = id => hasPermission(id, "EMBED_LINKS");
const hasAttachmentPerms = id => hasPermission(id, "ATTACH_FILES");

const getWordBoundary = (s, i) => (!s[i] || /\s/.test(s[i])) ? "" : " ";

function confirmNoEmbed() {
    return new Promise(resolve => {
        const shown = alert("Hold on!",
            "You are trying to send/edit a message that contains a FakeNitro emoji or sticker, however you do not have permissions to embed links in the current channel. Are you sure you want to send this message? Your FakeNitro items will appear as a link only.",
            { confirmText: "Send Anyway", cancelText: "Cancel", onConfirm: () => resolve(true), onCancel: () => resolve(false), onCloseCallback: () => setTimeout(() => resolve(false)) });
        if (!shown) resolve(true);
    });
}

const premiumTypeActual = () => stores.OverridePremiumTypeStore?.getState?.()?.premiumTypeActual ?? 0;

// ------------------------------------------------------------ plugin
const p = corvid.definePlugin({
    name: "FakeNitro",
    enabledByDefault: true,
    description: "Send fake emojis/stickers from any server, use nitro themes and app icons, stream in nitro quality",
    settings: {
        enableEmojiBypass: { type: "boolean", default: true, restartNeeded: true, description: "Allow sending fake emojis (also bypasses missing permission to use custom emojis)" },
        emojiSize: { type: "select", default: 48, options: mediaSizes.map(s => ({ label: `${s}px`, value: s })), description: "Size of the emojis when sending" },
        transformEmojis: { type: "boolean", default: true, restartNeeded: true, description: "Render fake emoji links as real emojis" },
        enableStickerBypass: { type: "boolean", default: true, restartNeeded: true, description: "Allow sending fake stickers (also bypasses missing permission to use stickers)" },
        stickerSize: { type: "select", default: 160, options: mediaSizes.map(s => ({ label: `${s}px`, value: s })), description: "Size of the stickers when sending" },
        transformStickers: { type: "boolean", default: true, restartNeeded: true, description: "Render fake sticker links as real stickers" },
        transformCompoundSentence: { type: "boolean", default: false, description: "Also transform fake stickers/emojis in messages with more content than just the link" },
        enableStreamQualityBypass: { type: "boolean", default: true, restartNeeded: true, description: "Allow streaming in nitro quality" },
        useStickerHyperLinks: { type: "boolean", default: true, description: "Send fake stickers as hyperlinks" },
        useEmojiHyperLinks: { type: "boolean", default: true, description: "Send fake emojis as hyperlinks" },
        hyperLinkText: { type: "string", default: "{{NAME}}", description: "Hyperlink text; {{NAME}} is replaced with the emoji/sticker name" },
        disableEmbedPermissionCheck: { type: "boolean", default: false, description: "Don't warn when you can't embed links in the channel" },
    },

    patches: [
        {
            // Premium perk checks (ProductCatalog). Equicord patched the old
            // object-literal methods; they are now plain functions.
            find: '"ProductCatalog.tsx"',
            replacement: [
                { match: /(?<=function \i\(\i\)\{)(?=return \i\(\i\.\i\.STICKERS_EVERYWHERE,)/, replace: "return true;", predicate: () => s().enableStickerBypass },
                { match: /(?<=function \i\(\i\)\{)(?=return \i\(\i\.\i\.INCREASED_VIDEO_UPLOAD_QUALITY,)/, replace: "return true;", predicate: () => s().enableStreamQualityBypass },
                { match: /(?<=function \i\(\i,\i\)\{)(?=return"high"===\i\?)/, replace: "return true;", predicate: () => s().enableStreamQualityBypass },
                { match: /(?<=function \i\(\i\)\{)(?=return \i\(\i\.\i\.CLIENT_THEMES,)/, replace: "return true;" },
                { match: /(?<=function \i\(\i\)\{)(?=return \i\(\i\.\i\.APP_ICONS,)/, replace: "return true;" },
            ],
        },
        // The emoji picker in voice calls must not be bypassed by fake nitro
        {
            find: '.getByName("fork_and_knife")',
            predicate: () => s().enableEmojiBypass,
            replacement: { match: ".CHAT", replace: ".STATUS" },
        },
        {
            find: ".GUILD_SUBSCRIPTION_UNAVAILABLE;",
            predicate: () => s().enableEmojiBypass,
            replacement: [
                { match: /(?<=\.USE_EXTERNAL_EMOJIS.+?;)(?<=intention:(\i).+?)/, replace: (_, intention) => `const fakeNitroIntention=${intention};` },
                { match: /&&!\i&&!\i(?=\)return \i\.\i\.DISALLOW_EXTERNAL;)/, replace: m => `${m}&&!${IS_BYPASSEABLE_INTENTION}` },
                { match: /!\i\.available(?=\)return \i\.\i\.GUILD_SUBSCRIPTION_UNAVAILABLE;)/, replace: m => `${m}&&!${IS_BYPASSEABLE_INTENTION}` },
                { match: /(?<=!\(\i\|\|)\i\.\i\.canUseEmojisEverywhere\(\i\)/, replace: m => `(${m}||${IS_BYPASSEABLE_INTENTION})` },
                { match: /(?<=\|\|)\i\.\i\.canUseAnimatedEmojis\(\i\)/, replace: m => `(${m}||${IS_BYPASSEABLE_INTENTION})` },
            ],
        },
        // Allow subscription-locked emojis
        {
            find: ".getUserIsAdmin(",
            replacement: {
                match: /(function(?: \i)?\(\i,\i)\){(.{0,250}.getUserIsAdmin\(.+?return!1})/,
                replace: (_, rest1, rest2) => `${rest1},fakeNitroOriginal){if(!fakeNitroOriginal)return false;${rest2}`,
            },
        },
        // Stickers always available
        {
            find: '"SENDABLE"',
            predicate: () => s().enableStickerBypass,
            replacement: { match: /\i\.available\?/, replace: "true?" },
        },
        // No boost requirement for high quality streams
        {
            find: "#{intl::STREAM_FPS_OPTION}",
            predicate: () => s().enableStreamQualityBypass,
            replacement: { match: /guildPremiumTier:\i\.\i\.TIER_\d,?/g, replace: "" },
        },
        {
            find: '"UserSettingsProtoStore"',
            replacement: [
                { match: /(?<=CONNECTION_OPEN:function\((\i)\){)/, replace: (_, props) => `$self.handleProtoChange(${props}.userSettingsProto,${props}.user);` },
                { match: /let{settings:/, replace: "arguments[0].local||$self.handleProtoChange(arguments[0].settings.proto);$&" },
            ],
        },
        // Gradient theme selection without nitro
        {
            find: ",updateTheme(",
            replacement: {
                match: /(function(?: \i)?\(\i\){let{backgroundGradientPresetId:(\i).+?)(\i\.\i\.updateAsync.+?theme=(.+?),.+?},\i\))/,
                replace: (_, rest, presetId, originalCall, theme) => `${rest}$self.handleGradientThemeSelect(${presetId},${theme},()=>${originalCall});`,
            },
        },
        // Custom client themes editor
        {
            find: ".CLIENT_THEMES_EDITOR?",
            replacement: { match: /(?<=\i=)\(0,\i\.\i\)\(\i\.\i\.TIER_2\)(?=,|;)/g, replace: "true" },
        },
        {
            find: '["strong","em","u","text","inlineCode","s","spoiler"]',
            predicate: () => s().transformEmojis || s().transformStickers,
            replacement: { match: /\(\{ast:(\i)(?=,inline:\i)/, replace: "({ast:$self.transformAst($1)" },
        },
        {
            find: "}renderStickersAccessories(",
            replacement: [
                {
                    predicate: () => s().transformEmojis || s().transformStickers,
                    match: /(renderEmbeds\((\i)\){)(.+?embeds\.map\(\((\i),\i\)?=>{)/,
                    replace: (_, rest1, message, rest2, embed) => `${rest1}const fakeNitroMessage=${message};${rest2}if($self.shouldIgnoreEmbed(${embed},fakeNitroMessage))return null;`,
                },
                {
                    predicate: () => s().transformStickers,
                    match: /renderStickersAccessories\((\i)\){let (\i)=\(0,\i\.\i\)\(\i\).+?;/,
                    replace: (m, message, stickers) => `${m}${stickers}=$self.patchFakeNitroStickers(${stickers},${message});`,
                },
                {
                    predicate: () => s().transformStickers,
                    match: /renderAttachments\(\i\){.+?{attachments:(\i).+?;/,
                    replace: (m, attachments) => `${m}${attachments}=$self.filterAttachments(${attachments});`,
                },
            ],
        },
        {
            find: "#{intl::STICKER_POPOUT_UNJOINED_PRIVATE_GUILD_DESCRIPTION}",
            predicate: () => s().transformStickers,
            replacement: [
                { match: /let{renderableSticker:(\i).{0,270}sticker:\i,channel:\i,/, replace: (m, renderableSticker) => `${m}fakeNitroRenderableSticker:${renderableSticker},` },
                {
                    match: /(let \i,{sticker:\i,channel:\i,closePopout:\i.+?}=(\i).+?;)(.+?description:)(\i)(?=,sticker:\i)/,
                    replace: (_, rest, props, rest2, node) => `${rest}let{fakeNitroRenderableSticker}=${props};${rest2}$self.addFakeNotice(${FakeNotice.Sticker},${node},!!fakeNitroRenderableSticker?.fake)`,
                },
            ],
        },
        {
            find: ".EMOJI_UPSELL_POPOUT_MORE_EMOJIS_OPENED,",
            predicate: () => s().transformEmojis,
            replacement: { match: /isDiscoverable:\i,shouldHideRoleSubscriptionCTA:\i,(?<={node:(\i),.+?)/, replace: (m, node) => `${m}fakeNitroNode:${node},` },
        },
        {
            find: "#{intl::EMOJI_POPOUT_UNJOINED_DISCOVERABLE_GUILD_DESCRIPTION}",
            predicate: () => s().transformEmojis,
            replacement: {
                match: /(?<=emojiDescription:)(\i)(?<=\1=function\(\i\)\{let\{sourceType:.+?)/,
                replace: (_, node) => `$self.addFakeNotice(${FakeNotice.Emoji},${node},!!arguments[0]?.fakeNitroNode?.fake)`,
            },
        },
        // Custom app icons
        {
            find: ["getCurrentDesktopIcon(),", ".canKeepDesktopIconWithoutPremium("],
            replacement: { match: /\i\.\i\.isPremium\(\i\.\i\.getCurrentUser\(\)\)/, replace: "true" },
        },
        // All soundboard sounds available
        {
            find: 'type:"GUILD_SOUNDBOARD_SOUND_CREATE"',
            replacement: {
                match: /(?<=type:"(?:SOUNDBOARD_SOUNDS_RECEIVED|GUILD_SOUNDBOARD_SOUND_CREATE|GUILD_SOUNDBOARD_SOUND_UPDATE|GUILD_SOUNDBOARD_SOUNDS_UPDATE)".+?available:)\i\.available/g,
                replace: "true",
            },
        },
    ],

    get canUseEmotes() { return premiumTypeActual() > 0; },
    get canUseStickers() { return premiumTypeActual() > 1; },

    handleProtoChange(proto) {
        try {
            if (proto == null || typeof proto === "string") return;
            if (premiumTypeActual() === 2) return;
            const Appearance = getAppearanceProto();
            if (!Appearance) return;
            proto.appearance ??= Appearance.create();
            const current = stores.UserSettingsProtoStore?.settings?.appearance;
            proto.appearance = Appearance.create({
                ...proto.appearance,
                theme: current?.theme,
                clientThemeSettings: current?.clientThemeSettings,
            });
        } catch (e) { corvid.err("FakeNitro handleProtoChange", e); }
    },

    handleGradientThemeSelect(backgroundGradientPresetId, theme, original) {
        if (premiumTypeActual() === 2 || backgroundGradientPresetId == null) return original();
        const Preloaded = getPreloadedUserSettings(), Appearance = getAppearanceProto(), ClientTheme = getClientThemeProto(), readOpts = getBinaryReadOptions();
        if (!Preloaded || !Appearance || !ClientTheme || !readOpts) return original();

        const currentAppearance = Preloaded.getCurrentValue().appearance;
        const appearance = currentAppearance != null
            ? Appearance.fromBinary(Appearance.toBinary(currentAppearance), readOpts)
            : Appearance.create();
        appearance.theme = theme;
        const dummy = ClientTheme.create({ backgroundGradientPresetId: { value: backgroundGradientPresetId } });
        appearance.clientThemeSettings ??= dummy;
        appearance.clientThemeSettings.backgroundGradientPresetId = dummy.backgroundGradientPresetId;

        const proto = Preloaded.ProtoClass.create();
        proto.appearance = appearance;
        corvid.flux.dispatch({ type: "USER_SETTINGS_PROTO_UPDATE", local: true, partial: true, settings: { type: 1, proto } });
    },

    transformAst(ast) {
        try {
            const st = s();
            if (!st.transformCompoundSentence && ast.length > 1) return ast;
            // Sticker links become real stickers later; drop the duplicate link.
            if (st.transformStickers) {
                ast = ast.filter(node => {
                    if (node.type !== "link") return true;
                    if (fakeNitroStickerRegex.test(node.target)) return false;
                    const gif = node.target.match(fakeNitroGifStickerRegex);
                    return !(gif && stores.StickersStore.getStickerById(gif[1]));
                });
            }
            if (st.transformEmojis) {
                ast = ast.map(node => {
                    if (node.type !== "link") return node;
                    const m = node.target.match(fakeNitroEmojiRegex);
                    if (!m) return node;
                    let url = null;
                    try { url = new URL(node.target); } catch {}
                    const name = stores.EmojiStore.getCustomEmojiById(m[1])?.name ?? url?.searchParams.get("name") ?? "FakeNitroEmoji";
                    return {
                        animated: m[2] === "gif" || url?.searchParams.get("animated") === "true",
                        emojiId: m[1],
                        name: `:${name}:`,
                        type: "customEmoji",
                        fake: true,
                    };
                });
            }
        } catch (e) { corvid.err("FakeNitro transformAst", e); }
        return ast;
    },

    patchFakeNitroStickers(stickers, message) {
        const st = s();
        stickers = [...stickers]; // may be the message's own stickerItems array
        const items = [];
        const words = message.content.split(/\s/);
        if (st.transformCompoundSentence) items.push(...words);
        else if (words.length === 1) items.push(words[0]);
        else if (hyperLinkOnlyRegex.test(message.content)) items.push(message.content);
        items.push(...message.attachments.filter(a => a.content_type === "image/gif").map(a => a.url));

        for (const item of items) {
            if (!st.transformCompoundSentence && !item.startsWith("http") && !hyperLinkRegex.test(item)) continue;
            const img = item.match(fakeNitroStickerRegex);
            if (img) {
                let url = null;
                try { url = new URL(item); } catch {}
                const name = stores.StickersStore.getStickerById(img[1])?.name ?? url?.searchParams.get("name") ?? "FakeNitroSticker";
                stickers.push({ format_type: 1, id: img[1], name, fake: true });
                continue;
            }
            const gif = item.match(fakeNitroGifStickerRegex);
            if (gif) {
                const sticker = stores.StickersStore.getStickerById(gif[1]);
                if (!sticker) continue;
                stickers.push({ format_type: 2, id: gif[1], name: sticker.name ?? "FakeNitroSticker", fake: true });
            }
        }
        return stickers;
    },

    shouldIgnoreEmbed(embed, message) {
        try {
            const st = s();
            const words = message.content.split(/\s/);
            if (words.length > 1 && !st.transformCompoundSentence && !hyperLinkOnlyRegex.test(message.content)) return false;
            if (embed.type !== "image") return false;
            const url = embed.url ?? embed.image?.url;
            if (!url) return false;
            if (!st.transformCompoundSentence
                && !words.some(w => w === url || w.match(hyperLinkRegex)?.[1] === url)
                && !hyperLinkOnlyRegex.test(message.content)) return false;
            if (st.transformEmojis && fakeNitroEmojiRegex.test(url)) return true;
            if (st.transformStickers) {
                if (fakeNitroStickerRegex.test(url)) return true;
                // A gif attachment is only a fake sticker if its id is a known sticker.
                const gif = url.match(fakeNitroGifStickerRegex);
                if (gif && stores.StickersStore.getStickerById(gif[1])) return true;
            }
        } catch (e) { corvid.err("FakeNitro shouldIgnoreEmbed", e); }
        return false;
    },

    filterAttachments(attachments) {
        return attachments.filter(a => {
            if (a.content_type !== "image/gif") return true;
            const m = a.url.match(fakeNitroGifStickerRegex);
            return !(m && stores.StickersStore.getStickerById(m[1]));
        });
    },

    addFakeNotice(type, node, fake) {
        if (!fake) return node;
        node = Array.isArray(node) ? node : [node];
        node.push(type === FakeNotice.Sticker
            ? " This is a FakeNitro sticker and renders like a real sticker only for you. Appears as a link to non-plugin users."
            : " This is a FakeNitro emoji and renders like a real emoji only for you. Appears as a link to non-plugin users.");
        return node;
    },

    getStickerLink({ format_type, id }) {
        const ext = format_type === StickerFormat.GIF ? "gif" : "png";
        return `https://media.discordapp.net/stickers/${id}.${ext}?size=${s().stickerSize}`;
    },

    async sendAnimatedSticker(stickerLink, stickerId, channelId) {
        try {
            const bytes = await (await fetch(stickerLink)).arrayBuffer();
            const gif = await apngToGif(bytes, s().stickerSize ?? 160);
            const file = new File([gif], `${stickerId}.gif`, { type: "image/gif" });
            const prompt = getPromptToUpload();
            const channel = stores.ChannelStore.getChannel(channelId);
            if (!prompt || !channel) throw new Error("upload function not found");
            prompt([file], channel, getDraftType()?.ChannelMessage ?? 0);
        } catch (e) {
            corvid.err("FakeNitro: animated sticker", e);
            alert("FakeNitro", `Couldn't convert this animated sticker: ${e?.message ?? e}`);
        }
    },

    canUseEmote(e, channelId) {
        if (e.type === 0) return true; // unicode
        if (e.available === false) return false;
        const guildId = stores.ChannelStore.getChannel(channelId)?.guild_id ?? null;
        const unusable = getIsUnusableRoleSubscriptionEmoji();
        if (unusable?.(e, guildId, true)) return false;

        let twitchSub = false;
        if (e.managed && e.guildId) {
            const myRoles = stores.GuildMemberStore.getSelfMember(e.guildId)?.roles ?? [];
            twitchSub = e.roles.some(r => myRoles.includes(r));
        }
        if (this.canUseEmotes || twitchSub) return e.guildId === guildId || hasExternalEmojiPerms(channelId);
        return !e.animated && e.guildId === guildId;
    },

    emojiLink(emoji) {
        const size = s().emojiSize ?? 48;
        const url = new URL(getIconUtils().getEmojiURL({ id: emoji.id, animated: emoji.animated, size }));
        url.searchParams.set("size", String(size));
        url.searchParams.set("name", emoji.name);
        url.searchParams.set("lossless", "true");
        if (emoji.animated) url.pathname = url.pathname.replace(".webp", ".gif");
        const text = s().hyperLinkText.replaceAll("{{NAME}}", emoji.name);
        return s().useEmojiHyperLinks ? `[${text}](${url})` : String(url);
    },

    async onPreSend(channelId, msg, options) {
        const st = s();
        let hasBypass = false;

        sticker: if (st.enableStickerBypass) {
            const sticker = stores.StickersStore.getStickerById(options.stickerIds?.[0]);
            if (!sticker) break sticker;
            if ("pack_id" in sticker) break sticker; // standard stickers are free
            const guildId = stores.ChannelStore.getChannel(channelId)?.guild_id;
            const canUse = this.canUseStickers && hasExternalStickerPerms(channelId);
            if (sticker.available !== false && (canUse || sticker.guild_id === guildId)) break sticker;

            if (sticker.format_type === StickerFormat.LOTTIE) {
                alert("FakeNitro", "Lottie stickers can't be sent as fake stickers.");
                return { cancel: true };
            }
            const link = this.getStickerLink(sticker);
            if (sticker.format_type === StickerFormat.APNG) {
                if (!hasAttachmentPerms(channelId)) {
                    alert("Hold on!", "You cannot send this message because it contains an animated FakeNitro sticker, and you do not have permissions to attach files in the current channel. Please remove the sticker to proceed.");
                } else {
                    this.sendAnimatedSticker(link, sticker.id, channelId);
                }
                return { cancel: true };
            }
            hasBypass = true;
            const url = new URL(link);
            url.searchParams.set("name", sticker.name);
            url.searchParams.set("lossless", "true");
            const text = st.hyperLinkText.replaceAll("{{NAME}}", sticker.name);
            msg.content += `${getWordBoundary(msg.content, msg.content.length - 1)}${st.useStickerHyperLinks ? `[${text}](${url})` : url}`;
            options.stickerIds.length = 0;
        }

        if (st.enableEmojiBypass) {
            for (const emoji of msg.validNonShortcutEmojis ?? []) {
                if (this.canUseEmote(emoji, channelId)) continue;
                hasBypass = true;
                const emojiString = `<${emoji.animated ? "a" : ""}:${emoji.originalName || emoji.name}:${emoji.id}>`;
                const link = this.emojiLink(emoji);
                msg.content = msg.content.replace(emojiString, (m, offset, orig) =>
                    `${getWordBoundary(orig, offset - 1)}${link}${getWordBoundary(orig, offset + m.length)}`);
            }
        }

        if (hasBypass && !st.disableEmbedPermissionCheck && !hasEmbedPerms(channelId) && !await confirmNoEmbed()) return { cancel: true };
        return { cancel: false };
    },

    async onPreEdit(channelId, _messageId, msg) {
        const st = s();
        if (!st.enableEmojiBypass) return;
        let hasBypass = false;
        msg.content = msg.content.replace(/(?<!\\)<a?:(?:\w+):(\d+)>/ig, (str, id, offset, orig) => {
            const emoji = stores.EmojiStore.getCustomEmojiById(id);
            if (emoji == null || this.canUseEmote(emoji, channelId)) return str;
            hasBypass = true;
            return `${getWordBoundary(orig, offset - 1)}${this.emojiLink(emoji)}${getWordBoundary(orig, offset + str.length)}`;
        });
        if (hasBypass && !st.disableEmbedPermissionCheck && !hasEmbedPerms(channelId) && !await confirmNoEmbed()) return { cancel: true };
        return { cancel: false };
    },

    start() {
        const st = s();
        if (!st.enableEmojiBypass && !st.enableStickerBypass) return;
        this.unSend = corvid.messages.onPreSend((c, m, o) => this.onPreSend(c, m, o));
        this.unEdit = corvid.messages.onPreEdit((c, id, m) => this.onPreEdit(c, id, m));
    },

    stop() {
        this.unSend?.();
        this.unEdit?.();
    },
});

// Patch predicates run inside definePlugin, before `p` is assigned.
function s() { return corvid.plugins.FakeNitro.settings.store; }

// ------------------------------------------------------------ APNG -> GIF
// Only built when an animated sticker is actually sent.

/** Decode an animated PNG (composited frames via ImageDecoder) into a GIF. */
async function apngToGif(buffer, size) {
    if (typeof ImageDecoder !== "function") throw new Error("ImageDecoder unavailable");
    const decoder = new ImageDecoder({ data: buffer, type: "image/png" });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const gif = gifWriter();
    try {
        for (let i = 0; i < count; i++) {
            const { image } = await decoder.decode({ frameIndex: i });
            const w = image.displayWidth, h = image.displayHeight;
            const scale = size / Math.max(w, h);
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(image, 0, 0, w * scale, h * scale);
            const delay = image.duration ? image.duration / 1000 : 100; // us -> ms
            image.close();
            const { data } = ctx.getImageData(0, 0, size, size);
            const { palette, index } = palettize(data);
            gif.frame(index, size, size, palette, delay <= 10 ? 100 : delay);
        }
    } finally { decoder.close(); }
    return gif.finish();
}

/** Quantize RGBA to <=255 opaque colours + index 255 for transparent pixels. */
function palettize(rgba) {
    const n = rgba.length >> 2;
    const TRANSPARENT = 255;
    // Histogram of opaque pixels in rgb565 bins.
    const bins = new Map();
    for (let i = 0; i < n; i++) {
        const o = i << 2;
        if (rgba[o + 3] < 128) continue;
        const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
        const key = ((r << 8) & 0xf800) | ((g << 3) & 0x7e0) | (b >> 3);
        let bin = bins.get(key);
        if (!bin) bins.set(key, bin = { r: 0, g: 0, b: 0, cnt: 0 });
        bin.r += r; bin.g += g; bin.b += b; bin.cnt++;
    }
    // PNN is ~quadratic in bins: coarsen noisy frames to rgb444 first.
    let list = [...bins.values()];
    if (list.length > 4096) {
        const coarse = new Map();
        for (const b of list) {
            const k = ((b.r / b.cnt) >> 4) << 8 | ((b.g / b.cnt) >> 4) << 4 | ((b.b / b.cnt) >> 4);
            const c = coarse.get(k);
            if (c) { c.r += b.r; c.g += b.g; c.b += b.b; c.cnt += b.cnt; } else coarse.set(k, { ...b });
        }
        list = [...coarse.values()];
    }
    const palette = pnnQuantize(list, 255);
    // Map each rgb565 key to its nearest palette entry once.
    const cache = new Map();
    const nearest = key => {
        let k = cache.get(key);
        if (k !== undefined) return k;
        const r = (key >> 8) & 0xf8, g = (key >> 3) & 0xfc, b = (key << 3) & 0xf8;
        let best = 1e9;
        k = 0;
        for (let j = 0; j < palette.length; j++) {
            const c = palette[j];
            const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
            if (d < best) { best = d; k = j; }
        }
        cache.set(key, k);
        return k;
    };
    const index = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const o = i << 2;
        if (rgba[o + 3] < 128) { index[i] = TRANSPARENT; continue; }
        index[i] = nearest(((rgba[o] << 8) & 0xf800) | ((rgba[o + 1] << 3) & 0x7e0) | (rgba[o + 2] >> 3));
    }
    while (palette.length < 256) palette.push([0, 0, 0]);
    return { palette, index };
}

/** Pairwise-nearest-neighbour colour reduction (after gifenc's pnnquant2). */
function pnnQuantize(input, maxColors) {
    const bins = input.map(b => ({ r: b.r / b.cnt, g: b.g / b.cnt, b: b.b / b.cnt, cnt: b.cnt, nn: 0, fw: 0, bk: 0, tm: 0, mtm: 0, err: 0 }));
    const nb = bins.length;
    if (nb <= maxColors) return bins.map(b => [Math.round(b.r), Math.round(b.g), Math.round(b.b)]);
    const useSqrt = maxColors * maxColors / nb >= 0.022;
    for (let i = 0; i < nb; i++) {
        if (i < nb - 1) { bins[i].fw = i + 1; bins[i + 1].bk = i; }
        if (useSqrt) bins[i].cnt = Math.sqrt(bins[i].cnt);
    }
    const DELETED = 0x7fffffff;
    const findNN = idx => {
        const b1 = bins[idx];
        let nn = 0, err = 1e100;
        for (let i = b1.fw; i !== 0; i = bins[i].fw) {
            const b = bins[i];
            const w = b1.cnt * b.cnt / (b1.cnt + b.cnt);
            if (w >= err) continue;
            const e = w * ((b.r - b1.r) ** 2 + (b.g - b1.g) ** 2 + (b.b - b1.b) ** 2);
            if (e < err) { err = e; nn = i; }
        }
        b1.err = err; b1.nn = nn;
    };
    const heap = new Uint32Array(nb + 1);
    for (let i = 0; i < nb; i++) {
        findNN(i);
        const err = bins[i].err;
        let l, l2;
        for (l = ++heap[0]; l > 1; l = l2) {
            l2 = l >> 1;
            if (bins[heap[l2]].err <= err) break;
            heap[l] = heap[l2];
        }
        heap[l] = i;
    }
    for (let i = 0; i < nb - maxColors;) {
        let tb, b1;
        for (;;) {
            b1 = heap[1];
            tb = bins[b1];
            if (tb.tm >= tb.mtm && bins[tb.nn].mtm <= tb.tm) break;
            if (tb.mtm === DELETED) b1 = heap[1] = heap[heap[0]--];
            else { findNN(b1); tb.tm = i; }
            const err = bins[b1].err;
            let l, l2;
            for (l = 1; (l2 = l + l) <= heap[0]; l = l2) {
                if (l2 < heap[0] && bins[heap[l2]].err > bins[heap[l2 + 1]].err) l2++;
                if (err <= bins[heap[l2]].err) break;
                heap[l] = heap[l2];
            }
            heap[l] = b1;
        }
        const other = bins[tb.nn];
        const d = 1 / (tb.cnt + other.cnt);
        tb.r = d * (tb.cnt * tb.r + other.cnt * other.r);
        tb.g = d * (tb.cnt * tb.g + other.cnt * other.g);
        tb.b = d * (tb.cnt * tb.b + other.cnt * other.b);
        tb.cnt += other.cnt;
        tb.mtm = ++i;
        bins[other.bk].fw = other.fw;
        bins[other.fw].bk = other.bk;
        other.mtm = DELETED;
    }
    const out = [];
    for (let i = 0; ; i = bins[i].fw) {
        out.push([Math.round(bins[i].r), Math.round(bins[i].g), Math.round(bins[i].b)]);
        if (bins[i].fw === 0) break;
    }
    return out;
}

/** Minimal GIF89a writer: looping, one 256-colour local palette per frame. */
function gifWriter() {
    let buf = new Uint8Array(1 << 16), len = 0;
    const byte = b => { if (len >= buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; } buf[len++] = b; };
    const u16 = v => { byte(v & 0xff); byte((v >> 8) & 0xff); };
    const str = s => { for (let i = 0; i < s.length; i++) byte(s.charCodeAt(i)); };
    let first = true;
    return {
        frame(index, w, h, palette, delayMs) {
            if (first) {
                str("GIF89a");
                u16(w); u16(h); byte(0x70); byte(0); byte(0); // no global colour table
                byte(0x21); byte(0xff); byte(11); str("NETSCAPE2.0"); byte(3); byte(1); u16(0); byte(0);
                first = false;
            }
            // Graphic control: dispose to background, transparent index 255.
            byte(0x21); byte(0xf9); byte(4); byte((2 << 2) | 1); u16(Math.round(delayMs / 10)); byte(255); byte(0);
            byte(0x2c); u16(0); u16(0); u16(w); u16(h); byte(0x80 | 7);
            for (const c of palette) { byte(c[0]); byte(c[1]); byte(c[2]); }
            lzw(index, 8, byte);
        },
        finish() { byte(0x3b); return buf.slice(0, len); },
    };
}

/** GIF LZW (after gifenc's lzwEncode / Kevin Weiner's LZWEncoder). */
function lzw(pixels, colorDepth, byte) {
    const BITS = 12, HSIZE = 5003;
    const htab = new Int32Array(HSIZE).fill(-1), codetab = new Int32Array(HSIZE);
    const accum = new Uint8Array(256);
    const initCodeSize = Math.max(2, colorDepth), initBits = initCodeSize + 1;
    const ClearCode = 1 << initCodeSize, EOFCode = ClearCode + 1;
    let nBits = initBits, maxcode = (1 << nBits) - 1, freeEnt = ClearCode + 2, clearFlg = false;
    let curAccum = 0, curBits = 0, aCount = 0;
    let hshift = 0;
    for (let f = HSIZE; f < 65536; f *= 2) hshift++;
    hshift = 8 - hshift;

    const flush = () => { if (aCount > 0) { byte(aCount); for (let i = 0; i < aCount; i++) byte(accum[i]); aCount = 0; } };
    const out = code => {
        curAccum &= (1 << curBits) - 1;
        curAccum = curBits > 0 ? curAccum | (code << curBits) : code;
        curBits += nBits;
        while (curBits >= 8) {
            accum[aCount++] = curAccum & 0xff;
            if (aCount >= 254) flush();
            curAccum >>= 8;
            curBits -= 8;
        }
        if (freeEnt > maxcode || clearFlg) {
            if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
            else { nBits++; maxcode = nBits === BITS ? 1 << nBits : (1 << nBits) - 1; }
        }
        if (code === EOFCode) {
            while (curBits > 0) {
                accum[aCount++] = curAccum & 0xff;
                if (aCount >= 254) flush();
                curAccum >>= 8;
                curBits -= 8;
            }
            flush();
        }
    };

    byte(initCodeSize);
    out(ClearCode);
    let ent = pixels[0];
    outer: for (let idx = 1; idx < pixels.length; idx++) {
        const c = pixels[idx];
        const fcode = (c << BITS) + ent;
        let i = (c << hshift) ^ ent;
        if (htab[i] === fcode) { ent = codetab[i]; continue; }
        const disp = i === 0 ? 1 : HSIZE - i;
        while (htab[i] >= 0) {
            i -= disp;
            if (i < 0) i += HSIZE;
            if (htab[i] === fcode) { ent = codetab[i]; continue outer; }
        }
        out(ent);
        ent = c;
        if (freeEnt < 1 << BITS) { codetab[i] = freeEnt++; htab[i] = fcode; }
        else { htab.fill(-1); freeEnt = ClearCode + 2; clearFlg = true; out(ClearCode); }
    }
    out(ent);
    out(EOFCode);
    byte(0);
}

// For tests (tests can't reach module-scope helpers otherwise).
p._gif = { palettize, pnnQuantize, gifWriter };
