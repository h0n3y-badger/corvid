//! Theme CSS compilation: remote `@import`s are inlined and remote images
//! become data: URIs, so Discord's CSP doesn't block them and the page never
//! talks to theme hosts. Fetches happen in the host, once, into a disk cache;
//! compiling only ever reads the cache, so startup never waits on the network.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Once,
    time::{Duration, SystemTime},
};

const MAX_ASSET: u64 = 4 << 20;
const MAX_DEPTH: usize = 4;
const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);
/// Redirects followed per fetch; each hop is checked like the first URL.
const MAX_REDIRECTS: usize = 3;
/// Disk cache size kept after pruning.
const CACHE_LIMIT: u64 = 64 << 20;
/// Per compile: bytes inlined from the cache (imported CSS + data: URIs).
/// A theme can reference one 4 MB image thousands of times.
const MAX_INLINED: usize = 16 << 20;
/// Per compile: distinct remote URLs inlined or queued for fetching.
const MAX_REMOTE_URLS: usize = 256;

/// Hosts the page may load directly (Discord's own CSP allows them).
const DIRECT_HOSTS: &[&str] = &["fonts.gstatic.com", "cdn.discordapp.com", "media.discordapp.net"];

/// How fetches reach the network.
#[derive(Debug, Clone)]
pub(crate) enum Route {
    /// No corvid proxy: ureq's default (honours the http(s)_proxy env vars).
    Default,
    /// corvid's proxy, which the page uses too.
    Proxy(ureq::Proxy),
    /// A proxy is set but ureq can't use it: no fetches rather than going around it.
    Blocked,
}

#[derive(Debug, Clone)]
pub struct AssetCache {
    dir: PathBuf,
    pub allow_remote: bool,
    route: Route,
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

/// corvid's (Chromium-style) proxy setting as a ureq route. SOCKS goes out
/// with remote DNS (socks5h/socks4a), as Chromium does for socks5, so theme
/// host names don't leak to the local resolver either.
pub(crate) fn route(proxy: &str) -> Route {
    let proxy = proxy.trim();
    if proxy.is_empty() {
        return Route::Default;
    }
    let (scheme, rest) = proxy.split_once("://").unwrap_or(("http", proxy));
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "http" => "http",
        "https" => "https",
        "socks" | "socks5" | "socks5h" => "socks5h",
        "socks4" | "socks4a" => "socks4a",
        _ => "",
    };
    match ureq::Proxy::new(&format!("{scheme}://{rest}")) {
        Ok(p) if !scheme.is_empty() => Route::Proxy(p),
        _ => {
            log::warn!("theme assets: can't use proxy {proxy}; remote assets won't be fetched");
            Route::Blocked
        }
    }
}

/// Theme assets are fetched by the host, outside the page's sandbox: only
/// https to public-looking names, never LAN/loopback hosts or IP literals a
/// theme (or a redirect) could point at.
fn check_remote(u: &url::Url) -> Result<(), String> {
    if u.scheme() != "https" {
        return Err(format!("refusing non-https theme asset {u}"));
    }
    let ok = match u.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.strip_suffix('.').unwrap_or(d).to_ascii_lowercase();
            d.contains('.')
                && ![".localhost", ".local", ".lan", ".home.arpa", ".internal", ".localdomain"]
                    .iter()
                    .any(|s| d.ends_with(s))
        }
        _ => false, // IP literals (the url crate also normalises 0x7f.1 etc. to these)
    };
    if ok { Ok(()) } else { Err(format!("refusing theme asset on a local or numeric host: {u}")) }
}

/// `image/<subtype>`, lowercased, if `mime` is one; anything else (and
/// anything that would break out of `url("data:…")`) is refused.
fn image_mime(mime: &str) -> Option<String> {
    let m = mime.to_ascii_lowercase();
    let sub = m.strip_prefix("image/")?;
    (!sub.is_empty() && sub.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".+-".contains(&b))).then_some(m)
}

impl AssetCache {
    /// `proxy` is corvid's proxy setting (`host.proxy`); fetches use it too.
    pub fn new(dir: PathBuf, allow_remote: bool, proxy: &str) -> Self {
        if allow_remote {
            // Keep the cache bounded: once per process, off the startup path.
            static PRUNE: Once = Once::new();
            let d = dir.clone();
            PRUNE.call_once(|| {
                let _ = std::thread::Builder::new().name("corvid-asset-prune".into()).spawn(move || prune(&d, CACHE_LIMIT));
            });
        }
        Self { dir, allow_remote, route: route(proxy) }
    }

    fn path(&self, url: &str) -> PathBuf {
        self.dir.join(format!("{:016x}", fnv64(url)))
    }

    /// Cached asset and whether it is stale. File = "<mime>\n<url>\n<bytes>".
    pub fn get(&self, url: &str) -> Option<(Asset, bool)> {
        self.get_if(url, |_| true)
    }

    /// Like `get`, but the body is read only when `want(mime)` (otherwise
    /// `data` is empty): a cached font/other asset that compile would drop
    /// anyway costs two short reads instead of up to `MAX_ASSET` bytes.
    pub fn get_if(&self, url: &str, want: impl FnOnce(&str) -> bool) -> Option<(Asset, bool)> {
        use std::io::BufRead;
        let f = fs::File::open(self.path(url)).ok()?;
        let stale = f
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > STALE_AFTER);
        let mut r = std::io::BufReader::new(f);
        let mut line = Vec::new();
        r.read_until(b'\n', &mut line).ok()?;
        if line.pop() != Some(b'\n') {
            return None;
        }
        let mime = String::from_utf8(std::mem::take(&mut line)).ok()?;
        r.read_until(b'\n', &mut line).ok()?;
        if line.pop() != Some(b'\n') || line != url.as_bytes() {
            return None; // truncated or hash collision
        }
        let mut data = Vec::new();
        if want(&mime) {
            r.read_to_end(&mut data).ok()?;
        }
        Some((Asset { mime, data }, stale))
    }

    /// Download into the cache (blocking; call from a worker thread).
    pub fn fetch(&self, url: &str) -> Result<(), String> {
        let mut u = url::Url::parse(url).map_err(|e| e.to_string())?;
        check_remote(&u)?;
        let mut cfg = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .user_agent("Mozilla/5.0")
            .https_only(true)
            // followed by hand below, so every hop gets `check_remote`
            .max_redirects(0);
        match &self.route {
            Route::Default => {}
            Route::Proxy(p) => cfg = cfg.proxy(Some(p.clone())),
            Route::Blocked => return Err(format!("{url}: not fetched (proxy unusable)")),
        }
        let agent = cfg.build().new_agent();
        let mut hops = 0;
        let resp = loop {
            let resp = agent.get(u.as_str()).call().map_err(|e| format!("{url}: {e}"))?;
            if !resp.status().is_redirection() {
                break resp;
            }
            hops += 1;
            let loc = resp.headers().get("location").and_then(|v| v.to_str().ok());
            let next = loc.and_then(|l| u.join(l).ok()).ok_or_else(|| format!("{url}: bad redirect"))?;
            if hops > MAX_REDIRECTS {
                return Err(format!("{url}: too many redirects"));
            }
            check_remote(&next).map_err(|e| format!("{url}: redirect: {e}"))?;
            u = next;
        };
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

/// Delete the least recently fetched cache entries beyond `limit` bytes.
fn prune(dir: &Path, limit: u64) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files = Vec::new();
    for e in rd.flatten() {
        // entries only (16 hex digits), not write_atomic's in-flight .tmp files
        let name = e.file_name();
        if !name.to_str().is_some_and(|n| n.len() == 16 && n.bytes().all(|b| b.is_ascii_hexdigit())) {
            continue;
        }
        let Ok(m) = e.metadata() else { continue };
        if m.is_file() {
            files.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), e.path()));
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, len, p) in files {
        if total <= limit {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}

/// Result of compiling: CSS plus URLs that should be (re)fetched.
pub struct Compiled {
    pub css: String,
    pub fetch: Vec<String>,
}

/// State shared by one compile's recursion.
struct Ctx<'a> {
    cache: &'a AssetCache,
    fetch: Vec<String>,
    /// data: URI per image URL, so an image referenced N times is read and
    /// base64-encoded once per compile.
    memo: HashMap<String, String>,
    /// Imports already inlined: each at most once, so a sheet importing
    /// another twice per level can't blow up exponentially with depth.
    imported: HashSet<String>,
    /// Distinct remote URLs seen (inlined or queued).
    remote: HashSet<String>,
    /// Bytes inlined so far (see `MAX_INLINED`).
    inlined: usize,
    capped: bool,
}

impl Ctx<'_> {
    /// Whether `key` may be used: within the URL budget, and the output
    /// budget not yet spent.
    fn admit(&mut self, key: &str) -> bool {
        if self.inlined > MAX_INLINED {
            self.cap("inlined size");
            return false;
        }
        if !self.remote.contains(key) {
            if self.remote.len() >= MAX_REMOTE_URLS {
                self.cap("remote URL count");
                return false;
            }
            self.remote.insert(key.to_owned());
        }
        true
    }

    fn cap(&mut self, what: &str) {
        if !self.capped {
            self.capped = true;
            log::warn!("theme: {what} limit reached; further remote assets left out");
        }
    }
}

pub fn compile(css: &str, base: Option<&url::Url>, cache: &AssetCache) -> Compiled {
    let mut cx = Ctx {
        cache,
        fetch: Vec::new(),
        memo: HashMap::new(),
        imported: HashSet::new(),
        remote: HashSet::new(),
        inlined: 0,
        capped: false,
    };
    let css = compile_inner(css, base, 0, &mut cx);
    let mut fetch = cx.fetch;
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

fn compile_inner(css: &str, base: Option<&url::Url>, depth: usize, cx: &mut Ctx) -> String {
    let cache = cx.cache;
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    // Absolute offsets of the next `@import` / `url(`, re-searched only once
    // the cursor has passed them. Re-running both finds every iteration
    // rescanned to the end for the rarer token: O(n*k) for a theme with k
    // `url(`s and no (later) `@import`.
    let (mut next_imp, mut next_url) = (css.find("@import"), css.find("url("));
    loop {
        let off = css.len() - rest.len();
        if next_imp.is_some_and(|i| i < off) {
            next_imp = rest.find("@import").map(|i| i + off);
        }
        if next_url.is_some_and(|u| u < off) {
            next_url = rest.find("url(").map(|u| u + off);
        }
        let imp = next_imp.map(|i| i - off);
        let url = next_url.map(|u| u - off);
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
                    // Repeats and over-budget imports are left out (like a
                    // not-yet-fetched one), never handed to the page.
                    if !cx.imported.contains(&key) && cx.admit(&key) {
                        match cache.get(&key) {
                            Some((asset, stale)) => {
                                if stale {
                                    cx.fetch.push(key.clone());
                                }
                                cx.imported.insert(key.clone());
                                cx.inlined += asset.data.len();
                                let text = String::from_utf8_lossy(&asset.data);
                                let inner = compile_inner(&text, Some(&u), depth + 1, cx);
                                if media.is_empty() {
                                    out.push_str(&format!("/* {key} */\n{inner}\n"));
                                } else {
                                    out.push_str(&format!("/* {key} */\n@media {media} {{\n{inner}\n}}\n"));
                                }
                            }
                            None => cx.fetch.push(key), // left out until fetched
                        }
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
                    if !cx.admit(&key) {
                        None
                    } else if let Some(r) = cx.memo.get(&key) {
                        cx.inlined += r.len();
                        out.push_str(r);
                        rest = &rest[close + 1..];
                        continue;
                    } else {
                        match cache.get_if(&key, |m| image_mime(m).is_some()) {
                            Some((asset, stale)) => match image_mime(&asset.mime) {
                                Some(mime) => {
                                    if stale {
                                        cx.fetch.push(key.clone());
                                    }
                                    let r = format!("url(\"data:{mime};base64,{}\")", base64(&asset.data));
                                    cx.inlined += r.len();
                                    cx.memo.insert(key, r.clone());
                                    Some(r)
                                }
                                None => None, // fonts etc.: data: isn't allowed by CSP anyway
                            },
                            None => {
                                cx.fetch.push(key);
                                None
                            }
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
        let c = AssetCache::new(d, true, "");
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
    fn repeated_image_and_late_import() {
        let c = cache_with(&[
            ("https://r.example/i.png", "image/png", b"PNG"),
            ("https://r.example/late.css", "text/css", b".late{}"),
            ("https://r.example/f.woff2", "font/woff2", b"FONTDATA"),
        ]);
        let mut src = String::new();
        for i in 0..50 {
            src.push_str(&format!(".c{i}{{background:url(https://r.example/i.png) no-repeat}}"));
        }
        src.push_str("@font-face{src:url(https://r.example/f.woff2)}@import url(https://r.example/late.css);.end{}");
        let r = compile(&src, None, &c);
        assert_eq!(r.css.matches("url(\"data:image/png;base64,UE5H\") no-repeat").count(), 50);
        assert!(r.css.contains("src:url(https://r.example/f.woff2)"));
        assert!(r.css.contains(".late{}") && r.css.ends_with(".end{}"));
        assert!(r.fetch.is_empty());
        let (a, _) = c.get_if("https://r.example/f.woff2", |m| m.starts_with("image/")).unwrap();
        assert!(a.data.is_empty() && a.mime == "font/woff2");
        assert_eq!(c.get("https://r.example/f.woff2").unwrap().0.data, b"FONTDATA");
    }

    #[test]
    fn direct_hosts_untouched() {
        let c = cache_with(&[("https://q.example/x", "text/plain", b"")]);
        let src = "@import url(https://fonts.gstatic.com/a.css); .f{src:url(https://fonts.gstatic.com/x.woff2)}";
        let r = compile(src, None, &c);
        assert_eq!(r.css, src);
    }

    #[test]
    fn image_mime_cannot_break_out_of_data_uri() {
        let c = cache_with(&[
            ("https://m.example/ok.png", "IMAGE/PNG", b"PNG"),
            ("https://m.example/evil.png", "image/png\");}body{background:url(https://x.example/leak", b"PNG"),
            ("https://m.example/svg", "image/svg+xml", b"<svg/>"),
        ]);
        let r = compile(
            ".a{background:url(https://m.example/ok.png)}.b{background:url(https://m.example/evil.png)}.c{background:url(https://m.example/svg)}",
            None,
            &c,
        );
        assert!(r.css.contains("url(\"data:image/png;base64,UE5H\")"), "{}", r.css);
        assert!(r.css.contains("url(\"data:image/svg+xml;base64,"));
        assert!(r.css.contains(".b{background:url(https://m.example/evil.png)}"), "{}", r.css);
        assert!(!r.css.contains("x.example"));
        assert_eq!(image_mime("image/"), None);
        assert_eq!(image_mime("text/css"), None);
    }

    #[test]
    fn imports_inline_once_so_nesting_stays_linear() {
        // each level imports the next twice: 2^depth copies without dedup
        let c = cache_with(&[
            ("https://n.example/0.css", "text/css", b"@import url(1.css);@import url(1.css);.l0{}"),
            ("https://n.example/1.css", "text/css", b"@import url(2.css);@import url(2.css);.l1{}"),
            ("https://n.example/2.css", "text/css", b"@import url(3.css);@import url(3.css);.l2{}"),
            ("https://n.example/3.css", "text/css", b".l3{}"),
        ]);
        let r = compile("@import url(https://n.example/0.css);@import url(https://n.example/0.css);", None, &c);
        for l in [".l0{}", ".l1{}", ".l2{}", ".l3{}"] {
            assert_eq!(r.css.matches(l).count(), 1, "{l}: {}", r.css);
        }
        assert!(r.fetch.is_empty());
    }

    #[test]
    fn inlined_size_is_capped() {
        let big = vec![0u8; 3 << 20]; // ~4 MB as base64
        let c = cache_with(&[("https://s.example/big.png", "image/png", &big)]);
        let mut src = String::new();
        for i in 0..20 {
            src.push_str(&format!(".c{i}{{background:url(https://s.example/big.png)}}"));
        }
        let r = compile(&src, None, &c);
        assert!(r.css.len() < MAX_INLINED + (5 << 20), "{}", r.css.len());
        assert!(r.css.contains("url(https://s.example/big.png)")); // later ones left as is
    }

    #[test]
    fn remote_url_count_is_capped() {
        let c = cache_with(&[("https://u.example/none", "text/plain", b"")]);
        let mut src = String::new();
        for i in 0..1000 {
            src.push_str(&format!(".c{i}{{background:url(https://u.example/{i}.png)}}"));
        }
        assert_eq!(compile(&src, None, &c).fetch.len(), MAX_REMOTE_URLS);
    }

    #[test]
    fn only_public_https_hosts_are_fetched() {
        for u in ["https://raw.githubusercontent.com/a/b.css", "https://example.com./x.png", "https://fonts.googleapis.com/css2?f=x"] {
            assert!(check_remote(&url::Url::parse(u).unwrap()).is_ok(), "{u}");
        }
        for u in [
            "http://example.com/a.css",
            "https://127.0.0.1/a.css",
            "https://0x7f.1/a.css",
            "https://[::1]/a.css",
            "https://192.168.1.1/a.css",
            "https://localhost/a.css",
            "https://LOCALHOST./a.css",
            "https://foo.localhost/a.css",
            "https://nas/a.css",
            "https://nas.local/a.css",
            "https://router.lan/a.css",
            "https://x.home.arpa/a.css",
            "https://svc.internal/a.css",
        ] {
            assert!(check_remote(&url::Url::parse(u).unwrap()).is_err(), "{u}");
        }
    }

    #[test]
    fn proxy_routes() {
        assert!(matches!(route(""), Route::Default));
        for p in ["socks5://127.0.0.1:9050", "socks5h://127.0.0.1:9050", "socks4://h:1080", "http://127.0.0.1:8080", "127.0.0.1:8080"] {
            assert!(matches!(route(p), Route::Proxy(_)), "{p}");
        }
        assert!(matches!(route("socks5://127.0.0.1:9050").clone(), Route::Proxy(p) if p.protocol() == ureq::ProxyProtocol::Socks5h));
        for p in ["quic://x:1", "socks5://a:1;http://b:2"] {
            assert!(matches!(route(p), Route::Blocked), "{p}");
        }
    }

    #[test]
    fn blocked_proxy_fails_closed() {
        let c = AssetCache::new(std::env::temp_dir().join("corvid-assets-blocked"), true, "quic://x:1");
        assert!(c.fetch("https://example.com/a.css").unwrap_err().contains("proxy"));
    }

    #[test]
    fn prune_drops_oldest_entries_only() {
        let d = std::env::temp_dir().join(format!("corvid-asset-prune-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let now = SystemTime::now();
        for (i, name) in ["000000000000000a", "000000000000000b", "000000000000000c"].iter().enumerate() {
            let p = d.join(name);
            fs::write(&p, vec![0u8; 100]).unwrap();
            let f = fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(now - Duration::from_secs(100 - i as u64 * 10)).unwrap();
        }
        fs::write(d.join("000000000000000d.tmp"), vec![0u8; 100]).unwrap();
        prune(&d, 150);
        let mut left: Vec<_> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["000000000000000c", "000000000000000d.tmp"]);
        fs::remove_dir_all(&d).unwrap();
    }
}
