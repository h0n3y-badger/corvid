// clearUrls: strip tracking parameters from links in messages you send or
// edit. Built-in rules only; nothing is downloaded.
// SPDX-License-Identifier: MIT

// Removed everywhere. Entries ending in "*" are prefixes.
const GLOBAL = [
    "utm_*", "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "ysclid",
    "twclid", "ttclid", "li_fat_id", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc",
    "__hsfp", "hsctatracking", "mkt_tok", "igshid", "igsh", "mibextid", "_ga", "_gl", "srsltid",
    "s_cid", "_openstat", "vero_id", "vero_conv", "oly_anon_id", "oly_enc_id", "rb_clickid",
    "wickedid", "ncid", "sc_cid", "cmpid", "trk_*", "spm", "scm", "_branch_match_id",
    "_branch_referrer", "__cft__*", "__tn__", "epik",
];

// Host suffix -> extra params for that site.
const SITES = {
    "youtube.com": ["si", "feature", "pp", "embeds_referring_euri", "source_ve_path"],
    "youtu.be": ["si", "feature"],
    "spotify.com": ["si", "nd", "dlsi"],
    "twitter.com": ["s", "t", "ref_src", "ref_url"],
    "x.com": ["s", "t", "ref_src", "ref_url"],
    "instagram.com": ["img_index", "ig_rid"],
    "facebook.com": ["ref", "refsrc", "hc_ref", "__xts__*", "rdid", "share_url"],
    "reddit.com": ["share_id", "ref", "ref_source", "ref_campaign", "rdt", "$deep_link", "correlation_id"],
    "tiktok.com": ["_r", "_t", "is_from_webapp", "sender_device", "is_copy_url", "share_*", "u_code", "preview_pb", "tt_from"],
    "amazon.*": ["ref", "ref_", "pd_rd_*", "pf_rd_*", "crid", "sprefix", "qid", "sr", "dib", "dib_tag",
        "_encoding", "content-id", "linkcode", "linkid", "spla"],
    "linkedin.com": ["trk", "trkinfo", "trackingid", "lipi", "rcm", "midtoken", "midsig", "otptoken"],
    "aliexpress.com": ["aff_*", "sk", "algo_*", "btsid", "ws_ab_test", "pdp_*", "gatewayadapt"],
    "ebay.*": ["_trkparms", "_trksid", "hash", "amdata", "mkcid", "mkevt", "mkrid", "campid", "toolid", "customid"],
    "twitch.tv": ["tt_medium", "tt_content"],
    "bing.com": ["form", "cvid", "pq", "sk", "sc", "qs", "sp", "ghc", "lq"],
    "google.*": ["ved", "ei", "gs_lcp", "gs_lp", "sclient", "oq", "aqs", "uact", "bih", "biw", "sxsrf", "sca_esv", "sca_upv", "iflsig", "rlz", "gs_l"],
    "medium.com": ["source"],
    "pinterest.*": ["invite_code", "sender"],
};

const toMatcher = list => {
    const exact = new Set(), prefixes = [];
    for (const k of list) k.endsWith("*") ? prefixes.push(k.slice(0, -1).toLowerCase()) : exact.add(k.toLowerCase());
    return k => exact.has(k) || prefixes.some(p => k.startsWith(p));
};
const globalMatch = toMatcher(GLOBAL);
const siteRules = Object.entries(SITES).map(([host, list]) => {
    // "amazon.*" matches amazon.<any tld chain>, "x.com" matches x.com and *.x.com
    const re = host.endsWith(".*")
        ? new RegExp(String.raw`(?:^|\.)${host.slice(0, -2).replaceAll(".", "\\.")}\.[a-z.]+$`)
        : new RegExp(String.raw`(?:^|\.)${host.replaceAll(".", "\\.")}$`);
    return [re, toMatcher(list)];
});

let extraMatch = () => false;
let extraSrc = null;

function decodeKey(k) {
    try { return decodeURIComponent(k.replaceAll("+", " ")).toLowerCase(); } catch { return k.toLowerCase(); }
}

/** Clean one URL string. Returns it unchanged unless something was removed. */
function cleanUrl(raw) {
    let url;
    try { url = new URL(raw); } catch { return raw; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
    const host = url.hostname.toLowerCase();
    const site = siteRules.filter(([re]) => re.test(host)).map(([, m]) => m);

    // Work on the raw query text so the remaining params keep their exact
    // encoding (URLSearchParams would re-encode them).
    const qi = raw.indexOf("?");
    let changed = false;
    let out = raw;
    if (qi !== -1) {
        const hi = raw.indexOf("#", qi);
        const query = raw.slice(qi + 1, hi === -1 ? undefined : hi);
        const hash = hi === -1 ? "" : raw.slice(hi);
        const kept = query.split("&").filter(part => {
            if (!part) { changed = true; return false; }
            const k = decodeKey(part.split("=", 1)[0]);
            const drop = globalMatch(k) || extraMatch(k) || site.some(m => m(k));
            if (drop) changed = true;
            return !drop;
        });
        if (changed) out = raw.slice(0, qi) + (kept.length ? "?" + kept.join("&") : "") + hash;
    }
    // Amazon puts tracking in the path: /dp/B000/ref=sr_1_1
    if (/(?:^|\.)amazon\./.test(host)) {
        const next = out.replace(/\/ref=[^/?#]*/, "");
        if (next !== out) { out = next; changed = true; }
    }
    return changed ? out : raw;
}

// Links stop at whitespace and at <> (Discord's embed-suppression brackets).
const URL_RE = /https?:\/\/[^\s<>]+/g;
// Leave code alone: fenced blocks and inline code.
const CODE_RE = /(```[\s\S]*?```|`[^`\n]*`)/;

function cleanText(text) {
    if (typeof text !== "string" || !text.includes("://")) return text;
    const parts = text.split(CODE_RE);
    for (let i = 0; i < parts.length; i += 2)  // odd indices are code
        parts[i] = parts[i].replace(URL_RE, m => {
            // Keep trailing sentence punctuation out of the URL.
            const tail = /[).,!?:;'"\]]+$/.exec(m)?.[0] ?? "";
            const core = tail ? m.slice(0, -tail.length) : m;
            return cleanUrl(core) + tail;
        });
    return parts.join("");
}

const p = corvid.definePlugin({
    name: "ClearURLs",
    description: "Remove tracking parameters (utm_*, fbclid, si, …) from links you send.",
    enabledByDefault: true,
    settings: {
        extraParams: {
            type: "string",
            default: "",
            description: "Extra parameters to strip everywhere, comma-separated (end with * for a prefix).",
        },
    },

    start() {
        this.compileExtra();
        this._offSend = corvid.messages.onPreSend((_channelId, msg) => {
            if (msg?.content) msg.content = cleanText(msg.content);
        });
        this._offEdit = corvid.messages.onPreEdit((_channelId, _messageId, msg) => {
            if (msg?.content) msg.content = cleanText(msg.content);
        });
    },
    stop() {
        this._offSend?.();
        this._offEdit?.();
    },
    onSettingChange(key) {
        if (key === "extraParams") this.compileExtra();
    },
    compileExtra() {
        const src = String(p.settings.store.extraParams ?? "");
        if (src === extraSrc) return;
        extraSrc = src;
        const list = src.split(",").map(s => s.trim()).filter(Boolean);
        extraMatch = list.length ? toMatcher(list) : () => false;
    },

    // for tests
    cleanUrl,
    cleanText,
});
