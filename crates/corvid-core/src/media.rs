//! Media the bundled Chromium can't play.
//!
//! corvid ships the "minimal" CEF build, which has no proprietary codecs: no
//! H.264, HEVC or AAC. That is nearly every Discord video and every GIF from
//! the picker (Tenor/Giphy serve MP4), so `<video>` fails with
//! MEDIA_ERR_SRC_NOT_SUPPORTED and only the poster image shows. The backend
//! routes such media requests here; ffmpeg turns them into WebM
//! (AV1 or VP9 + Opus), which Chromium decodes, and the result is served from
//! a disk cache with byte ranges so seeking works.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

/// Containers that usually hold H.264/HEVC/AAC. WebM/Ogg/MP3 play natively.
const EXTENSIONS: &[&str] = &["mp4", "m4v", "mov", "m4a", "aac", "3gp"];
const AUDIO_EXTENSIONS: &[&str] = &["m4a", "aac"];

/// ffmpeg demuxer for each of `EXTENSIONS`. Pinned rather than probed: anyone
/// can upload a ".mp4" whose bytes are an HLS/DASH playlist, and ffmpeg then
/// fetches whatever URLs the playlist names (LAN hosts included).
fn demuxer(ext: &str) -> Option<&'static str> {
    match ext {
        "mp4" | "m4v" | "mov" | "m4a" | "3gp" => Some("mov"),
        "aac" => Some("aac"), // ADTS
        _ => None,
    }
}
/// Every value `demuxer` returns; also enforced on nested opens.
const FORMAT_WHITELIST: &str = "mov,aac";
/// Decoders (ffmpeg names, see `ffmpeg -decoders`) for what those containers
/// carry from Discord, Tenor, Giphy, phones and cameras, so a crafted file
/// can't reach the long tail of rarely used decoders. Streams we don't map
/// (subtitles, extra audio) may use others: ffmpeg only logs those.
const CODEC_WHITELIST: &str = "h264,hevc,libdav1d,libaom-av1,av1,vp9,libvpx-vp9,vp8,libvpx,mpeg4,h263,mjpeg,prores,\
aac,aac_fixed,mp3float,mp3,mp2float,mp2,opus,libopus,alac,flac,ac3,eac3,amrnb,amrwb,\
pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le";

/// Hosts whose media we fetch. ffmpeg goes to the network itself, so keep it
/// to the places Discord loads media from rather than any URL a message embeds.
const HOSTS: &[&str] = &[
    "cdn.discordapp.com",
    "media.discordapp.net",
    "discordapp.net", // images-ext-N.discordapp.net (media proxy for embeds)
    "media.tenor.com",
    "giphy.com",
];

/// Reduced Chrome UA, the same shape as the one the page sends.
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

/// At most this many ffmpeg processes; the GIF picker asks for ~30 at once.
const MAX_JOBS: usize = 4;
/// Cache size kept after pruning.
const CACHE_LIMIT: u64 = 1 << 30;
/// A request thread gives up on a transcode that has produced nothing by then
/// (queued behind other jobs, or a stalled source).
const MAX_WAIT: Duration = Duration::from_secs(120);
/// `.part`/`.live` files untouched this long belong to no running ffmpeg
/// (it writes continuously, and `-rw_timeout` ends stalled inputs).
const PARTIAL_STALE: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Video,
    Audio,
}

impl Kind {
    pub fn mime(self) -> &'static str {
        match self {
            Kind::Video => "video/webm",
            Kind::Audio => "audio/webm",
        }
    }
}

fn host_matches(host: &str, base: &str) -> bool {
    host == base || (host.len() > base.len() && host.ends_with(base) && host.as_bytes()[host.len() - base.len() - 1] == b'.')
}

/// tests/media.sh serves its samples from a local (http) origin.
fn is_test_url(url: &str) -> bool {
    static TEST_ORIGIN: OnceLock<Option<String>> = OnceLock::new();
    let test = TEST_ORIGIN.get_or_init(|| std::env::var("CORVID_MEDIA_TEST_ORIGIN").ok().filter(|s| !s.is_empty()));
    test.as_deref().is_some_and(|o| url.starts_with(o))
}

fn extension(u: &url::Url) -> Option<String> {
    Some(u.path().rsplit_once('.')?.1.to_ascii_lowercase())
}

/// Whether a media-element request for `url` should be transcoded.
pub fn wants(url: &str) -> Option<Kind> {
    let u = url::Url::parse(url).ok()?;
    let is_test = is_test_url(url);
    if u.scheme() != "https" && !is_test {
        return None;
    }
    let host = u.host_str()?;
    if !is_test && !HOSTS.iter().any(|b| host_matches(host, b)) {
        return None;
    }
    let ext = extension(&u)?;
    if !EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    Some(if AUDIO_EXTENSIONS.contains(&ext.as_str()) { Kind::Audio } else { Kind::Video })
}

/// Cache key: host + path. Discord's signed query (ex/is/hm) changes over
/// time for the same attachment, and the path already names the file.
/// Keyed SipHash (128 bits from two domain-separated runs) with a secret per
/// cache: with a public hash, anyone who can post a link could pick a URL
/// that collides with someone else's and get their file served for it.
fn cache_key(secret: &[u8; 16], url: &str) -> Option<String> {
    #[allow(deprecated)] // std's only keyed SipHash; deprecated, not going away
    use std::hash::{Hasher, SipHasher};
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let k0 = u64::from_le_bytes(secret[..8].try_into().unwrap());
    let k1 = u64::from_le_bytes(secret[8..].try_into().unwrap());
    let half = |domain: u8| {
        #[allow(deprecated)]
        let mut h = SipHasher::new_with_keys(k0, k1);
        h.write_u8(domain);
        h.write(host.as_bytes());
        h.write(u.path().as_bytes()); // starts with '/': no host/path ambiguity
        h.finish()
    };
    Some(format!("{:016x}{:016x}", half(0), half(1)))
}

/// The cache's key for `cache_key`: `<dir>/key`, created (0600) on first use.
/// If it can't be stored, a per-process key still works (no reuse on restart).
fn load_secret(dir: &Path) -> [u8; 16] {
    let path = dir.join("key");
    let read = || fs::read(&path).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok());
    if let Some(k) = read() {
        return k;
    }
    let k: [u8; 16] = rand::random();
    let write = || -> std::io::Result<()> {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("key.{}.tmp", std::process::id()));
        let mut f = fs::File::options().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(&k)?;
        fs::rename(&tmp, &path)
    };
    if let Err(e) = write() {
        log::warn!("media cache key not saved ({e}); cached transcodes won't be reused after restart");
        return k;
    }
    // Another corvid may have raced us; whichever key is on disk wins.
    read().unwrap_or(k)
}

/// Parse a single `Range: bytes=…` against a body of `len` bytes into an
/// inclusive (first, last). None = serve everything.
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    let (first, last) = if a.is_empty() {
        // suffix: last N bytes
        let n: u64 = b.parse().ok()?;
        (len.saturating_sub(n), len - 1)
    } else {
        let first: u64 = a.parse().ok()?;
        let last = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
        (first, last)
    };
    (first <= last && first < len).then_some((first, last))
}

#[derive(Debug, Clone)]
enum Encoder {
    Nvenc,
    SvtAv1,
    Vp9,
}

impl Encoder {
    fn args(&self) -> &'static [&'static str] {
        match self {
            Encoder::Nvenc => &["-c:v", "av1_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "30", "-b:v", "0"],
            Encoder::SvtAv1 => &["-c:v", "libsvtav1", "-preset", "10", "-crf", "34"],
            Encoder::Vp9 => &[
                "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-crf", "33", "-b:v", "0",
            ],
        }
    }
}

/// First encoder that actually works here (NVENC needs a capable GPU and driver).
fn pick_encoder() -> Option<Encoder> {
    for enc in [Encoder::Nvenc, Encoder::SvtAv1, Encoder::Vp9] {
        let ok = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=256x144:d=0.2:r=10"])
            .args(enc.args())
            .args(["-flags:v", "+global_header", "-pix_fmt", "yuv420p", "-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            log::info!("media transcoding with {enc:?}");
            return Some(enc);
        }
    }
    log::warn!("media transcoding off: no working ffmpeg AV1/VP9 encoder (is ffmpeg installed?)");
    None
}

enum State {
    Running,
    Done,
    Failed(String),
}

/// One ffmpeg run. It writes two outputs at once: `<key>.webm.part` (seekable,
/// with cues; renamed to `<key>.webm` when complete) and `<key>.live`, a
/// live-style WebM that can be played while it grows.
pub struct Job {
    state: Mutex<State>,
    cv: Condvar,
    live: PathBuf,
    out: PathBuf,
}

impl Job {
    /// ffmpeg has exited (the live file won't grow any more).
    pub fn finished(&self) -> bool {
        !matches!(*self.state.lock().unwrap(), State::Running)
    }
}

/// What to serve for a request.
pub enum Source {
    /// Complete, seekable file.
    File(PathBuf),
    /// Still transcoding: stream the growing live file until `job.finished()`.
    Live(Arc<Job>),
}

impl Source {
    /// Open the file to serve. A live file is deleted when its job completes,
    /// so fall back to the finished output in that race.
    pub fn open(&self) -> std::io::Result<(fs::File, Option<Arc<Job>>)> {
        match self {
            Source::File(p) => Ok((fs::File::open(p)?, None)),
            Source::Live(job) => match fs::File::open(&job.live) {
                Ok(f) => Ok((f, Some(job.clone()))),
                Err(_) => Ok((fs::File::open(&job.out)?, None)),
            },
        }
    }
}

struct Inner {
    dir: PathBuf,
    /// Extra ffmpeg input options (proxy).
    proxy_args: Option<Vec<String>>,
    encoder: OnceLock<Option<Encoder>>,
    /// `load_secret`, on first use (not at startup).
    secret: OnceLock<[u8; 16]>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    slots: (Mutex<usize>, Condvar),
    /// A prune is running; finished jobs don't start another.
    pruning: AtomicBool,
}

impl Inner {
    fn key(&self, url: &str) -> Option<String> {
        cache_key(self.secret.get_or_init(|| load_secret(&self.dir)), url)
    }

    fn prune(&self) {
        if !self.pruning.swap(true, Ordering::AcqRel) {
            prune(&self.dir, CACHE_LIMIT);
            self.pruning.store(false, Ordering::Release);
        }
    }
}

pub struct Transcoder(Arc<Inner>);

impl Transcoder {
    /// `proxy` is corvid's Chromium proxy setting. ffmpeg speaks HTTP proxies
    /// only, so with a SOCKS proxy transcoding is disabled instead of letting
    /// ffmpeg go around it.
    pub fn new(cache_dir: PathBuf, proxy: &str) -> Self {
        let proxy_args = if proxy.is_empty() {
            Some(vec![])
        } else if proxy.starts_with("http://") {
            Some(vec!["-http_proxy".into(), proxy.into()])
        } else {
            log::warn!("media transcoding off: ffmpeg can't use proxy {proxy}");
            None
        };
        let inner = Arc::new(Inner {
            dir: cache_dir,
            proxy_args,
            encoder: OnceLock::new(),
            secret: OnceLock::new(),
            jobs: Mutex::new(HashMap::new()),
            slots: (Mutex::new(0), Condvar::new()),
            pruning: AtomicBool::new(false),
        });
        // Clean leftovers and keep the cache bounded, off the startup path.
        let i = inner.clone();
        let _ = std::thread::Builder::new().name("corvid-media-prune".into()).spawn(move || i.prune());
        Self(inner)
    }

    pub fn enabled(&self) -> bool {
        self.0.proxy_args.is_some()
    }

    /// Cached path if this URL was transcoded before (no blocking).
    pub fn cached(&self, url: &str) -> Option<PathBuf> {
        let p = self.0.dir.join(format!("{}.webm", self.0.key(url)?));
        // A replay counts as use for the LRU prune.
        p.is_file().then(|| {
            touch(&p);
            p
        })
    }

    /// Blocking. Starts (or joins) the transcode of `url` and waits up to
    /// `wait` for the complete file; after that, returns the live stream as
    /// soon as it has data. Short clips and GIFs finish well inside `wait` and
    /// get a seekable file; long videos start playing instead of waiting.
    pub fn get(&self, url: &str, wait: Duration) -> Result<Source, String> {
        let key = self.0.key(url).ok_or("bad url")?;
        let out = self.0.dir.join(format!("{key}.webm"));
        if out.is_file() {
            touch(&out);
            return Ok(Source::File(out));
        }
        let job = {
            let mut jobs = self.0.jobs.lock().unwrap();
            match jobs.get(&key) {
                Some(j) => j.clone(),
                None => {
                    let j = Arc::new(Job {
                        state: Mutex::new(State::Running),
                        cv: Condvar::new(),
                        live: self.0.dir.join(format!("{key}.live")),
                        out: out.clone(),
                    });
                    jobs.insert(key.clone(), j.clone());
                    let (inner, job, url) = (self.0.clone(), j.clone(), url.to_string());
                    std::thread::Builder::new()
                        .name("corvid-ffmpeg".into())
                        .spawn(move || {
                            let r = inner.run(&url, &job);
                            if let Err(e) = &r {
                                log::warn!("transcode failed ({}): {e}", redact(&url));
                            }
                            *job.state.lock().unwrap() = match r {
                                Ok(()) => State::Done,
                                Err(e) => State::Failed(e),
                            };
                            let ok = matches!(*job.state.lock().unwrap(), State::Done);
                            job.cv.notify_all();
                            let _ = fs::remove_file(&job.live);
                            // Done: later calls find the file; failed: a later play retries.
                            inner.jobs.lock().unwrap().remove(&key);
                            // The cache grew; keep it bounded while running, not just at startup.
                            if ok {
                                inner.prune();
                            }
                        })
                        .map_err(|e| e.to_string())?;
                    j
                }
            }
        };
        let start = Instant::now();
        let (deadline, give_up) = (start + wait, start + MAX_WAIT.max(wait));
        let mut st = job.state.lock().unwrap();
        loop {
            match &*st {
                State::Done => return Ok(Source::File(out)),
                State::Failed(e) => return Err(e.clone()),
                State::Running => {}
            }
            let now = Instant::now();
            if now >= deadline && fs::metadata(&job.live).is_ok_and(|m| m.len() > 0) {
                drop(st);
                return Ok(Source::Live(job));
            }
            // The job keeps going (a later request may still get it); this
            // request thread doesn't wait forever for it.
            if now >= give_up {
                return Err(format!("no output after {} s", MAX_WAIT.as_secs()));
            }
            let step = if now < deadline { deadline - now } else { Duration::from_millis(50) };
            st = job.cv.wait_timeout(st, step).unwrap().0;
        }
    }
}

impl Inner {
    fn run(&self, url: &str, job: &Job) -> Result<(), String> {
        let enc = self.encoder.get_or_init(pick_encoder).clone().ok_or("no encoder")?;
        let proxy = self.proxy_args.as_ref().ok_or("disabled")?;
        let u = url::Url::parse(url).map_err(|e| e.to_string())?;
        let format = extension(&u).as_deref().and_then(demuxer).ok_or("not a transcodable type")?;
        // Only the protocols an https fetch (optionally via an HTTP proxy)
        // needs: no file:, data:, concat:, subfile:, rtmp: ... from inside a
        // container. Plain http just for the local test origin.
        let protocols = if is_test_url(url) && u.scheme() == "http" { "http,https,tls,tcp,httpproxy" } else { "https,tls,tcp,httpproxy" };
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let part = job.out.with_extension("webm.part");
        // tee: '|' and ':' are its separators; the paths are ours (hex names
        // in the cache dir), but refuse anything that would need escaping.
        let (live_s, part_s) = (job.live.to_string_lossy(), part.to_string_lossy());
        if [&live_s, &part_s].iter().any(|s| s.contains(['|', '[', ']', ':', '\\'])) {
            return Err(format!("cache path not usable with ffmpeg tee: {}", self.dir.display()));
        }

        // Wait for a slot.
        {
            let (m, cv) = &self.slots;
            let mut n = m.lock().unwrap();
            while *n >= MAX_JOBS {
                n = cv.wait(n).unwrap();
            }
            *n += 1;
        }
        let t = Instant::now();
        let res = Command::new("ffmpeg")
            // ffmpeg's http honours no_proxy even over -http_proxy: with the
            // user's no_proxy inherited, some hosts would bypass corvid's proxy.
            .env_remove("no_proxy")
            .env_remove("NO_PROXY")
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"])
            .args(proxy)
            .args(["-protocol_whitelist", protocols, "-format_whitelist", FORMAT_WHITELIST, "-codec_whitelist", CODEC_WHITELIST])
            // The CDNs serve media directly (checked: Discord, Tenor, Giphy);
            // a redirect could only lead somewhere HOSTS didn't allow.
            .args(["-max_redirects", "0"])
            .args(["-f", format, "-user_agent", USER_AGENT, "-rw_timeout", "30000000", "-i", url])
            .args(["-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1"])
            // bound the work (and cache file) a crafted, very long input can cost
            .args(["-t", "7200"])
            .args(enc.args())
            // the live WebM needs codec headers up front
            .args(["-flags:v", "+global_header"])
            // even dimensions and 8-bit 4:2:0 for every encoder/decoder
            .args(["-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"])
            .args(["-c:a", "libopus", "-b:a", "128k", "-ac", "2"])
            .args(["-f", "tee", &format!("[f=webm:live=1]{live_s}|[f=webm]{part_s}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output();
        {
            let (m, cv) = &self.slots;
            *m.lock().unwrap() -= 1;
            cv.notify_one();
        }
        let o = res.map_err(|e| format!("ffmpeg: {e}"))?;
        if !o.status.success() {
            let _ = fs::remove_file(&part);
            let err = String::from_utf8_lossy(&o.stderr);
            return Err(err.lines().last().unwrap_or("").to_string());
        }
        fs::rename(&part, &job.out).map_err(|e| e.to_string())?;
        let size = fs::metadata(&job.out).map(|m| m.len()).unwrap_or(0);
        log::info!("transcoded {} in {} ms ({} KB)", redact(url), t.elapsed().as_millis(), size / 1024);
        Ok(())
    }
}

/// URL for logs: no signed query.
fn redact(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

/// Mark as recently used for pruning.
fn touch(p: &Path) {
    if let Ok(f) = fs::File::options().append(true).open(p) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// Delete leftover partial files and the least recently used files beyond
/// `limit` bytes. Runs while jobs are transcoding, so a partial file is only
/// a leftover once nothing has written to it for `PARTIAL_STALE`.
fn prune(dir: &Path, limit: u64) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    let mut files = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        let Ok(m) = e.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        if p.extension().is_some_and(|x| x == "part" || x == "live") {
            let idle = m.modified().ok().and_then(|t| now.duration_since(t).ok());
            if idle.is_some_and(|d| d > PARTIAL_STALE) {
                let _ = fs::remove_file(&p);
            }
            continue;
        }
        if p.extension().is_some_and(|x| x == "webm") {
            files.push((m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len(), p));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_unplayable_media() {
        for (u, k) in [
            ("https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3", Kind::Video),
            ("https://media.discordapp.net/attachments/1/2/IMG_0001.MOV", Kind::Video),
            ("https://images-ext-1.discordapp.net/external/x/https/media.tenor.com/a/b.mp4", Kind::Video),
            ("https://media.tenor.com/abc/cat.mp4", Kind::Video),
            ("https://media2.giphy.com/media/x/giphy.mp4", Kind::Video),
            ("https://cdn.discordapp.com/attachments/1/2/voice.m4a", Kind::Audio),
        ] {
            assert_eq!(wants(u), Some(k), "{u}");
        }
    }

    #[test]
    fn leaves_playable_and_foreign_media() {
        for u in [
            "https://cdn.discordapp.com/attachments/1/2/clip.webm",
            "https://cdn.discordapp.com/attachments/1/2/song.mp3",
            "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
            "https://evil.example/clip.mp4",
            "https://notdiscordapp.net/clip.mp4",
            "http://cdn.discordapp.com/attachments/1/2/clip.mp4",
            "https://cdn.discordapp.com/attachments/1/2/mp4",
        ] {
            assert_eq!(wants(u), None, "{u}");
        }
    }

    #[test]
    fn cache_key_ignores_signed_query() {
        let k = [7u8; 16];
        let a = cache_key(&k, "https://cdn.discordapp.com/attachments/1/2/c.mp4?ex=1&hm=a");
        let b = cache_key(&k, "https://cdn.discordapp.com/attachments/1/2/c.mp4?ex=9&hm=z");
        let c = cache_key(&k, "https://cdn.discordapp.com/attachments/1/3/c.mp4?ex=1&hm=a");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.as_ref().map(|s| s.len()), Some(32));
        // a different cache secret gives different names
        assert_ne!(a, cache_key(&[8u8; 16], "https://cdn.discordapp.com/attachments/1/2/c.mp4"));
    }

    #[test]
    fn secret_is_created_private_and_reused() {
        use std::os::unix::fs::PermissionsExt;
        let d = std::env::temp_dir().join(format!("corvid-media-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let k = load_secret(&d);
        assert_eq!(load_secret(&d), k);
        assert_eq!(fs::metadata(d.join("key")).unwrap().permissions().mode() & 0o777, 0o600);
        // a corrupt key is replaced, not used
        fs::write(d.join("key"), b"short").unwrap();
        let k2 = load_secret(&d);
        assert_eq!(fs::read(d.join("key")).unwrap(), k2);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn every_extension_has_a_whitelisted_demuxer() {
        for ext in EXTENSIONS {
            let f = demuxer(ext).unwrap_or_else(|| panic!("{ext}"));
            assert!(FORMAT_WHITELIST.split(',').any(|w| w == f), "{ext}");
        }
        assert_eq!(demuxer("m3u8"), None);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-1", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    #[test]
    fn prune_keeps_newest() {
        let d = std::env::temp_dir().join(format!("corvid-prune-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        let now = SystemTime::now();
        for (i, name) in ["a.webm", "b.webm", "c.webm"].iter().enumerate() {
            let p = d.join(name);
            fs::write(&p, vec![0u8; 100]).unwrap();
            let f = fs::File::options().append(true).open(&p).unwrap();
            f.set_modified(now - std::time::Duration::from_secs(100 - i as u64 * 10)).unwrap();
        }
        // leftovers from a dead run go; partial files a job is writing stay
        for name in ["x.webm.part", "y.live", "busy.webm.part", "busy.live"] {
            fs::write(d.join(name), b"x").unwrap();
        }
        for name in ["x.webm.part", "y.live"] {
            let f = fs::File::options().append(true).open(d.join(name)).unwrap();
            f.set_modified(now - PARTIAL_STALE - Duration::from_secs(1)).unwrap();
        }
        fs::write(d.join("key"), [0u8; 16]).unwrap();
        prune(&d, 150);
        let mut left: Vec<_> = fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(left, ["busy.live", "busy.webm.part", "c.webm", "key"]);
        fs::remove_dir_all(&d).unwrap();
    }
}
