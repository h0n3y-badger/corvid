// anonymiseFileNames: upload files under random names (extension kept).
// Hook: the upload-payload helper {getUploadPayload(upload)} that every
// CloudUpload calls before asking Discord for an upload URL. Its result's
// `filename` is what the server stores; upload.filename is what the message
// attachment entry carries afterwards. Both get the same anonymous name.
// SPDX-License-Identifier: MIT
const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const names = new WeakMap();  // upload -> chosen name (payload is rebuilt on URL refresh)

function randomName(len) {
    const n = Math.max(1, Math.min(64, len | 0));
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    let s = "";
    for (const b of bytes) s += CHARS[b % CHARS.length];
    return s;
}

function extOf(name) {
    // Keep compound archive extensions; otherwise the last one (max 10 chars).
    const m = /\.(tar\.(?:gz|bz2|xz|zst))$/i.exec(name) ?? /\.([A-Za-z0-9]{1,10})$/.exec(name);
    return m ? "." + m[1] : "";
}

const p = corvid.definePlugin({
    name: "AnonymiseFileNames",
    description: "Replace the names of files you upload with random ones (the extension is kept).",
    enabledByDefault: false,
    settings: {
        method: {
            type: "select",
            default: "random",
            description: "New file name",
            options: [
                { label: "Random characters", value: "random" },
                { label: "Upload timestamp", value: "timestamp" },
                { label: "Fixed name", value: "fixed" },
            ],
        },
        randomLength: { type: "number", default: 8, description: "Length of random names." },
        fixedName: { type: "string", default: "file", description: "Name used by the \"Fixed name\" method." },
    },

    start() {
        corvid.webpack.waitFor(corvid.webpack.filters.byProps("getUploadPayload"), mod => {
            const orig = mod.getUploadPayload;
            if (typeof orig !== "function" || orig.$$corvidAnon) return;
            const wrapped = function (upload, ...rest) {
                const r = orig.call(this, upload, ...rest);
                if (!p.started) return r;
                // It is sync today but awaited by callers; handle both.
                return r && typeof r.then === "function" ? r.then(v => p.rename(upload, v)) : p.rename(upload, r);
            };
            wrapped.$$corvidAnon = true;
            try {
                mod.getUploadPayload = wrapped;
                if (mod.getUploadPayload !== wrapped) throw new Error("not writable");
                this._restore = () => { if (mod.getUploadPayload === wrapped) mod.getUploadPayload = orig; };
            } catch (e) { corvid.err("AnonymiseFileNames: can't hook getUploadPayload", e); }
        });
    },
    stop() {
        this._restore?.();
        this._restore = null;
    },

    rename(upload, payload) {
        try {
            if (!payload || typeof payload.filename !== "string" || !payload.filename) return payload;
            let name = upload && typeof upload === "object" ? names.get(upload) : undefined;
            if (!name) {
                name = this.makeName(payload.filename);
                if (upload && typeof upload === "object") names.set(upload, name);
            }
            payload.filename = name;
            // The message's attachment list is built from upload.filename.
            if (upload && typeof upload === "object" && "filename" in upload) {
                if (typeof upload.setFilename === "function") upload.setFilename(name);
                else upload.filename = name;
            }
        } catch (e) { corvid.err("AnonymiseFileNames", e); }
        return payload;
    },

    makeName(original) {
        const s = p.settings.store;
        const ext = extOf(original);
        let base;
        switch (s.method) {
            case "timestamp": base = String(Date.now()); break;
            case "fixed": base = String(s.fixedName || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 64) || "file"; break;
            default: base = randomName(s.randomLength);
        }
        // Discord marks spoilers by the SPOILER_ prefix on the stored name.
        if (/^SPOILER_/.test(original)) base = "SPOILER_" + base;
        return base + ext;
    },
});
