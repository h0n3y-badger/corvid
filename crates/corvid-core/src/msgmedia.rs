//! Media kept for the message log.
//!
//! - Audio attachments (incl. voice messages) are downloaded when a message
//!   is first seen and kept on disk in `message-log/audio/<attachmentId>.<ext>`
//!   (the CDN may purge them on delete). Index: `audio/index.json`.
//! - Videos (attachments, embed videos, gifv) are downloaded the same way but
//!   only for this session, into `message-log/session-video/`, which is wiped
//!   at startup and on clean exit.
//! - Images are never downloaded.
//!
//! Downloads: https only, Discord CDN / media proxy hosts only, no redirects,
//! corvid's proxy setting (like theme assets), per-file size caps, two at a
//! time. Each kind has a total cap with LRU eviction where files of deleted
//! messages go last. Files are only ever served back as media with a type
//! from their (whitelisted) extension; nothing here executes them.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::{
    assets::{Route, route},
    msglog::sf,
};

pub const AUDIO_CAP: u64 = 2 << 30;
pub const VIDEO_CAP: u64 = 2 << 30;
const WORKERS: usize = 2;
const MAX_QUEUE: usize = 512;

const AUDIO_EXTS: &[&str] = &["mp3", "ogg", "opus", "oga", "wav", "flac", "m4a", "aac"];
const VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "m4v"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Audio,
    Video,
}

#[derive(Debug, Clone, Copy)]
pub struct MediaConfig {
    pub audio: bool,
    pub audio_max: u64,
    pub video: bool,
    pub video_max: u64,
}

impl Default for MediaConfig {
    fn default() -> Self {
        // Nothing is downloaded until the plugin sends its settings.
        Self { audio: false, audio_max: 50 << 20, video: false, video_max: 100 << 20 }
    }
}

#[derive(Debug, Default)]
pub struct MediaStats {
    pub audio_bytes: u64,
    pub audio_files: usize,
    pub video_bytes: u64,
    pub video_files: usize,
}

/// A cached file to serve for a request.
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    pub path: PathBuf,
    pub ext: String,
    pub kind: Kind,
}

impl Cached {
    /// Content type for the raw file (never HTML).
    pub fn mime(&self) -> &'static str {
        mime(&self.ext)
    }

    /// Needs ffmpeg before the minimal CEF build can play it (H.264/HEVC/AAC containers).
    pub fn needs_transcode(&self) -> bool {
        matches!(self.ext.as_str(), "m4a" | "aac" | "mp4" | "mov" | "m4v")
    }
}

pub fn mime(ext: &str) -> &'static str {
    match ext {
        "mp3" => "audio/mpeg",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn host_ok(host: &str) -> bool {
    host == "cdn.discordapp.com"
        || host == "media.discordapp.net"
        || host
            .strip_prefix("images-ext-")
            .and_then(|r| r.strip_suffix(".discordapp.net"))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// What a media URL refers to: cache key, attachment id (if an attachment)
/// and the lowercased extension.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub key: String,
    pub att: Option<String>,
    pub ext: String,
}

/// Parse a Discord media URL. Attachments are keyed by
/// `<channel>/<attachment>/<filename>` so cdn.discordapp.com and
/// media.discordapp.net, and any signed query, map to the same file.
pub fn target(url: &str) -> Option<Target> {
    let u = url::Url::parse(url).ok()?;
    if u.scheme() != "https" || u.port().is_some() || !u.username().is_empty() {
        return None;
    }
    let host = u.host_str()?;
    if !host_ok(host) {
        return None;
    }
    let path = u.path();
    let last = path.rsplit('/').next()?;
    let ext = last.rsplit_once('.')?.1.to_ascii_lowercase();
    if !AUDIO_EXTS.contains(&ext.as_str()) && !VIDEO_EXTS.contains(&ext.as_str()) {
        return None;
    }
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if let ["attachments", ch, att, name] = segs.as_slice()
        && sf(ch).is_some()
        && sf(att).is_some()
        && !name.is_empty()
    {
        return Some(Target { key: format!("{ch}/{att}/{name}"), att: Some((*att).to_owned()), ext });
    }
    if host.starts_with("images-ext-") {
        return Some(Target { key: format!("{host}{path}"), att: None, ext });
    }
    None
}

/// Allocation-free pre-check for `lookup`, which runs for every media/XHR
/// GET (all Discord API calls): false only when `target` would reject the
/// (canonical, CEF-supplied) URL. Unusual authorities (escapes, non-ASCII,
/// control bytes) fall through to the full parser; a false "no" here would
/// only mean a cache miss.
fn maybe_target(url: &str) -> bool {
    let b = url.as_bytes();
    if b.len() < 8 || !b[..8].eq_ignore_ascii_case(b"https://") {
        return false;
    }
    let rest = &b[8..];
    let end = rest.iter().position(|&c| matches!(c, b'/' | b'?' | b'#' | b'\\')).unwrap_or(rest.len());
    let auth = &rest[..end];
    auth.iter().any(|&c| c == b'%' || !c.is_ascii() || c <= b' ') || auth.windows(10).any(|w| w.eq_ignore_ascii_case(b"discordapp"))
}

fn fnv64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Serialized as-is into `audio/index.json`.
#[derive(Debug, Clone, serde::Serialize)]
struct Entry {
    file: String,
    ext: String,
    size: u64,
    used: u64,
    deleted: bool,
    msg: String,
}

#[derive(Debug, Clone)]
struct Job {
    kind: Kind,
    url: String,
    t: Target,
    msg: String,
    max: u64,
}

#[derive(Default)]
struct State {
    audio: HashMap<String, Entry>,
    video: HashMap<String, Entry>,
    audio_loaded: bool,
    queue: VecDeque<Job>,
    /// Queued or downloading keys.
    busy: HashSet<String>,
    /// Failed this session: not retried.
    failed: HashSet<String>,
    workers: usize,
    /// Messages already deleted (their media is evicted last).
    deleted_msgs: HashSet<String>,
    /// Downloads not yet in index.json (saves are batched, see `ingest`).
    dirty: bool,
    last_save: Option<std::time::Instant>,
}

pub struct MediaCache {
    audio_dir: PathBuf,
    video_dir: PathBuf,
    route: Route,
    cfg: Mutex<MediaConfig>,
    st: Mutex<State>,
    me: Mutex<Weak<MediaCache>>,
    pub(crate) audio_cap: u64,
    pub(crate) video_cap: u64,
}

impl MediaCache {
    /// `dir` is the message-log dir. Wipes the session video cache.
    pub fn new(dir: PathBuf, proxy: &str) -> Self {
        let m = Self {
            audio_dir: dir.join("audio"),
            video_dir: dir.join("session-video"),
            route: route(proxy),
            cfg: Mutex::new(MediaConfig::default()),
            st: Mutex::new(State::default()),
            me: Mutex::new(Weak::new()),
            audio_cap: AUDIO_CAP,
            video_cap: VIDEO_CAP,
        };
        m.wipe_session();
        m
    }

    pub fn configure(self: &Arc<Self>, cfg: MediaConfig) {
        *self.me.lock().unwrap() = Arc::downgrade(self);
        *self.cfg.lock().unwrap() = cfg;
    }

    pub fn wipe_session(&self) {
        let _ = fs::remove_dir_all(&self.video_dir);
        self.st.lock().unwrap().video.clear();
    }

    fn dir(&self, k: Kind) -> &Path {
        match k {
            Kind::Audio => &self.audio_dir,
            Kind::Video => &self.video_dir,
        }
    }

    fn load_audio(&self, st: &mut State) {
        if st.audio_loaded {
            return;
        }
        st.audio_loaded = true;
        let Ok(raw) = fs::read(self.audio_dir.join("index.json")) else { return };
        let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&raw) else { return };
        // One directory scan instead of a stat per entry (this runs under
        // the state lock, possibly first from `lookup` on the CEF IO thread).
        let present: HashSet<String> = match fs::read_dir(&self.audio_dir) {
            Ok(rd) => rd
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .filter_map(|e| e.file_name().into_string().ok())
                .collect(),
            Err(_) => return,
        };
        for (key, v) in m {
            let (Some(file), Some(ext)) = (v["file"].as_str(), v["ext"].as_str()) else { continue };
            // Only names we create: <digits>.<whitelisted ext>.
            let ok = file.split_once('.').is_some_and(|(a, b)| sf(a).is_some() && b == ext && AUDIO_EXTS.contains(&b));
            if !ok || !present.contains(file) {
                continue;
            }
            let e = Entry {
                file: file.into(),
                ext: ext.into(),
                size: v["size"].as_u64().unwrap_or(0),
                used: v["used"].as_u64().unwrap_or(0),
                deleted: v["deleted"].as_bool().unwrap_or(false),
                msg: v["msg"].as_str().unwrap_or("").into(),
            };
            st.audio.insert(key, e);
        }
    }

    /// Rewrite index.json (whole file). Serialized straight from the map:
    /// no intermediate `Value` tree or key clones.
    fn save_audio(&self, st: &mut State) {
        st.dirty = false;
        st.last_save = Some(std::time::Instant::now());
        if st.audio.is_empty() && !self.audio_dir.exists() {
            return;
        }
        let r = serde_json::to_vec(&st.audio)
            .map_err(std::io::Error::other)
            .and_then(|raw| crate::util::write_atomic(&self.audio_dir.join("index.json"), &raw));
        if let Err(e) = r {
            log::warn!("message log: audio index: {e}");
        }
    }

    /// Save pending download entries, at most every few seconds while more
    /// downloads are queued, always once the queue has drained. (A crash
    /// loses at most that window: the files become strays that
    /// `enforce_caps` removes.)
    fn save_audio_batched(&self, st: &mut State) {
        const EVERY: Duration = Duration::from_secs(3);
        if st.dirty && (st.queue.is_empty() || st.last_save.is_none_or(|t| t.elapsed() >= EVERY)) {
            self.save_audio(st);
        }
    }

    /// Media worth downloading in a slimmed message.
    pub fn candidates(msg: &Value) -> Vec<(Kind, String, Target, Option<u64>)> {
        let mut out = Vec::new();
        let voice = msg["flags"].as_u64().unwrap_or(0) & 8192 != 0;
        for a in msg["attachments"].as_array().into_iter().flatten() {
            let Some(url) = a["url"].as_str() else { continue };
            let Some(t) = target(url) else { continue };
            if t.att.as_deref() != a["id"].as_str() {
                continue;
            }
            let ct = a["content_type"].as_str().unwrap_or("");
            // Audio by content type, voice-message flag or extension (Discord labels .m4a video/mp4).
            let kind = if ct.starts_with("audio/") || voice || AUDIO_EXTS.contains(&t.ext.as_str()) {
                Kind::Audio
            } else {
                Kind::Video
            };
            if kind == Kind::Audio && !AUDIO_EXTS.contains(&t.ext.as_str()) || kind == Kind::Video && !VIDEO_EXTS.contains(&t.ext.as_str()) {
                continue;
            }
            out.push((kind, url.to_owned(), t, a["size"].as_u64()));
        }
        for e in msg["embeds"].as_array().into_iter().flatten() {
            let v = &e["video"];
            for url in [v["proxy_url"].as_str(), v["url"].as_str()].into_iter().flatten() {
                if let Some(t) = target(url).filter(|t| VIDEO_EXTS.contains(&t.ext.as_str())) {
                    out.push((Kind::Video, url.to_owned(), t, None));
                    break;
                }
            }
        }
        out
    }

    /// A message was seen: queue its audio/video downloads.
    pub fn consider(&self, msg: &Value) {
        let cfg = *self.cfg.lock().unwrap();
        if !cfg.audio && !cfg.video {
            return;
        }
        // URL parsing stays outside the lock (downloads and the CEF IO
        // thread's `lookup` take it), and most messages have no media.
        let cands = Self::candidates(msg);
        if cands.is_empty() {
            return;
        }
        let id = msg["id"].as_str().unwrap_or("").to_owned();
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        let mut queued = false;
        for (kind, url, t, size) in cands {
            let (on, max) = match kind {
                Kind::Audio => (cfg.audio, cfg.audio_max),
                Kind::Video => (cfg.video, cfg.video_max),
            };
            let have = match kind {
                Kind::Audio => st.audio.contains_key(&t.key),
                Kind::Video => st.video.contains_key(&t.key),
            };
            if !on || have || size.is_some_and(|s| s > max) || st.busy.contains(&t.key) || st.failed.contains(&t.key) {
                continue;
            }
            if st.queue.len() >= MAX_QUEUE {
                break;
            }
            st.busy.insert(t.key.clone());
            st.queue.push_back(Job { kind, url, t, msg: id.clone(), max });
            queued = true;
        }
        if queued {
            self.spawn_workers(&mut st);
        }
    }

    fn spawn_workers(&self, st: &mut State) {
        let Some(me) = self.me.lock().unwrap().upgrade() else { return };
        while st.workers < WORKERS.min(st.queue.len()) {
            st.workers += 1;
            let me = me.clone();
            let ok = std::thread::Builder::new().name("corvid-msglog-dl".into()).spawn(move || me.work()).is_ok();
            if !ok {
                st.workers -= 1;
                break;
            }
        }
    }

    fn work(&self) {
        loop {
            let job = {
                let mut st = self.st.lock().unwrap();
                match st.queue.pop_front() {
                    Some(j) => j,
                    None => {
                        st.workers -= 1;
                        return;
                    }
                }
            };
            let r = self.fetch(&job.url, job.max).and_then(|(len, body)| self.ingest(&job, len, body));
            let mut st = self.st.lock().unwrap();
            st.busy.remove(&job.t.key);
            if let Err(e) = r {
                log::info!("message log: not cached ({}): {e}", job.url.split('?').next().unwrap_or(""));
                st.failed.insert(job.t.key.clone());
                // An earlier batched save may still be pending.
                self.save_audio_batched(&mut st);
            }
        }
    }

    fn fetch(&self, url: &str, max: u64) -> Result<(Option<u64>, Box<dyn Read + Send>), String> {
        target(url).ok_or("not a cacheable media URL")?;
        let mut cfg = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(300)))
            .user_agent("Mozilla/5.0")
            .https_only(true)
            .max_redirects(0)
            .http_status_as_error(true);
        match &self.route {
            Route::Default => {}
            Route::Proxy(p) => cfg = cfg.proxy(Some(p.clone())),
            Route::Blocked => return Err("proxy unusable".into()),
        }
        let resp = cfg.build().new_agent().get(url).call().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let len = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok());
        if len.is_some_and(|l| l > max) {
            return Err("larger than the cap".into());
        }
        Ok((len, Box::new(resp.into_body().into_reader())))
    }

    /// Store a downloaded body (at most `job.max` bytes, else discarded).
    fn ingest(&self, job: &Job, _len: Option<u64>, body: Box<dyn Read + Send>) -> Result<(), String> {
        let dir = self.dir(job.kind);
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let file = match (&job.kind, &job.t.att) {
            (Kind::Audio, Some(att)) => format!("{att}.{}", job.t.ext),
            (Kind::Audio, None) => return Err("audio without attachment id".into()),
            (Kind::Video, _) => format!("{:016x}.{}", fnv64(&job.t.key), job.t.ext),
        };
        let part = dir.join(format!("{file}.part"));
        let n = {
            let mut f = fs::File::create(&part).map_err(|e| e.to_string())?;
            let r = std::io::copy(&mut body.take(job.max + 1), &mut f);
            let r = r.and_then(|n| f.flush().map(|_| n));
            match r {
                Ok(n) => n,
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    return Err(e.to_string());
                }
            }
        };
        if n > job.max || n == 0 {
            let _ = fs::remove_file(&part);
            return Err(if n == 0 { "empty".into() } else { "larger than the cap".into() });
        }
        fs::rename(&part, dir.join(&file)).map_err(|e| e.to_string())?;
        let mut st = self.st.lock().unwrap();
        let deleted = st.deleted_msgs.contains(&job.msg);
        let e = Entry { file, ext: job.t.ext.clone(), size: n, used: now_s(), deleted, msg: job.msg.clone() };
        match job.kind {
            Kind::Audio => {
                self.load_audio(&mut st);
                st.audio.insert(job.t.key.clone(), e);
            }
            Kind::Video => {
                st.video.insert(job.t.key.clone(), e);
            }
        }
        self.evict(&mut st, job.kind);
        if job.kind == Kind::Audio {
            st.dirty = true;
        }
        // Also after a video: earlier audio may still be unsaved.
        self.save_audio_batched(&mut st);
        Ok(())
    }

    fn evict(&self, st: &mut State, kind: Kind) {
        let (map, cap) = match kind {
            Kind::Audio => (&mut st.audio, self.audio_cap),
            Kind::Video => (&mut st.video, self.video_cap),
        };
        let mut total: u64 = map.values().map(|e| e.size).sum();
        if total <= cap {
            return;
        }
        // Borrow keys for the sort; clone only the few that get evicted.
        let mut order: Vec<(bool, u64, &String, u64)> = map.iter().map(|(k, e)| (e.deleted, e.used, k, e.size)).collect();
        order.sort_unstable();
        let mut drop_keys = Vec::new();
        for (_, _, k, size) in order {
            if total <= cap {
                break;
            }
            drop_keys.push(k.clone());
            total -= size;
        }
        let dir = self.dir(kind);
        for k in drop_keys {
            if let Some(e) = map.remove(&k) {
                let _ = fs::remove_file(dir.join(&e.file));
            }
        }
    }

    pub fn enforce_caps(&self) {
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        // Drop index entries whose files are gone, and stray files.
        let known: HashSet<String> = st.audio.values().map(|e| e.file.clone()).collect();
        if let Ok(rd) = fs::read_dir(&self.audio_dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                // A running download's .part isn't in the index yet.
                if n.ends_with(".part") && st.workers > 0 {
                    continue;
                }
                if n != "index.json" && !known.contains(&n) {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        self.evict(&mut st, Kind::Audio);
        self.evict(&mut st, Kind::Video);
        self.save_audio(&mut st);
    }

    fn keys_of(msg: &Value) -> Vec<(Kind, String)> {
        Self::candidates(msg).into_iter().map(|(k, _, t, _)| (k, t.key)).collect()
    }

    /// The message was deleted (`true`): its media is kept longest.
    pub fn mark_deleted(&self, msg: &Value, deleted: bool) {
        let id = msg["id"].as_str().unwrap_or("").to_owned();
        let keys = Self::keys_of(msg);
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        if deleted {
            st.deleted_msgs.insert(id);
        }
        let mut audio = false;
        for (kind, key) in keys {
            let map = if kind == Kind::Audio { &mut st.audio } else { &mut st.video };
            if let Some(e) = map.get_mut(&key) {
                e.deleted = deleted;
                audio |= kind == Kind::Audio;
            }
        }
        if audio {
            self.save_audio(&mut st);
        }
    }

    /// The user removed this message's history: drop its files.
    pub fn forget_message(&self, msg: &Value) {
        let keys = Self::keys_of(msg);
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        if let Some(id) = msg["id"].as_str() {
            st.deleted_msgs.remove(id);
        }
        // clearChannel calls this per message: only rewrite the index when
        // an audio entry actually went.
        let mut audio = false;
        for (kind, key) in keys {
            let map = if kind == Kind::Audio { &mut st.audio } else { &mut st.video };
            if let Some(e) = map.remove(&key) {
                let _ = fs::remove_file(self.dir(kind).join(&e.file));
                audio |= kind == Kind::Audio;
            }
        }
        if audio {
            self.save_audio(&mut st);
        }
    }

    pub fn clear_all(&self) {
        let mut st = self.st.lock().unwrap();
        st.audio.clear();
        st.video.clear();
        st.deleted_msgs.clear();
        st.audio_loaded = true;
        let _ = fs::remove_dir_all(&self.audio_dir);
        let _ = fs::remove_dir_all(&self.video_dir);
    }

    pub fn stats(&self) -> MediaStats {
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        MediaStats {
            audio_bytes: st.audio.values().map(|e| e.size).sum(),
            audio_files: st.audio.len(),
            video_bytes: st.video.values().map(|e| e.size).sum(),
            video_files: st.video.len(),
        }
    }

    /// The cached file for a page request, if any: audio always, videos only
    /// once their message was deleted (otherwise the network serves them).
    pub fn lookup(&self, url: &str) -> Option<Cached> {
        if !maybe_target(url) {
            return None;
        }
        let t = target(url)?;
        let mut st = self.st.lock().unwrap();
        self.load_audio(&mut st);
        let (kind, e) = if let Some(e) = st.audio.get_mut(&t.key) {
            (Kind::Audio, e)
        } else {
            match st.video.get_mut(&t.key) {
                Some(e) if e.deleted => (Kind::Video, e),
                _ => return None,
            }
        };
        if e.ext != t.ext {
            return None;
        }
        e.used = now_s();
        let path = self.dir(kind).join(&e.file);
        path.is_file().then(|| Cached { path, ext: e.ext.clone(), kind })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("corvid-msgmedia-{name}-{}-{}", std::process::id(), rand::random::<u32>()))
    }

    const A: &str = "https://cdn.discordapp.com/attachments/111/222/voice-message.ogg?ex=1&is=2&hm=3";

    #[test]
    fn url_matching() {
        let t = target(A).unwrap();
        assert_eq!(t.key, "111/222/voice-message.ogg");
        assert_eq!(t.att.as_deref(), Some("222"));
        // same file via the media proxy host / another signature
        assert_eq!(target("https://media.discordapp.net/attachments/111/222/voice-message.ogg?ex=9").unwrap().key, t.key);
        assert_eq!(target("https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x.mp4").unwrap().att, None);
        for bad in [
            "http://cdn.discordapp.com/attachments/111/222/a.ogg",
            "https://cdn.discordapp.com:8443/attachments/111/222/a.ogg",
            "https://evil.example/attachments/111/222/a.ogg",
            "https://cdn.discordapp.com.evil.example/attachments/111/222/a.ogg",
            "https://images-ext-x.discordapp.net/external/a.mp4",
            "https://cdn.discordapp.com/attachments/111/222/a.png",
            "https://cdn.discordapp.com/attachments/1a/222/a.ogg",
            "https://cdn.discordapp.com/attachments/111/..%2f/a.ogg",
            "https://cdn.discordapp.com/emojis/1.mp4",
            "https://user@cdn.discordapp.com/attachments/111/222/a.ogg",
        ] {
            assert_eq!(target(bad), None, "{bad}");
        }
        // the lookup pre-check passes everything target accepts...
        for good in [
            A,
            "https://media.discordapp.net/attachments/111/222/voice-message.ogg?ex=9",
            "https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x.mp4",
            "HTTPS://CDN.DISCORDAPP.COM/attachments/111/222/a.ogg",
            "https://cdn%2Ediscordapp.com/attachments/111/222/a.ogg",
        ] {
            assert!(maybe_target(good), "{good}");
            assert!(target(good).is_some(), "{good}");
        }
        // ...and skips the API/gateway traffic without parsing
        for skip in [
            "https://discord.com/api/v9/channels/1/messages?limit=50",
            "https://discord.com/assets/abc.js",
            "http://cdn.discordapp.com/attachments/111/222/a.ogg",
            "wss://gateway.discord.gg/",
            "",
        ] {
            assert!(!maybe_target(skip), "{skip}");
            assert!(target(skip).is_none(), "{skip}");
        }
    }

    #[test]
    fn index_saves_are_batched_while_queued() {
        let d = tmp("batch");
        let m = MediaCache::new(d.clone(), "");
        let url = |a: u32| format!("https://cdn.discordapp.com/attachments/111/{a}/v.ogg");
        let index = || fs::read_to_string(d.join("audio/index.json")).unwrap_or_default();
        m.ingest(&job(Kind::Audio, &url(1), "m1", 100), None, Box::new(&b"a"[..])).unwrap();
        assert!(index().contains("111/1/v.ogg"), "first download saves");
        // more queued, within the window: not rewritten yet
        m.st.lock().unwrap().queue.push_back(job(Kind::Audio, &url(9), "m9", 100));
        m.ingest(&job(Kind::Audio, &url(2), "m2", 100), None, Box::new(&b"b"[..])).unwrap();
        assert!(!index().contains("111/2/v.ogg"));
        // queue drained (even by a video download): saved
        m.st.lock().unwrap().queue.clear();
        m.ingest(&job(Kind::Video, "https://cdn.discordapp.com/attachments/111/3/c.mp4", "m3", 100), None, Box::new(&b"c"[..]))
            .unwrap();
        assert!(index().contains("111/2/v.ogg"));
        drop(m);
        let m = MediaCache::new(d.clone(), "");
        assert!(m.lookup(&url(1)).is_some() && m.lookup(&url(2)).is_some());
        let _ = fs::remove_dir_all(&d);
    }

    fn voice_msg(id: &str, att: &str) -> Value {
        json!({"id": id, "channel_id": "111", "flags": 8192,
               "attachments": [{"id": att, "url": format!("https://cdn.discordapp.com/attachments/111/{att}/voice-message.ogg?x=1"), "size": 10}]})
    }

    #[test]
    fn candidates_classify() {
        let m = json!({"id": "1", "channel_id": "111", "attachments": [
            {"id": "2", "url": "https://cdn.discordapp.com/attachments/111/2/a.m4a", "content_type": "video/mp4"},
            {"id": "3", "url": "https://cdn.discordapp.com/attachments/111/3/b.mp4", "content_type": "video/mp4"},
            {"id": "4", "url": "https://cdn.discordapp.com/attachments/111/4/c.png", "content_type": "image/png"},
            {"id": "9", "url": "https://cdn.discordapp.com/attachments/111/5/mismatch.ogg"},
        ], "embeds": [{"type": "gifv", "video": {"url": "https://media.tenor.com/x.mp4", "proxy_url": "https://images-ext-2.discordapp.net/external/q/https/media.tenor.com/x.mp4"}}]});
        let c: Vec<(Kind, String)> = MediaCache::candidates(&m).into_iter().map(|(k, _, t, _)| (k, t.key)).collect();
        assert_eq!(c, vec![
            (Kind::Audio, "111/2/a.m4a".into()),
            (Kind::Video, "111/3/b.mp4".into()),
            (Kind::Video, "images-ext-2.discordapp.net/external/q/https/media.tenor.com/x.mp4".into()),
        ]);
    }

    fn job(kind: Kind, url: &str, msg: &str, max: u64) -> Job {
        Job { kind, url: url.into(), t: target(url).unwrap(), msg: msg.into(), max }
    }

    #[test]
    fn ingest_caps_lookup_and_persistence() {
        let d = tmp("ingest");
        let m = MediaCache::new(d.clone(), "");
        // over the per-file cap: discarded
        assert!(m.ingest(&job(Kind::Audio, A, "1", 4), None, Box::new(&b"12345"[..])).is_err());
        assert!(m.lookup(A).is_none());
        assert!(!d.join("audio/222.ogg").exists() && !d.join("audio/222.ogg.part").exists());
        m.ingest(&job(Kind::Audio, A, "1", 5), None, Box::new(&b"12345"[..])).unwrap();
        let c = m.lookup("https://media.discordapp.net/attachments/111/222/voice-message.ogg?other=sig").unwrap();
        assert_eq!(c.path, d.join("audio/222.ogg"));
        assert_eq!(c.mime(), "audio/ogg");
        // a different filename or channel for the same attachment id doesn't match
        assert!(m.lookup("https://cdn.discordapp.com/attachments/111/222/other.ogg").is_none());
        assert!(m.lookup("https://cdn.discordapp.com/attachments/112/222/voice-message.ogg").is_none());
        // the index survives a restart; the session video dir does not
        let v = "https://cdn.discordapp.com/attachments/111/333/clip.mp4";
        m.ingest(&job(Kind::Video, v, "2", 100), None, Box::new(&b"vid"[..])).unwrap();
        m.mark_deleted(&json!({"id": "2", "attachments": [{"id": "333", "url": v}]}), true);
        assert_eq!(m.lookup(v).unwrap().kind, Kind::Video);
        drop(m);
        let m = MediaCache::new(d.clone(), "");
        assert!(m.lookup(A).is_some());
        assert!(m.lookup(v).is_none());
        assert!(!d.join("session-video").exists());
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn video_only_served_once_deleted_and_wiped_on_exit() {
        let d = tmp("video");
        let m = MediaCache::new(d.clone(), "");
        let v = "https://cdn.discordapp.com/attachments/111/444/clip.webm?ex=1";
        let msg = json!({"id": "7", "attachments": [{"id": "444", "url": v}]});
        m.ingest(&job(Kind::Video, v, "7", 100), None, Box::new(&b"webm"[..])).unwrap();
        assert!(m.lookup(v).is_none(), "live message: network serves it");
        m.mark_deleted(&msg, true);
        assert_eq!(m.lookup(v).unwrap().mime(), "video/webm");
        m.wipe_session();
        assert!(m.lookup(v).is_none());
        assert!(!d.join("session-video").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn total_cap_evicts_lru_deleted_last() {
        let d = tmp("cap");
        let mut m = MediaCache::new(d.clone(), "");
        m.audio_cap = 10;
        m.video_cap = 6;
        let url = |a: u32| format!("https://cdn.discordapp.com/attachments/111/{a}/v.ogg");
        // 1 belongs to a deleted message, ingested first (oldest)
        m.st.lock().unwrap().deleted_msgs.insert("m1".into());
        m.ingest(&job(Kind::Audio, &url(1), "m1", 100), None, Box::new(&[0u8; 4][..])).unwrap();
        m.ingest(&job(Kind::Audio, &url(2), "m2", 100), None, Box::new(&[0u8; 4][..])).unwrap();
        m.st.lock().unwrap().audio.get_mut("111/2/v.ogg").unwrap().used = 1; // oldest live one
        m.ingest(&job(Kind::Audio, &url(3), "m3", 100), None, Box::new(&[0u8; 4][..])).unwrap();
        // 12 > 10: the LRU file of a live message went, not the deleted one
        assert!(m.lookup(&url(1)).is_some());
        assert!(m.lookup(&url(2)).is_none());
        assert!(!d.join("audio/2.ogg").exists());
        assert!(m.lookup(&url(3)).is_some());
        // videos: same rule, own cap
        let vurl = |a: u32| format!("https://cdn.discordapp.com/attachments/111/{a}/c.mp4");
        m.ingest(&job(Kind::Video, &vurl(5), "m5", 100), None, Box::new(&[0u8; 4][..])).unwrap();
        m.mark_deleted(&json!({"id": "m5", "attachments": [{"id": "5", "url": vurl(5)}]}), true);
        m.ingest(&job(Kind::Video, &vurl(6), "m6", 100), None, Box::new(&[0u8; 4][..])).unwrap();
        assert!(m.lookup(&vurl(5)).is_some());
        assert_eq!(m.stats().video_files, 1);
        // forget drops the file
        m.forget_message(&json!({"id": "m1", "attachments": [{"id": "1", "url": url(1)}]}));
        assert!(!d.join("audio/1.ogg").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn index_rejects_foreign_file_names() {
        let d = tmp("idx");
        fs::create_dir_all(d.join("audio")).unwrap();
        fs::write(d.join("audio/index.json"), r#"{"k":{"file":"../../etc/passwd","ext":"ogg","size":1},"j":{"file":"1.ogg","ext":"ogg"}}"#).unwrap();
        let m = MediaCache::new(d.clone(), "");
        assert_eq!(m.stats().audio_files, 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn nothing_queued_until_configured() {
        let d = tmp("cfg");
        let m = Arc::new(MediaCache::new(d.clone(), ""));
        m.consider(&voice_msg("1", "222"));
        assert!(m.st.lock().unwrap().queue.is_empty());
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    /// Lock-held cost of finishing audio downloads with a big index:
    ///   cargo test --release -p corvid-core bench_audio_index -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_audio_index() {
        let d = std::env::temp_dir().join(format!("corvid-msgmedia-bench-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let m = MediaCache::new(d.clone(), "");
        let url = |a: u32| format!("https://cdn.discordapp.com/attachments/111/{a}/voice-message.ogg");
        let job = |a: u32| { let u = url(a); Job { kind: Kind::Audio, url: u.clone(), t: target(&u).unwrap(), msg: a.to_string(), max: 1 << 20 } };
        {
            let mut st = m.st.lock().unwrap();
            st.audio_loaded = true;
            for a in 0..20_000u32 {
                let t = target(&url(a)).unwrap();
                st.audio.insert(t.key.clone(), Entry { file: format!("{a}.ogg"), ext: "ogg".into(), size: 100_000, used: a as u64, deleted: false, msg: a.to_string() });
            }
        }
        // 50 downloads finishing while more are queued (a channel full of voice messages)
        let t0 = std::time::Instant::now();
        for a in 0..50u32 {
            m.st.lock().unwrap().queue.push_back(job(1_000_000 + a));
            m.ingest(&job(500_000 + a), None, Box::new(&b"x"[..])).unwrap();
        }
        eprintln!("50 downloads with 20k-entry index: {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
        let _ = fs::remove_dir_all(&d);
    }
}
