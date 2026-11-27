// messageLogger: keep deleted messages (in place, tinted red, media in
// greyscale) and edit histories, also across restarts. Storage lives in the
// host (crates/corvid-core/src/msglog.rs) behind the msglog.* commands; this
// file decides what to log and puts it into Discord's MessageStore.
//
// How it hooks in:
// - MessageRecord keeps an extra `corvidLog` field ({deleted, edits}), so a
//   flag set on a record survives the store's immutable updates.
// - MessageStore's MESSAGE_DELETE / _BULK handlers mark logged messages
//   instead of removing them; MESSAGE_UPDATE carries the log over and appends
//   the previous content on a real edit.
// - A dispatcher interceptor holds each LOAD_MESSAGES_SUCCESS until the host
//   has answered which logged messages fall in that page (and which seen
//   messages vanished while corvid was closed), inserts them, and lets the
//   action through: the store commits one complete page, no flicker.
// SPDX-License-Identifier: MIT
(() => {
const { webpack } = corvid;
const SENT = "SENT";
const EPHEMERAL = 64;
const SEEN_FLUSH_MS = 1000;
const PAGE_TIMEOUT_MS = 3000;

let React = null;
let Parser = null;
let MenuTypes = null;
let interceptorOn = false;
/** Ids whose delete/update the store patch handled during the current dispatch. */
const handledNow = new Set();
let seenQueue = [];
let seenTimer = 0;
let ctxMsg = null, ctxChannel = null;
/** Rendered edit history per `corvidLog.edits` array. The arrays are never
 *  mutated (an edit makes a new one), so the element stays valid, and handing
 *  React the same element lets it skip that subtree on hover re-renders. */
const editsView = new WeakMap();
/** Marker elements per `corvidLog.deleted` object: [header, gutter]. */
const markerView = new WeakMap();
const NO_CLASS = Object.freeze({});

const now = () => Date.now();
const fmt = ms => { try { return new Date(ms).toLocaleString(); } catch { return String(ms); } };
const cmpId = (a, b) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };
// Ignore lists, parsed once per distinct setting string.
const idsCache = new Map();
const ids = s => {
    s = String(s ?? "");
    let v = idsCache.get(s);
    if (!v) {
        if (idsCache.size >= 16) idsCache.clear();
        idsCache.set(s, v = new Set(s.split(/[\s,]+/).filter(Boolean)));
    }
    return v;
};

function store(name) { return corvid.stores[name]; }
function me() { return store("UserStore")?.getCurrentUser?.()?.id; }

/** Raw (API-shaped) message → what the host stores. Host re-slims anyway. */
function slimRaw(m) {
    if (!m?.id || !m.channel_id) return null;
    const a = m.author;
    const ref = m.referenced_message;
    return {
        id: m.id, channel_id: m.channel_id, guild_id: m.guild_id,
        content: m.content ?? "", timestamp: m.timestamp, edited_timestamp: m.edited_timestamp ?? null,
        flags: m.flags ?? 0, type: m.type ?? 0, webhook_id: m.webhook_id,
        author: a ? { id: a.id, username: a.username, global_name: a.global_name ?? a.globalName ?? null, avatar: a.avatar ?? null, discriminator: a.discriminator, bot: !!a.bot } : undefined,
        mentions: (m.mentions ?? []).map(u => typeof u === "string" ? u : u?.id).filter(Boolean),
        mention_roles: m.mention_roles ?? [], mention_everyone: !!m.mention_everyone,
        attachments: m.attachments ?? [], embeds: m.embeds ?? [], sticker_items: m.sticker_items ?? m.stickerItems ?? [],
        message_reference: m.message_reference,
        referenced_message: ref ? { id: ref.id, channel_id: ref.channel_id, content: (ref.content ?? "").slice(0, 300), author: ref.author && { id: ref.author.id, username: ref.author.username, global_name: ref.author.global_name, avatar: ref.author.avatar } } : undefined,
    };
}

/** A MessageRecord (store) → API shape, for deletes the host has no seen copy of. */
function recordToRaw(r) {
    const a = r.author;
    const ts = v => v == null ? null : (typeof v.toISOString === "function" ? v.toISOString() : new Date(v).toISOString());
    return slimRaw({
        id: r.id, channel_id: r.channel_id, content: r.content, timestamp: ts(r.timestamp), edited_timestamp: ts(r.editedTimestamp),
        flags: r.flags, type: r.type, webhook_id: r.webhookId,
        author: a && { id: a.id, username: a.username, global_name: a.globalName, avatar: a.avatar, discriminator: a.discriminator, bot: a.bot },
        mentions: r.mentions, mention_roles: r.mentionRoles, mention_everyone: r.mentionEveryone,
        attachments: r.attachments, embeds: [], sticker_items: r.stickerItems,
        message_reference: r.messageReference && { message_id: r.messageReference.message_id, channel_id: r.messageReference.channel_id, guild_id: r.messageReference.guild_id, type: r.messageReference.type },
    });
}

/** Stored (slim) message → raw message the store can turn into a record. */
function storedToRaw(m, log) {
    return { ...m, mentions: (m.mentions ?? []).map(id => ({ id })), corvidLog: log };
}

const p = corvid.definePlugin({
    name: "MessageLogger",
    description: "Keep deleted messages (in red, media in greyscale) and edit histories, also across restarts.",
    enabledByDefault: true,
    settings: {
        logDeletes: { type: "boolean", default: true, description: "Keep deleted messages" },
        logEdits: { type: "boolean", default: true, description: "Keep edit history" },
        deleteStyle: { type: "select", default: "text", description: "Deleted message style", options: [{ label: "Red tint + red text", value: "text" }, { label: "Red tint only", value: "overlay" }] },
        ignoreBots: { type: "boolean", default: false, description: "Don't log bot messages" },
        ignoreSelf: { type: "boolean", default: false, description: "Don't log your own messages" },
        ignoreWebhooks: { type: "boolean", default: false, description: "Don't log webhook messages" },
        ignoreUsers: { type: "string", default: "", description: "Ignored user ids (comma-separated)" },
        ignoreChannels: { type: "string", default: "", description: "Ignored channel ids (comma-separated)" },
        ignoreGuilds: { type: "string", default: "", description: "Ignored server ids (comma-separated)" },
        maxEdits: { type: "number", default: 30, min: 1, max: 200, step: 1, description: "Old versions kept per message" },
        persist: { type: "boolean", default: true, description: "Keep the log on disk (off: this session only)" },
        rememberSeenDays: { type: "number", default: 7, min: 0, max: 365, step: 1, description: "Days to remember seen messages (to log deletes of unloaded messages)" },
        detectOfflineDeletes: { type: "boolean", default: true, description: "Detect deletes and edits that happened while corvid was closed" },
        downloadAudio: { type: "boolean", default: true, description: "Download audio and voice messages so they still play after deletion" },
        maxAudioMB: { type: "number", default: 50, min: 1, max: 1024, step: 1, description: "Largest audio file to download (MB)" },
        cacheVideos: { type: "boolean", default: true, description: "Cache videos for this session (deleted videos keep playing until restart)" },
        maxVideoMB: { type: "number", default: 100, min: 1, max: 2048, step: 1, description: "Largest video to cache (MB)" },
        cache: { type: "custom", description: "Message log cache", render: () => p.renderCachePanel() },
    },

    css: `
.corvid-ml-deleted { background: rgb(240 71 71 / 0.09) !important; box-shadow: inset 2px 0 0 rgb(240 71 71 / 0.85); }
.corvid-ml-deleted:hover { background: rgb(240 71 71 / 0.14) !important; }
.corvid-ml-text [id^="message-content-"], .corvid-ml-text [id^="message-content-"] * { color: #f23f43 !important; }
.corvid-ml-marker { color: #f23f43; font-size: 0.6875rem; font-weight: 600; margin-left: 0.4rem; cursor: default; text-transform: lowercase; vertical-align: baseline; }
.corvid-ml-marker.gutter { margin-left: 0; display: block; line-height: 1.1; }
.corvid-ml-edits { opacity: 0.6; }
.corvid-ml-edit { color: var(--text-muted, var(--text-secondary)); white-space: pre-wrap; overflow-wrap: anywhere; }
.corvid-ml-edited { font-size: 0.625rem; margin-left: 0.25rem; color: var(--text-muted); cursor: default; }
/* Media of deleted messages: greyscale per media item (attachment tile,
   embed incl. its colour bar, sticker), in colour while hovered or playing. */
.corvid-ml-deleted [id^="message-accessories-"] :is([class*="mosaicItem"], [class*="embedFull"], [class*="stickerAsset"], [class*="clickableSticker"]),
.corvid-ml-deleted [id^="message-accessories-"] :is(img, video):not(:is([class*="mosaicItem"], [class*="embedFull"], [class*="stickerAsset"], [class*="clickableSticker"]) *) {
  filter: grayscale(1); transition: filter 200ms ease;
}
.corvid-ml-deleted [id^="message-accessories-"] :is([class*="mosaicItem"], [class*="embedFull"], [class*="stickerAsset"], [class*="clickableSticker"], img, video):is(:hover, .corvid-ml-playing, :has(.corvid-ml-playing)) { filter: none; }
.corvid-ml-confirm { position: fixed; inset: 0; z-index: 10000; display: grid; place-items: center; background: rgb(0 0 0 / 0.6); }
.corvid-ml-confirm > div { background: var(--modal-background, var(--background-primary, #313338)); color: var(--text-normal, #dbdee1); padding: 20px; border-radius: 8px; max-width: 420px; font-size: 14px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.4); }
.corvid-ml-confirm h2 { font-size: 18px; margin: 0 0 8px; font-weight: 600; }
.corvid-ml-confirm .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.corvid-ml-confirm button { all: unset; cursor: pointer; padding: 7px 16px; border-radius: 4px; background: #4e5058; color: #fff; }
.corvid-ml-confirm button.danger { background: #da373c; }
.corvid-ml-confirm button:focus-visible { outline: 2px solid #00a8fc; }
`,

    patches: [
        {
            // MessageRecord: keep our field through record.set()/merge().
            find: ["canDeleteOwnMessage(", "guild_space_data??"],
            replacement: {
                match: /(this\.guildSpaceData=(\i)\.guild_space_data\?\?\2\.guildSpaceData\?\?null)/,
                replace: "$1,null!=$2.corvidLog&&(this.corvidLog=$2.corvidLog)",
            },
        },
        {
            find: 'displayName="MessageStore"',
            replacement: [
                {
                    match: /(MESSAGE_DELETE:function\((\i)\)\{.{0,400}?)(\i)\((\i)\.get\((\i)\)\),\4=\4\.remove\(\5\)/,
                    replace: "$1$3($4.get($5)),$4=$self.onStoreDelete($4,$5,$2)",
                },
                {
                    match: /(MESSAGE_DELETE_BULK:function\((\i)\)\{.{0,200}?)let (\i)=(\i)\.removeMany\((\i)\)/,
                    replace: "$1let $3=$self.onStoreDeleteBulk($4,$5,$2)",
                },
                {
                    match: /(\i)=(\i)\.update\((\i),(\i)=>\(0,(\i)\.(\i)\)\(\4,(\i)\.message\)\)/,
                    replace: "$1=$2.update($3,$4=>$self.onStoreUpdate($4,(0,$5.$6)($4,$7.message),$7.message))",
                },
                {
                    // the store's ChannelMessages collection, for in-place changes
                    match: /getMessage\((\i),(\i)\)\{return (\i\.\i)\.getOrCreate\(\1\)\.get\(\2\)\}/,
                    replace: "corvidChannelMessages(){return $3}$&",
                },
                {
                    // up-arrow edit skips deleted messages
                    match: /(getLastEditableMessage\(\i\)\{.{0,150}?\.find\((\i)=>)/,
                    replace: "$1!$2.corvidLog?.deleted&&",
                },
            ],
        },
        {
            // Chat message: row classes, no hover bar, edit history above the content.
            find: "buttonProps:{message:",
            replacement: [
                {
                    match: /(\[\i\.\i\]:(\i)\.isCommandType\(\)&&\2\.state===\i\.\i\.SENDING)/,
                    replace: "...$self.rowClass($2),$1",
                },
                {
                    match: /(buttonProps:\{message:(\i).{0,80}?messageWindow:\i\}=\i,\i=)/,
                    replace: "$1$self.isDeleted($2)||",
                },
                {
                    match: /(\i)=\(0,(\i)\.jsx\)\((\i)\.(\i),\{value:(\i),children:\1\}\);let (\i)=(\i)\.id===/,
                    replace: "$1=(0,$2.jsx)($3.$4,{value:$5,children:$self.content($7,$1)});let $6=$7.id===",
                },
                {
                    // grouped (headerless) rows: marker under the hover timestamp
                    match: /(\(0,\i\.jsx\)\(\i,\{compact:!0,timestamp:(\i)\.timestamp,isInline:!1,id:\(0,\i\.\i\)\(\2\),isVisibleOnlyOnHover:!0,cozyAlt:!0\}\))/,
                    replace: "$self.withMarker($1,$2,!0)",
                },
            ],
        },
        {
            // Message header: "deleted" marker after the timestamp.
            find: ["showTimestampOnHover:", "New Member Badge Popout"],
            replacement: {
                // Wrap the timestamp element itself, so the marker sits inside
                // the same `showTimestamp&&…` condition: appending it as a
                // sibling rendered it unconditionally (twice per header, with
                // one shared key, and React then kept stale copies piling up).
                match: /(\(0,\i\.jsx\)\(\i\.\i,\{id:\(0,\i\.\i\)\((\i)\),(?:compact:!0,)?timestamp:\2\.timestamp,[^}]{0,80}?application:\i\}\))/g,
                replace: "$self.withMarker($1,$2)",
            },
        },
        {
            // Context menus: our items go into the root Menu's children.
            find: 'type:"customitem"',
            replacement: {
                match: /(function \i\((\i)\)\{)(let\{navId:\i,variant:\i="flexible")/,
                replace: "$1$2=$self.menuProps($2);$3",
            },
        },
        {
            // Remember which message / channel a context menu is for.
            find: 'navId:"message"',
            all: true,
            replacement: { match: /navId:"message"/g, replace: 'navId:$self.noteCtx("message",arguments[0])' },
        },
        {
            find: 'navId:"channel-context"',
            all: true,
            replacement: { match: /navId:"channel-context"/g, replace: 'navId:$self.noteCtx("channel-context",arguments[0])' },
        },
        {
            find: 'navId:"thread-context"',
            all: true,
            replacement: { match: /navId:"thread-context"/g, replace: 'navId:$self.noteCtx("thread-context",arguments[0])' },
        },
        {
            find: 'navId:"gdm-context"',
            all: true,
            replacement: { match: /navId:"gdm-context"/g, replace: 'navId:$self.noteCtx("gdm-context",arguments[0])' },
        },
        {
            find: 'navId:"user-context"',
            all: true,
            replacement: { match: /navId:"user-context"/g, replace: 'navId:$self.noteCtx("user-context",arguments[0])' },
        },
        {
            // No reactions on deleted messages (the API call would just fail).
            find: ["\"Message Reaction Picker\"", "\"MESSAGE_REACTION_ADD\","],
            replacement: {
                match: /(async function \i\((\i),(\i),\i\)\{)(var \i,\i,\i,\i;let \i,\i=arguments\.length>3)/,
                replace: "$1if($self.isDeletedId($2,$3))return;$4",
            },
        },
    ],

    start() {
        webpack.waitFor(webpack.filters.byProps("createElement", "useState", "Fragment"), r => { React = r; });
        webpack.waitFor(webpack.filters.byProps("parse", "parseTopic"), m => { Parser = m; });
        this.sendInit();
        if (corvid.flux && !interceptorOn) {
            interceptorOn = true;
            corvid.flux.addInterceptor(a => p.started && p.intercept(a));
        }
        this._media = e => p.onMediaEvent(e);
        for (const t of ["play", "playing", "pause", "ended", "emptied"]) document.addEventListener(t, this._media, true);
    },
    stop() {
        for (const t of ["play", "playing", "pause", "ended", "emptied"]) document.removeEventListener(t, this._media, true);
        this.flushSeen();
    },
    onSettingChange(k) {
        if (["persist", "rememberSeenDays", "downloadAudio", "maxAudioMB", "cacheVideos", "maxVideoMB"].includes(k)) this.sendInit();
    },
    sendInit() {
        const s = this.settings.store;
        corvid.native("msglog.init", {
            persist: !!s.persist, seenDays: Math.max(0, Math.round(s.rememberSeenDays)),
            downloadAudio: !!s.downloadAudio, maxAudioMB: Math.round(s.maxAudioMB),
            cacheVideos: !!s.cacheVideos, maxVideoMB: Math.round(s.maxVideoMB),
        }).catch(e => corvid.err("MessageLogger init", e));
    },
    host(cmd, args) {
        return corvid.native("msglog." + cmd, args).catch(e => { corvid.err("MessageLogger", cmd, e); return null; });
    },

    // ------------------------------------------------------------ policy
    /** Whether a message (record or raw) is logged under the ignore rules. */
    wanted(m, channelId) {
        const s = this.settings.store;
        if (!m) return false;
        const author = m.author ?? {};
        const flags = m.flags ?? 0;
        if (flags & EPHEMERAL) return false;
        if (m.state && m.state !== SENT) return false;
        if (s.ignoreBots && author.bot) return false;
        if (s.ignoreWebhooks && (m.webhookId ?? m.webhook_id)) return false;
        if (s.ignoreSelf && author.id && author.id === me()) return false;
        if (ids(s.ignoreUsers).has(author.id)) return false;
        const ch = channelId ?? m.channel_id;
        if (ids(s.ignoreChannels).has(ch)) return false;
        const chan = store("ChannelStore")?.getChannel?.(ch);
        if (chan?.parent_id && ids(s.ignoreChannels).has(chan.parent_id)) return false;
        const guild = chan?.guild_id ?? m.guild_id;
        if (guild && ids(s.ignoreGuilds).has(guild)) return false;
        return true;
    },
    isDeleted(m) { return !!m?.corvidLog?.deleted; },
    isDeletedId(channelId, id) {
        return this.isDeleted(store("MessageStore")?.getMessage?.(channelId, id));
    },

    // ------------------------------------------------------------ store patches
    onStoreDelete(cm, id, action) {
        const rec = cm.get(id);
        if (action.corvidRemove || !this.started || !this.settings.store.logDeletes || !rec) return cm.remove(id);
        if (this.isDeleted(rec)) { handledNow.add(id); return cm; }
        if ((action.local && rec.state !== SENT) || !this.wanted(rec, action.channelId)) return cm.remove(id);
        handledNow.add(id);
        const at = now();
        this.flushSeen();
        this.host("delete", { channelId: action.channelId, items: [{ id, at, message: recordToRaw(rec) }] });
        // The host prefers its own (API-shaped) seen copy; the record is the fallback.
        return cm.update(id, m => m.set("corvidLog", { ...m.corvidLog, deleted: { at, offline: false } }));
    },
    onStoreDeleteBulk(cm, list, action) {
        if (!this.started || !this.settings.store.logDeletes) return cm.removeMany(list);
        const keep = [], drop = [];
        for (const id of list) {
            const rec = cm.get(id);
            if (rec && !this.isDeleted(rec) && this.wanted(rec, action.channelId)) keep.push(id);
            else if (rec && this.isDeleted(rec)) handledNow.add(id);
            else drop.push(id);
        }
        let out = drop.length ? cm.removeMany(drop) : cm;
        if (!keep.length) return out;
        const at = now();
        this.flushSeen();
        this.host("delete", { channelId: action.channelId, items: keep.map(id => ({ id, at, message: recordToRaw(cm.get(id)) })) });
        for (const id of keep) {
            handledNow.add(id);
            out = out.update(id, m => m.set("corvidLog", { ...m.corvidLog, deleted: { at, offline: false } }));
        }
        return out;
    },
    onStoreUpdate(old, next, raw) {
        // Stopped: no flux handler will take the id back out of handledNow.
        if (!this.started) return next;
        handledNow.add(old.id);
        if (this.isDeleted(old)) return old;  // frozen as it was when deleted
        let log = old.corvidLog;
        const s = this.settings.store;
        const edited = raw && typeof raw.content === "string" && raw.content !== old.content && raw.edited_timestamp != null
            && (old.editedTimestamp == null || Date.parse(raw.edited_timestamp) > +new Date(old.editedTimestamp));
        if (edited && s.logEdits && this.wanted(old, old.channel_id)) {
            const at = Date.parse(raw.edited_timestamp) || now();
            const max = Math.max(1, Math.round(s.maxEdits));
            const edits = [...(log?.edits ?? []), { content: old.content, replacedAt: at }].slice(-max);
            log = { ...log, edits };
            this.host("edit", { channelId: old.channel_id, id: old.id, content: old.content, at, max });
        }
        return log && next.corvidLog !== log ? next.set("corvidLog", log) : next;
    },

    /** Apply `fn(record)` to one message in the store and re-render. */
    mutate(channelId, id, fn) {
        const MS = store("MessageStore");
        const CM = MS?.corvidChannelMessages?.();
        const cm = CM?.get?.(channelId);
        if (!cm?.has?.(id)) return false;
        CM.commit(fn(cm));
        MS.emitChange();
        return true;
    },

    // ------------------------------------------------------------ flux
    flux: {
        MESSAGE_CREATE({ channelId, message, optimistic, isPushNotification }) {
            if (optimistic || isPushNotification || !message || message.state === "SENDING") return;
            this.queueSeen(message, channelId);
        },
        MESSAGE_UPDATE({ message }) {
            if (!message?.id) return;
            const handled = handledNow.delete(message.id);
            const full = message.author && typeof message.content === "string";
            if (handled || !full) { if (full) this.queueSeen(message); return; }
            // Not loaded here: the previous content can only come from the seen cache.
            const s = this.settings.store;
            if (!s.logEdits || message.edited_timestamp == null || !this.wanted(message)) { this.queueSeen(message); return; }
            this.flushSeen();
            this.host("lookup", { channelId: message.channel_id, ids: [message.id] }).then(list => {
                const old = list?.[0];
                if (old && old.content !== message.content && (old.edited_timestamp == null || Date.parse(message.edited_timestamp) > Date.parse(old.edited_timestamp)))
                    this.host("edit", { channelId: message.channel_id, id: message.id, content: old.content, at: Date.parse(message.edited_timestamp) || now(), max: Math.round(s.maxEdits) });
                this.queueSeen(message);
            });
        },
        MESSAGE_DELETE({ id, channelId, local, corvidRemove }) {
            if (handledNow.delete(id) || corvidRemove || local) return;
            this.logUnloaded(channelId, [id]);
        },
        MESSAGE_DELETE_BULK({ ids: list, channelId }) {
            const rest = (list ?? []).filter(id => !handledNow.delete(id));
            if (rest.length) this.logUnloaded(channelId, rest);
        },
    },

    /** Deletes of messages the store doesn't hold: log them from the seen cache. */
    logUnloaded(channelId, list) {
        if (!this.settings.store.logDeletes || !channelId) return;
        const at = now();
        this.flushSeen();
        this.host("lookup", { channelId, ids: list }).then(found => {
            const items = (found ?? []).filter(m => this.wanted(m, channelId)).map(m => ({ id: m.id, at }));
            if (items.length) this.host("delete", { channelId, items });
        });
    },

    queueSeen(m, channelId) {
        const s = slimRaw(channelId && !m.channel_id ? { ...m, channel_id: channelId } : m);
        if (!s || (s.flags & EPHEMERAL)) return;
        seenQueue.push(s);
        if (seenQueue.length >= 400) this.flushSeen();
        else seenTimer ||= setTimeout(() => this.flushSeen(), SEEN_FLUSH_MS);
    },
    flushSeen() {
        clearTimeout(seenTimer);
        seenTimer = 0;
        if (!seenQueue.length) return;
        const batch = seenQueue;
        seenQueue = [];
        this.host("seen", { messages: batch });
    },

    // ------------------------------------------------------------ interceptor
    intercept(a) {
        switch (a.type) {
            case "LOAD_MESSAGES_SUCCESS":
                if (a.corvidML) return false;
                this.holdPage(a);
                return true;
            case "CREATE_PENDING_REPLY":
                return this.isDeleted(a.message);
            case "MESSAGE_START_EDIT":
                return this.isDeletedId(a.channelId, a.messageId);
            default:
                return false;
        }
    },

    holdPage(a) {
        let done = false;
        const release = () => {
            if (done) return;
            done = true;
            a.corvidML = true;
            try { corvid.flux.dispatch(a); } catch (e) { corvid.err("MessageLogger: re-dispatch", e); }
        };
        const timer = setTimeout(() => { corvid.warn("MessageLogger: host slow, page shown without log"); release(); }, PAGE_TIMEOUT_MS);
        const s = this.settings.store;
        const msgs = Array.isArray(a.messages) ? a.messages : [];
        this.flushSeen();
        this.host("page", {
            channelId: a.channelId,
            messages: msgs.map(slimRaw).filter(Boolean),
            detect: !!s.detectOfflineDeletes && msgs.length >= 2,
            openBefore: !a.hasMoreBefore && !a.isAfter,
            openAfter: !a.hasMoreAfter && !a.isBefore,
        }).then(r => {
            if (done) return;
            clearTimeout(timer);
            try { if (r) this.applyPage(a, r); } catch (e) { corvid.err("MessageLogger: page", e); }
            release();
        });
    },

    applyPage(a, r) {
        const s = this.settings.store;
        const ch = a.channelId;
        const edits = { ...(r.edits ?? {}) };
        const deleted = [...(r.deleted ?? [])];
        // Deletes/edits while we were away.
        const offAt = now();
        const accept = [], forget = [];
        for (const m of r.offline ?? []) {
            if (s.logDeletes && s.detectOfflineDeletes && this.wanted(m, ch)) accept.push(m); else forget.push(m.id);
        }
        if (accept.length) {
            this.host("delete", { channelId: ch, items: accept.map(m => ({ id: m.id, at: offAt, offline: true })) });
            for (const m of accept) deleted.push({ message: m, deletedAt: offAt, offline: true });
        }
        if (forget.length) this.host("forget", { channelId: ch, ids: forget });
        const byId = new Map(a.messages.map(m => [m.id, m]));
        for (const [id, c] of Object.entries(r.changed ?? {})) {
            const m = byId.get(id);
            if (!m || !s.logEdits || !this.wanted(m, ch)) continue;
            const at = Date.parse(c.editedTimestamp) || offAt;
            const max = Math.max(1, Math.round(s.maxEdits));
            edits[id] = [...(edits[id] ?? []), { content: c.content, replacedAt: at }].slice(-max);
            this.host("edit", { channelId: ch, id, content: c.content, at, max });
        }
        let changed = false;
        const out = a.messages.map(m => {
            if (!edits[m.id]) return m;
            changed = true;
            return { ...m, corvidLog: { edits: edits[m.id] } };
        });
        for (const d of deleted) {
            if (byId.has(d.message.id)) continue;
            changed = true;
            out.push(storedToRaw(d.message, { deleted: { at: d.deletedAt, offline: !!d.offline }, edits: edits[d.message.id] }));
        }
        if (!changed) return;
        out.sort((x, y) => cmpId(y.id, x.id));  // API order: newest first
        a.messages = out;
    },

    // ------------------------------------------------------------ rendering
    rowClass(m) {
        if (!this.isDeleted(m)) return NO_CLASS;
        return { "corvid-ml-deleted": true, "corvid-ml-text": this.settings.store.deleteStyle !== "overlay" };
    },
    marker(m, gutter) {
        const d = m?.corvidLog?.deleted;
        if (!d || !React) return null;
        let pair = markerView.get(d);
        if (!pair) markerView.set(d, pair = [null, null]);
        const i = gutter ? 1 : 0;
        if (!pair[i]) {
            const title = d.offline ? `Deleted while you were away (noticed ${fmt(d.at)})` : `Deleted ${fmt(d.at)}`;
            pair[i] = React.createElement("span", { className: "corvid-ml-marker" + (gutter ? " gutter" : ""), title, "aria-label": title }, "deleted");
        }
        return pair[i];
    },
    /** `el` (a timestamp element) followed by the marker, as one child. */
    withMarker(el, m, gutter) {
        const mk = this.marker(m, gutter);
        return mk ? React.createElement(React.Fragment, null, el, mk) : el;
    },
    content(m, node) {
        const edits = m?.corvidLog?.edits;
        if (!edits?.length || !React) return node;
        let old = editsView.get(edits);
        if (!old) {
            const parse = text => {
                try {
                    return Parser?.parse ? Parser.parse(text, true, { channelId: m.channel_id, messageId: m.id, allowLinks: true, allowEmojiLinks: true, allowList: true, allowHeading: true, viewingChannelId: m.channel_id }) : text;
                } catch { return text; }
            };
            old = React.createElement("div", { key: "corvid-ml-edits", className: "corvid-ml-edits" },
                edits.map((e, i) => React.createElement("div", { key: i, className: "corvid-ml-edit markup" },
                    parse(e.content),
                    React.createElement("span", { className: "corvid-ml-edited", title: `Replaced ${fmt(e.replacedAt)}` }, "(edited)"))));
            // Before the parser has loaded the text is plain: don't keep that.
            if (Parser?.parse) editsView.set(edits, old);
        }
        return React.createElement(React.Fragment, null, old, node);
    },

    /** Media of deleted messages stays in colour while it plays. */
    onMediaEvent(e) {
        const el = e.target;
        if (!(el instanceof HTMLMediaElement) || !el.closest?.(".corvid-ml-deleted")) return;
        el.classList.toggle("corvid-ml-playing", !el.paused && !el.ended);
    },

    // ------------------------------------------------------------ menus
    noteCtx(navId, props) {
        if (navId === "message") { ctxMsg = props?.message ?? null; ctxChannel = props?.channel ?? null; }
        else ctxChannel = props?.channel ?? null;
        return navId;
    },
    menuTypes() {
        if (MenuTypes) return MenuTypes;
        // The root Menu tells its children apart by placeholder components
        // (functions returning null); read which export is which from it.
        const menu = webpack.findModuleByCode('type:"customitem"');
        if (!menu) return null;
        let src = null;
        for (const k in menu) {
            let f;
            try { f = menu[k]; } catch { continue; }
            for (const c of [f, f?.render, f?.type]) {
                if (typeof c === "function" && Function.prototype.toString.call(c).includes('type:"customitem"')) src = Function.prototype.toString.call(c);
            }
        }
        if (!src) return null;
        const re = x => new RegExp(x.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"));
        const ms = re(/\i\.type===\i\.(\i)\)return \i\.push\(\{type:"separator"/).exec(src);
        const mi = re(/\i\.type===\i\.(\i)\)return \i\.push\(null!=\i\.props\.render\?\{type:"customitem"/).exec(src);
        const mg = re(/\i\.type===\i\.(\i)\)\{let \i=\i\(\i\.props\.children\)/).exec(src);
        if (!ms || !mi || !mg) return null;
        const isStub = f => typeof f === "function" && /^function\s*\(\w*\)\s*\{\s*return null;?\s*\}$/.test(Function.prototype.toString.call(f));
        const mod = webpack.find(m => isStub(m[ms[1]]) && isStub(m[mi[1]]) && isStub(m[mg[1]]));
        if (mod) MenuTypes = { item: mod[mi[1]], group: mod[mg[1]], sep: mod[ms[1]] };
        return MenuTypes;
    },
    menuProps(props) {
        try {
            const items = this.menuItems(props?.navId);
            if (!items?.length) return props;
            const T = this.menuTypes();
            if (!T || !React) return props;
            const group = React.createElement(T.group, { key: "corvid-ml" },
                items.map(it => React.createElement(T.item, { key: it.id, id: it.id, label: it.label, color: "danger", action: it.action })));
            return { ...props, children: [props.children, group] };
        } catch (e) {
            corvid.err("MessageLogger menu", e);
            return props;
        }
    },
    menuItems(navId) {
        if (!this.started) return null;
        if (navId === "message") {
            const m = ctxMsg;
            if (!m || !(this.isDeleted(m) || m.corvidLog?.edits?.length)) return null;
            return [{ id: "corvid-ml-remove", label: "Remove message history", action: () => this.removeHistory(m.channel_id, m.id) }];
        }
        const ch = ctxChannel;
        if (!ch?.id) return null;
        if (navId === "user-context" && !(ch.type === 1 || ch.type === 3)) return null;  // only DMs
        if (!["channel-context", "thread-context", "gdm-context", "user-context"].includes(navId)) return null;
        return [{ id: "corvid-ml-clear", label: "Clear message log", action: () => this.confirmClear(ch) }];
    },

    removeHistory(channelId, id) {
        this.host("remove", { channelId, id });
        const rec = store("MessageStore")?.getMessage?.(channelId, id);
        if (this.isDeleted(rec)) this.mutate(channelId, id, cm => cm.remove(id));
        else this.mutate(channelId, id, cm => cm.update(id, m => m.set("corvidLog", undefined)));
    },
    clearChannelView(channelId) {
        const MS = store("MessageStore");
        const CM = MS?.corvidChannelMessages?.();
        let cm = CM?.get?.(channelId);
        if (!cm) return;
        const gone = [], strip = [];
        cm.forEach?.(m => { if (this.isDeleted(m)) gone.push(m.id); else if (m.corvidLog) strip.push(m.id); });
        if (gone.length) cm = cm.removeMany(gone);
        for (const id of strip) cm = cm.update(id, m => m.set("corvidLog", undefined));
        CM.commit(cm);
        MS.emitChange();
    },
    async confirmClear(ch) {
        const name = ch.name || "this conversation";
        if (!await confirmDialog("Clear message log", `Remove every deleted message and edit history logged for ${name}? This can't be undone.`, "Clear")) return;
        await this.host("clearChannel", { channelId: ch.id });
        this.clearChannelView(ch.id);
    },

    // ------------------------------------------------------------ settings panel
    renderCachePanel() {
        const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids.filter(k => k != null)); return e; };
        const stats = el("p", { className: "muted", textContent: "Loading cache stats…" });
        const mb = n => (n / 1048576).toFixed(n < 10 * 1048576 ? 2 : 0) + " MB";
        const refresh = () => this.host("stats", {}).then(s => {
            if (!s) { stats.textContent = "Cache stats unavailable."; return; }
            stats.textContent = `${s.records} records (${s.deleted} deleted, ${s.edited} edited messages with ${s.editVersions} old versions, ${s.seen} seen) · text ${mb(s.textBytes)} · audio ${mb(s.audioBytes)} in ${s.audioFiles} files · session videos ${mb(s.videoBytes)} in ${s.videoFiles} files`;
        });
        const btn = el("button", { className: "btn", textContent: "Clear the whole message log" });
        btn.onclick = async () => {
            if (!await confirmDialog("Clear the whole message log", "Remove every logged deleted message, edit history, seen message and cached audio/video? This can't be undone.", "Clear all")) return;
            await this.host("clearAll", {});
            const MS = store("MessageStore");
            const CM = MS?.corvidChannelMessages?.();
            CM?.forEach?.(cm => this.clearChannelView(cm.channelId));
            refresh();
        };
        refresh();
        return el("div", { className: "opt" }, el("label", { textContent: "Message log cache" }), stats, btn);
    },
});

function confirmDialog(title, body, okLabel) {
    return new Promise(resolve => {
        const prevFocus = document.activeElement;
        const ok = Object.assign(document.createElement("button"), { className: "danger", textContent: okLabel });
        const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel" });
        const box = document.createElement("div");
        box.setAttribute("role", "alertdialog");
        box.setAttribute("aria-modal", "true");
        const h = Object.assign(document.createElement("h2"), { textContent: title });
        const t = Object.assign(document.createElement("p"), { textContent: body });
        const row = Object.assign(document.createElement("div"), { className: "row" });
        row.append(cancel, ok);
        box.append(h, t, row);
        const wrap = Object.assign(document.createElement("div"), { className: "corvid-ml-confirm" });
        wrap.append(box);
        const done = v => { wrap.remove(); document.removeEventListener("keydown", key, true); prevFocus?.focus?.(); resolve(v); };
        const key = e => { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); done(false); } };
        ok.onclick = () => done(true);
        cancel.onclick = () => done(false);
        wrap.onclick = e => { if (e.target === wrap) done(false); };
        document.addEventListener("keydown", key, true);
        document.body.append(wrap);
        cancel.focus();
    });
}
})();
