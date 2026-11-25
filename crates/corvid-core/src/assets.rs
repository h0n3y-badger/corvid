//! Theme CSS compilation: remote `@import`s are inlined and remote images
//! become data: URIs, so Discord's CSP doesn't block them and the page never
//! talks to theme hosts. Fetches happen in the host, once, into a disk cache;
//! compiling only ever reads the cache, so startup never waits on the network.

use std::{
    fs,
    io::Read,
    path::PathBuf,
    time::{Duration, SystemTime},
};

const MAX_ASSET: u64 = 4 << 20;
const MAX_DEPTH: usize = 4;
const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

/// Hosts the page may load directly (Discord's own CSP allows them).
const DIRECT_HOSTS: &[&str] = &["fonts.gstatic.com", "cdn.discordapp.com", "media.discordapp.net"];

#[derive(Debug, Clone)]
pub struct AssetCache {
    dir: PathBuf,
    pub allow_remote: bool,
}

pub struct Asset {
    pub mime: String,
    pub data: Vec<u8>,
}

fn fnv64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

impl AssetCache {
    pub fn new(dir: PathBuf, allow_remote: bool) -> Self {
        Self { dir, allow_remote }
    }

    fn path(&self, url: &str) -> PathBuf {
        self.dir.join(format!("{:016x}", fnv64(url)))
    }

    /// Cached asset and whether it is stale. File = "<mime>\n<url>\n<bytes>".
    pub fn get(&self, url: &str) -> Option<(Asset, bool)> {
        let p = self.path(url);
        let raw = fs::read(&p).ok()?;
        let mut it = raw.splitn(3, |&b| b == b'\n');
        let mime = String::from_utf8(it.next()?.to_vec()).ok()?;
        let stored_url = it.next()?;
        if stored_url != url.as_bytes() {
            return None; // hash collision
        }
        let data = it.next()?.to_vec();
        let stale = fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_AFTER);
        Some((Asset { mime, data }, stale))
    }

    /// Download into the cache (blocking; call from a worker thread).
    pub fn fetch(&self, url: &str) -> Result<(), String> {
        let u = url::Url::parse(url).map_err(|e| e.to_string())?;
        if u.scheme() != "https" {
            return Err(format!("refusing non-https theme asset {url}"));
        }
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .user_agent("Mozilla/5.0")
            .build()
            .new_agent();
        let resp = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
        let mime = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_owned();
        let mut data = Vec::new();
        resp.into_body()
            .into_reader()
            .take(MAX_ASSET + 1)
            .read_to_end(&mut data)
            .map_err(|e| format!("{url}: {e}"))?;
        if data.len() as u64 > MAX_ASSET {
            return Err(format!("{url}: larger than {} MB, skipped", MAX_ASSET >> 20));
        }
        let mut file = format!("{mime}\n{url}\n").into_bytes();
        file.extend_from_slice(&data);
        crate::util::write_atomic(&self.path(url), &file).map_err(|e| e.to_string())
    }
}

/// Result of compiling: CSS plus URLs that should be (re)fetched.
pub struct Compiled {
    pub css: String,
    pub fetch: Vec<String>,
}

pub fn compile(css: &str, base: Option<&url::Url>, cache: &AssetCache) -> Compiled {
    let mut fetch = Vec::new();
    let css = compile_inner(css, base, cache, 0, &mut fetch);
    fetch.sort();
    fetch.dedup();
    Compiled { css, fetch }
}

fn resolve(raw: &str, base: Option<&url::Url>) -> Option<url::Url> {
    let raw = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    let u = match base {
        Some(b) => b.join(raw).ok()?,
        None => url::Url::parse(raw).ok()?,
    };
    matches!(u.scheme(), "https" | "http").then_some(u)
}

fn direct(u: &url::Url) -> bool {
    u.host_str().is_some_and(|h| DIRECT_HOSTS.contains(&h))
}

fn compile_inner(css: &str, base: Option<&url::Url>, cache: &AssetCache, depth: usize, fetch: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    loop {
        // next @import or url(
        let imp = rest.find("@import");
        let url = rest.find("url(");
        let at = match (imp, url) {
            (None, None) => break,
            (Some(i), Some(u)) => i.min(u),
            (Some(i), None) => i,
            (None, Some(u)) => u,
        };
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if Some(at) == imp {
            // @import <url(..)|"..."> [media] ;
            let Some(end) = rest.find(';') else { break };
            let stmt = &rest["@import".len()..end];
            let s = stmt.trim_start();
            let (target, media) = if let Some(inner) = s.strip_prefix("url(") {
                match inner.find(')') {
                    Some(c) => (&inner[..c], inner[c + 1..].trim()),
                    None => ("", ""),
                }
            } else if let Some(q) = s.chars().next().filter(|c| *c == '"' || *c == '\'') {
                match s[1..].find(q) {
                    Some(c) => (&s[1..c + 1], s[c + 2..].trim()),
                    None => ("", ""),
                }
            } else {
                ("", "")
            };
            match resolve(target, base) {
                Some(u) if cache.allow_remote && depth < MAX_DEPTH && !direct(&u) => {
                    let key = u.as_str().to_owned();
                    match cache.get(&key) {
                        Some((asset, stale)) => {
                            if stale {
                                fetch.push(key.clone());
                            }
                            let text = String::from_utf8_lossy(&asset.data);
                            let inner = compile_inner(&text, Some(&u), cache, depth + 1, fetch);
                            if media.is_empty() {
                                out.push_str(&format!("/* {key} */\n{inner}\n"));
                            } else {
                                out.push_str(&format!("/* {key} */\n@media {media} {{\n{inner}\n}}\n"));
                            }
                        }
                        None => fetch.push(key), // left out until fetched
                    }
                }
                _ => out.push_str(&rest[..=end]), // keep as is (CSP decides)
            }
            rest = &rest[end + 1..];
        } else {
            // url( ... )
            let Some(close) = rest.find(')') else { break };
            let target = &rest[4..close];
            let replaced = match resolve(target, base) {
                Some(u) if cache.allow_remote && !direct(&u) => {
                    let key = u.as_str().to_owned();
                    match cache.get(&key) {
                        Some((asset, stale)) if asset.mime.starts_with("image/") => {
                            if stale {
                                fetch.push(key);
                            }
                            Some(format!("url(\"data:{};base64,{}\")", asset.mime, base64(&asset.data)))
                        }
                        Some(_) => None, // fonts etc.: data: isn't allowed by CSP anyway
                        None => {
                            fetch.push(key);
                            None
                        }
                    }
                }
                // relative url inside a remote stylesheet: make it absolute
                Some(u) if base.is_some() => Some(format!("url(\"{u}\")")),
                _ => None,
            };
            match replaced {
                Some(r) => out.push_str(&r),
                None => out.push_str(&rest[..=close]),
            }
            rest = &rest[close + 1..];
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_with(entries: &[(&str, &str, &[u8])]) -> AssetCache {
        let d = std::env::temp_dir().join(format!("corvid-assets-{}-{}", std::process::id(), fnv64(entries.first().map_or("", |e| e.0))));
        let c = AssetCache::new(d, true);
        for (url, mime, data) in entries {
            let mut f = format!("{mime}\n{url}\n").into_bytes();
            f.extend_from_slice(data);
            crate::util::write_atomic(&c.path(url), &f).unwrap();
        }
        c
    }

    #[test]
    fn base64_matches_rfc() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn inlines_cached_imports_and_images() {
        let c = cache_with(&[
            ("https://t.example/theme.css", "text/css", b"@import url('sub.css');\n.a{background:url(img/bg.png)}"),
            ("https://t.example/sub.css", "text/css", b".b{color:red}"),
            ("https://t.example/img/bg.png", "image/png", b"PNG"),
        ]);
        let r = compile("@import url(\"https://t.example/theme.css\");\n.local{}", None, &c);
        assert!(r.fetch.is_empty(), "{:?}", r.fetch);
        assert!(r.css.contains(".b{color:red}"));
        assert!(r.css.contains("data:image/png;base64,UE5H"));
        assert!(r.css.contains(".local{}"));
        assert!(!r.css.contains("@import"));
    }

    #[test]
    fn missing_assets_are_requested_not_waited_for() {
        let c = cache_with(&[("https://x.example/none", "text/plain", b"")]);
        let r = compile("@import \"https://y.example/a.css\" screen;\n.x{background:url('https://y.example/b.png')}", None, &c);
        assert_eq!(r.fetch, vec!["https://y.example/a.css", "https://y.example/b.png"]);
        assert!(!r.css.contains("@import"));
        assert!(r.css.contains("url('https://y.example/b.png')"));
    }

    #[test]
    fn remote_disabled_leaves_css_alone() {
        let mut c = cache_with(&[("https://z.example/a.css", "text/css", b".z{}")]);
        c.allow_remote = false;
        let src = "@import url(https://z.example/a.css);";
        let r = compile(src, None, &c);
        assert_eq!(r.css, src);
        assert!(r.fetch.is_empty());
    }

    #[test]
    fn direct_hosts_untouched() {
        let c = cache_with(&[("https://q.example/x", "text/plain", b"")]);
        let src = "@import url(https://fonts.gstatic.com/a.css); .f{src:url(https://fonts.gstatic.com/x.woff2)}";
        let r = compile(src, None, &c);
        assert_eq!(r.css, src);
    }
}
