//! Network-level privacy: requests that are answered locally with an empty
//! 204 instead of leaving the machine. Called for every request on CEF's IO
//! thread, so it must stay cheap: no allocation beyond URL parsing.

/// Hosts whose every request is telemetry.
const BLOCKED_HOSTS: &[&str] = &[
    "sentry.io",                      // + subdomains (o64374.ingest.sentry.io)
    "meticulous-ingest.discord.tools", // session recording
    "client-analytics.braintreegateway.com",
    "litix.io", // Mux video analytics
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "hotjar.com",
];

/// Path prefixes (after `/api` and an optional `/vN`) on Discord API hosts.
const BLOCKED_API: &[&str] = &[
    "/science",                // analytics events
    "/track",                  // legacy analytics
    "/metrics",                // client metrics
    "/rtc/quality-report",     // voice/video quality telemetry
    "/promotions/ack",         // ad impressions
];

const DISCORD_HOSTS: &[&str] = &["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"];

fn host_matches(host: &str, base: &str) -> bool {
    host == base || (host.len() > base.len() && host.ends_with(base) && host.as_bytes()[host.len() - base.len() - 1] == b'.')
}

/// True if this request is telemetry corvid answers locally.
pub fn is_telemetry(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    if !matches!(u.scheme(), "https" | "http" | "wss") {
        return false;
    }
    let Some(host) = u.host_str() else { return false };
    if BLOCKED_HOSTS.iter().any(|b| host_matches(host, b)) {
        return true;
    }
    if !DISCORD_HOSTS.contains(&host) {
        return false;
    }
    let path = u.path();
    if path.starts_with("/error-reporting-proxy") {
        return true;
    }
    let Some(rest) = path.strip_prefix("/api") else { return false };
    // optional /v9 etc.
    let rest = match rest.strip_prefix("/v") {
        Some(r) => r.trim_start_matches(|c: char| c.is_ascii_digit()),
        None => rest,
    };
    BLOCKED_API
        .iter()
        .any(|p| rest.starts_with(p) && matches!(rest.as_bytes().get(p.len()), None | Some(b'/' | b'?')))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_telemetry() {
        for u in [
            "https://discord.com/api/v9/science",
            "https://discord.com/api/v10/science",
            "https://discord.com/api/science",
            "https://discord.com/api/v9/metrics/v2",
            "https://discord.com/api/v9/rtc/quality-report",
            "https://o64374.ingest.sentry.io/api/5441894/security/?sentry_key=x",
            "https://discord.com/error-reporting-proxy/web",
            "https://meticulous-ingest.discord.tools/x",
            "https://ptb.discord.com/api/v9/track",
        ] {
            assert!(is_telemetry(u), "{u}");
        }
    }

    #[test]
    fn keeps_real_traffic() {
        for u in [
            "https://discord.com/api/v9/channels/1/messages",
            "https://discord.com/api/v9/sciencefair", // not a prefix match
            "https://discord.com/assets/web.abc.js",
            "https://cdn.discordapp.com/emojis/1.webp",
            "https://notsentry.io/x",
            "https://evil.com/api/v9/science", // not Discord; irrelevant but not ours to block
            "wss://gateway.discord.gg/?v=9",
            "https://hcaptcha.com/1/api.js",
        ] {
            assert!(!is_telemetry(u), "{u}");
        }
    }
}
