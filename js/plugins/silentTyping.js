// silentTyping: don't tell others you're typing. Wraps the typing action
// creator ({startTyping, stopTyping}, which dispatches TYPING_START_LOCAL);
// the TypingStore only sends POST /channels/:id/typing in response to it.
// SPDX-License-Identifier: MIT
const p = corvid.definePlugin({
    name: "SilentTyping",
    description: "Don't send typing indicators.",
    enabledByDefault: false,
    settings: {
        active: { type: "boolean", default: true, description: "Hide typing. Turn off to send typing indicators again without disabling the plugin." },
        allowInDms: { type: "boolean", default: false, description: "Still show typing in DMs and group DMs." },
    },

    start() {
        corvid.webpack.waitFor(corvid.webpack.filters.byProps("startTyping", "stopTyping"), mod => {
            if (mod.startTyping?.$$corvidSilent) return;
            const orig = mod.startTyping;
            if (typeof orig !== "function") return;
            const wrapped = function (channelId, ...rest) {
                if (p.started && p.shouldBlock(channelId)) return;
                return orig.call(this, channelId, ...rest);
            };
            wrapped.$$corvidSilent = true;
            try {
                mod.startTyping = wrapped;
                if (mod.startTyping !== wrapped) throw new Error("not writable");
                this._restore = () => { if (mod.startTyping === wrapped) mod.startTyping = orig; };
            } catch (e) { corvid.err("SilentTyping: can't hook startTyping", e); }
        });
    },
    stop() {
        // The wrapper checks p.started, so leaving it in place is harmless;
        // restore anyway so a disabled plugin leaves nothing behind.
        this._restore?.();
        this._restore = null;
    },

    shouldBlock(channelId) {
        const s = p.settings.store;
        if (!s.active) return false;
        if (s.allowInDms) {
            try {
                const ch = corvid.stores.ChannelStore?.getChannel?.(channelId);
                if (ch && (ch.isPrivate?.() ?? (ch.type === 1 || ch.type === 3))) return false;
            } catch {}
        }
        return true;
    },
});
