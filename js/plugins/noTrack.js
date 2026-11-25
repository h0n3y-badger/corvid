// noTrack: client-side telemetry off. The host already blocks the endpoints
// (/api/*/science, /metrics, /error-reporting-proxy, sentry); this stops the
// client from collecting and queueing in the first place. Every hook is
// optional: if Discord changes shape, the hook silently does nothing.
// SPDX-License-Identifier: MIT
const noop = () => false;

const p = corvid.definePlugin({
    name: "NoTrack",
    description: "Disable Discord's analytics, metrics and Sentry crash reporting inside the client.",
    enabledByDefault: true,
    settings: {
        analytics: { type: "boolean", default: true, description: "Drop analytics events (science) before they are queued." },
        metrics: { type: "boolean", default: true, description: "Drop performance metrics (/metrics/v2)." },
        sentry: { type: "boolean", default: true, description: "Never start the Sentry crash reporter (also skips its console/fetch/XHR instrumentation).", restartNeeded: true },
    },
    patches: [{
        // Sentry's browser init(). Discord's sentry.js entry calls it before
        // anything else; returning early means no client, no integrations,
        // no wrapped console/fetch/XHR. window.DiscordSentry then is just
        // the API namespace with no client behind it (every call a no-op).
        find: "skipBrowserExtensionCheck",
        all: true,  // Discord ships this module in more than one chunk/runtime
        replacement: {
            match: /if\(!(\i)\.skipBrowserExtensionCheck&&/,
            replace: "if($self.blockSentry())return;$&",
        },
    }],

    blockSentry() {
        return !!p.settings.store.sentry;
    },

    start() {
        const { waitFor, filters } = corvid.webpack;
        // Analytics: AnalyticsActionHandlers is a plain object whose handlers
        // the AnalyticsTrackingStore reads on every dispatch. Pin them to
        // no-ops with accessors so the store maker can't reassign them later.
        waitFor(filters.byProps("AnalyticsActionHandlers", "analyticsTrackingStoreMaker"), m => {
            const h = m.AnalyticsActionHandlers;
            if (!h || typeof h !== "object") return;
            this._handlers = h;
            for (const k of ["handleTrack", "handleConnectionOpen", "handleFingerprint", "handleSetAnalyticsToken"]) {
                let real = h[k];
                try {
                    Object.defineProperty(h, k, {
                        configurable: true,
                        enumerable: true,
                        get: () => (p.started && p.settings.store.analytics ? noop : real),
                        set: v => { real = v; },
                    });
                } catch (e) { corvid.warn("NoTrack: analytics hook", k, e); }
            }
        });
        // Metrics: a singleton with increment/distribution/_flush and a 2 min
        // flush interval. Stop the interval; shadow the methods per-instance.
        waitFor(m => typeof m?._flush === "function" && typeof m.distribution === "function"
            && typeof m.increment === "function" && "_intervalId" in m, m => {
            this._metrics = m;
            this.applyMetrics();
        });
        this.quietSentry();
    },

    stop() {
        // Analytics accessors check p.started, so they fall back to the real
        // handlers on their own.
        this.applyMetrics(false);
    },

    onSettingChange(key) {
        if (key === "metrics" && p.started) this.applyMetrics();
    },

    applyMetrics(on = p.settings.store.metrics) {
        const m = this._metrics;
        if (!m || !!on === !!this._metricsOff) return;
        this._metricsOff = !!on;
        if (on) {
            clearInterval(m._intervalId);
            m._intervalId = 0;
            m._metrics = [];
            m.increment = m.distribution = m._flush = () => {};
        } else {
            delete m.increment; delete m.distribution; delete m._flush;
            if (!m._intervalId) m._intervalId = setInterval(() => m._flush(), 12e4);
        }
    },

    // Belt and braces for when the patch didn't apply: disable whatever
    // Sentry client exists so it can't send.
    quietSentry() {
        if (!p.settings.store.sentry) return;
        try {
            const S = window.DiscordSentry;
            const client = S?.getClient?.();
            const opts = client?.getOptions?.();
            if (opts) {
                opts.enabled = false;
                opts.sampleRate = 0;
                opts.beforeSend = () => null;
                opts.beforeBreadcrumb = () => null;
            }
            S?.getCurrentScope?.()?.setUser?.(null);
        } catch (e) { corvid.warn("NoTrack: sentry", e); }
    },
});
