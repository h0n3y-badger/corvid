//! Message log store for the MessageLogger plugin: deleted messages, edit
//! histories and a rolling cache of "seen" messages, kept under
//! `$XDG_CACHE_HOME/corvid/message-log/`.
//!
//! Layout:
//!   ch/<channelId>.jsonl   append-only op log per channel (compacted when
//!                          mostly superseded). One JSON object per line:
//!                            {"s":msg,"t":lastSeenSecs}        seen
//!                            {"d":msg,"at":ms,"off":bool}      deleted
//!                            {"e":"id","c":old,"at":ms}        edit history entry
//!                            {"x":"id"}                        history removed
//!                            {"u":"id"}                        seen dropped
//!   audio/, session-video/ see `msgmedia`.
//!
//! Channels are replayed into memory lazily (first command that names them)
//! and dropped again LRU. Everything the page sends is untrusted: ids must be
//! decimal snowflakes before they name a file, messages are re-slimmed to a
//! whitelist of fields, and batches/strings are size-capped.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

use crate::msgmedia::{MediaCache, MediaConfig};

/// Text store cap; oldest seen records go first, then oldest history.
pub const TEXT_CAP: u64 = 512 << 20;
/// Channels kept replayed in memory.
const MAX_LOADED: usize = 64;
/// One slimmed message, serialized.
const MAX_MSG_BYTES: usize = 128 << 10;
const MAX_CONTENT: usize = 16 << 10;
const MAX_BATCH: usize = 500;
const MAX_IDS: usize = 1000;
/// Edit history entries kept per message, whatever the page asks for.
const MAX_EDITS_HARD: usize = 200;
/// A seen record is rewritten (to refresh its last-seen time) at most this often.
const SEEN_REFRESH_SECS: u64 = 12 * 3600;
/// Full expiry sweep at startup at most this often (`swept` stamp file).
const SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);

pub type Sf = u128;

/// A decimal snowflake: 1–25 digits, no leading zero.
pub fn sf(s: &str) -> Option<Sf> {
    let ok = (1..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) && (s.len() == 1 || !s.starts_with('0'));
    if ok { s.parse().ok() } else { None }
}

fn sf_val(v: &Value) -> Option<Sf> {
    v.as_str().and_then(sf)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Truncate to at most `max` bytes on a char boundary.
fn trunc(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut i = max;
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    s[..i].to_owned()
}

fn pick(src: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for k in keys {
        if let Some(v) = src.get(*k)
            && !v.is_null()
        {
            out.insert((*k).to_owned(), v.clone());
        }
    }
    out
}

fn str_or_null(v: Option<&Value>, max: usize) -> Value {
    match v.and_then(Value::as_str) {
        Some(s) => Value::String(trunc(s, max)),
        None => Value::Null,
    }
}

fn id_list(v: Option<&Value>) -> Vec<Value> {
    let Some(a) = v.and_then(Value::as_array) else { return vec![] };
    a.iter()
        .take(100)
        .filter_map(|x| x.as_str().or_else(|| x.get("id").and_then(Value::as_str)))
        .filter(|s| sf(s).is_some())
        .map(|s| Value::String(s.to_owned()))
        .collect()
}

/// Whitelist the fields we keep; None if it isn't a usable message.
pub fn slim(m: &Value) -> Option<Value> {
    let o = m.as_object()?;
    let id = o.get("id").and_then(Value::as_str).filter(|s| sf(s).is_some())?;
    let ch = o.get("channel_id").and_then(Value::as_str).filter(|s| sf(s).is_some())?;
    let mut out = Map::new();
    out.insert("id".into(), id.into());
    out.insert("channel_id".into(), ch.into());
    if let Some(g) = o.get("guild_id").and_then(Value::as_str).filter(|s| sf(s).is_some()) {
        out.insert("guild_id".into(), g.into());
    }
    out.insert("content".into(), Value::String(trunc(o.get("content").and_then(Value::as_str).unwrap_or(""), MAX_CONTENT)));
    out.insert("timestamp".into(), str_or_null(o.get("timestamp"), 64));
    out.insert("edited_timestamp".into(), str_or_null(o.get("edited_timestamp"), 64));
    for k in ["flags", "type"] {
        out.insert(k.into(), o.get(k).and_then(Value::as_u64).map(Value::from).unwrap_or(0.into()));
    }
    if let Some(w) = o.get("webhook_id").and_then(Value::as_str).filter(|s| sf(s).is_some()) {
        out.insert("webhook_id".into(), w.into());
    }
    if let Some(a) = o.get("author").and_then(Value::as_object) {
        let mut au = pick(a, &["id", "username", "global_name", "avatar", "discriminator", "bot"]);
        au.retain(|k, v| match k.as_str() {
            "bot" => v.is_boolean(),
            "id" => sf_val(v).is_some(),
            _ => v.as_str().is_some_and(|s| s.len() <= 256),
        });
        if au.contains_key("id") {
            out.insert("author".into(), Value::Object(au));
        }
    }
    out.insert("mentions".into(), Value::Array(id_list(o.get("mentions"))));
    out.insert("mention_roles".into(), Value::Array(id_list(o.get("mention_roles"))));
    if let Some(b) = o.get("mention_everyone").and_then(Value::as_bool) {
        out.insert("mention_everyone".into(), b.into());
    }
    let objs = |k: &str, n: usize| -> Vec<Value> {
        o.get(k).and_then(Value::as_array).map(|a| a.iter().filter(|x| x.is_object()).take(n).cloned().collect()).unwrap_or_default()
    };
    let atts: Vec<Value> = objs("attachments", 25)
        .iter()
        .map(|a| {
            Value::Object(pick(
                a.as_object().unwrap(),
                &[
                    "id", "filename", "url", "proxy_url", "content_type", "size", "width", "height", "duration_secs", "waveform",
                    "flags", "description", "title",
                ],
            ))
        })
        .collect();
    out.insert("attachments".into(), Value::Array(atts));
    out.insert("embeds".into(), Value::Array(objs("embeds", 25)));
    let stickers: Vec<Value> = objs("sticker_items", 3)
        .iter()
        .map(|s| Value::Object(pick(s.as_object().unwrap(), &["id", "name", "format_type"])))
        .collect();
    out.insert("sticker_items".into(), Value::Array(stickers));
    if let Some(r) = o.get("message_reference").and_then(Value::as_object) {
        out.insert("message_reference".into(), Value::Object(pick(r, &["message_id", "channel_id", "guild_id", "type"])));
    }
    if let Some(r) = o.get("referenced_message").and_then(Value::as_object)
        && let Some(rid) = r.get("id").and_then(Value::as_str).filter(|s| sf(s).is_some())
    {
        let mut p = Map::new();
        p.insert("id".into(), rid.into());
        p.insert("channel_id".into(), r.get("channel_id").cloned().unwrap_or(ch.into()));
        p.insert("content".into(), Value::String(trunc(r.get("content").and_then(Value::as_str).unwrap_or(""), 300)));
        if let Some(a) = r.get("author").and_then(Value::as_object) {
            p.insert("author".into(), Value::Object(pick(a, &["id", "username", "global_name", "avatar"])));
        }
        out.insert("referenced_message".into(), Value::Object(p));
    }
    let mut v = Value::Object(out);
    if v.to_string().len() > MAX_MSG_BYTES {
        v["embeds"] = json!([]);
        if v.to_string().len() > MAX_MSG_BYTES {
            return None;
        }
    }
    Some(v)
}

fn msg_id(m: &Value) -> Option<Sf> {
    m.get("id").and_then(sf_val)
}

#[derive(Debug, Clone)]
struct Seen {
    /// The slimmed message as compact JSON. A `Value` tree costs ~6.7x its
    /// JSON size in RAM (64 loaded channels x 2000 seen: +462 MB); records
    /// are only parsed when needed (delete, lookup, offline checks).
    raw: Box<str>,
    /// Unix seconds.
    last: u64,
}

impl Seen {
    fn msg(&self) -> Value {
        serde_json::from_str(&self.raw).unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone)]
struct Deleted {
    msg: Value,
    at: u64,
    offline: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub content: String,
    pub at: u64,
}

#[derive(Default)]
struct Chan {
    seen: BTreeMap<Sf, Seen>,
    deleted: BTreeMap<Sf, Deleted>,
    edits: HashMap<Sf, Vec<Edit>>,
    /// Lines in the file (live + superseded).
    lines: usize,
    used: u64,
}

impl Chan {
    fn live(&self) -> usize {
        self.seen.len() + self.deleted.len() + self.edits.values().map(Vec::len).sum::<usize>()
    }

    fn apply(&mut self, v: &Value, seen_cutoff: u64) {
        if let Some(m) = v.get("s") {
            let last = v.get("t").and_then(Value::as_u64).unwrap_or(0);
            if let Some(id) = msg_id(m)
                && last >= seen_cutoff
            {
                self.seen.insert(id, Seen { raw: m.to_string().into_boxed_str(), last });
            } else if let Some(id) = msg_id(m) {
                self.seen.remove(&id);
            }
        } else if let Some(m) = v.get("d") {
            if let Some(id) = msg_id(m) {
                let at = v.get("at").and_then(Value::as_u64).unwrap_or(0);
                let offline = v.get("off").and_then(Value::as_bool).unwrap_or(false);
                self.deleted.insert(id, Deleted { msg: m.clone(), at, offline });
                self.seen.remove(&id);
            }
        } else if let Some(id) = v.get("e").and_then(sf_val) {
            let content = v.get("c").and_then(Value::as_str).unwrap_or("").to_owned();
            let at = v.get("at").and_then(Value::as_u64).unwrap_or(0);
            let max = v.get("max").and_then(Value::as_u64).unwrap_or(MAX_EDITS_HARD as u64) as usize;
            let list = self.edits.entry(id).or_default();
            list.push(Edit { content, at });
            let max = max.clamp(1, MAX_EDITS_HARD);
            if list.len() > max {
                list.drain(..list.len() - max);
            }
        } else if let Some(id) = v.get("x").and_then(sf_val) {
            self.deleted.remove(&id);
            self.edits.remove(&id);
        } else if let Some(id) = v.get("u").and_then(sf_val) {
            self.seen.remove(&id);
        }
    }

    fn lines_out(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.live());
        for s in self.seen.values() {
            out.push(format!(r#"{{"s":{},"t":{}}}"#, s.raw, s.last));
        }
        for d in self.deleted.values() {
            out.push(json!({"d": d.msg, "at": d.at, "off": d.offline}).to_string());
        }
        let mut ids: Vec<&Sf> = self.edits.keys().collect();
        ids.sort();
        for id in ids {
            for e in &self.edits[id] {
                out.push(json!({"e": id.to_string(), "c": e.content, "at": e.at}).to_string());
            }
        }
        out
    }
}

#[derive(Debug, Clone, Copy)]
struct Cfg {
    persist: bool,
    seen_days: u64,
    text_cap: u64,
}

struct Store {
    dir: PathBuf,
    cfg: Cfg,
    chans: HashMap<Sf, Chan>,
    tick: u64,
}

impl Store {
    fn ch_dir(&self) -> PathBuf {
        self.dir.join("ch")
    }

    fn file(&self, ch: Sf) -> PathBuf {
        self.ch_dir().join(format!("{ch}.jsonl"))
    }

    fn seen_cutoff(&self) -> u64 {
        (now_ms() / 1000).saturating_sub(self.cfg.seen_days * 86400)
    }

    fn read_file(path: &Path, cutoff: u64) -> Chan {
        let mut c = Chan::default();
        let Ok(f) = fs::File::open(path) else { return c };
        for line in std::io::BufReader::new(f).split(b'\n').map_while(Result::ok) {
            c.lines += 1;
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                c.apply(&v, cutoff);
            }
        }
        c
    }

    fn chan(&mut self, ch: Sf) -> &mut Chan {
        self.tick += 1;
        let tick = self.tick;
        if !self.chans.contains_key(&ch) {
            if self.chans.len() >= MAX_LOADED
                && let Some((&old, _)) = self.chans.iter().min_by_key(|(_, c)| c.used)
            {
                self.chans.remove(&old);
            }
            let c = if self.cfg.persist { Self::read_file(&self.file(ch), self.seen_cutoff()) } else { Chan::default() };
            self.chans.insert(ch, c);
        }
        let c = self.chans.get_mut(&ch).unwrap();
        c.used = tick;
        c
    }

    /// Apply ops to a channel and append them to its file.
    fn write(&mut self, ch: Sf, ops: &[Value]) {
        if ops.is_empty() {
            return;
        }
        let cutoff = self.seen_cutoff();
        let persist = self.cfg.persist;
        let path = self.file(ch);
        let c = self.chan(ch);
        for op in ops {
            c.apply(op, cutoff);
        }
        if !persist {
            return;
        }
        c.lines += ops.len();
        let compact = c.lines > 2 * c.live() + 200;
        if compact {
            let lines = c.lines_out();
            c.lines = lines.len();
            if let Err(e) = write_lines(&path, &lines) {
                log::warn!("message log: compact {}: {e}", path.display());
            }
            return;
        }
        let mut buf = String::new();
        for op in ops {
            buf.push_str(&op.to_string());
            buf.push('\n');
        }
        let r = fs::create_dir_all(path.parent().unwrap())
            .and_then(|_| fs::OpenOptions::new().create(true).append(true).open(&path))
            .and_then(|mut f| f.write_all(buf.as_bytes()));
        if let Err(e) = r {
            log::warn!("message log: append {}: {e}", path.display());
        }
    }

    fn channel_files(&self) -> Vec<(Sf, u64, SystemTime)> {
        let Ok(rd) = fs::read_dir(self.ch_dir()) else { return vec![] };
        rd.flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                let id = sf(name.strip_suffix(".jsonl")?)?;
                let m = e.metadata().ok()?;
                Some((id, m.len(), m.modified().unwrap_or(UNIX_EPOCH)))
            })
            .collect()
    }

    /// Rewrite one channel's file from `c` (or delete it when empty).
    fn rewrite(&mut self, ch: Sf, mut c: Chan) {
        let path = self.file(ch);
        let lines = c.lines_out();
        c.lines = lines.len();
        let r = if lines.is_empty() { fs::remove_file(&path).or(Ok(())) } else { write_lines(&path, &lines) };
        if let Err(e) = r {
            log::warn!("message log: rewrite {}: {e}", path.display());
        }
        if self.chans.contains_key(&ch) {
            c.used = self.chans[&ch].used;
            self.chans.insert(ch, c);
        }
    }

}

fn write_lines(path: &Path, lines: &[String]) -> std::io::Result<()> {
    let mut data = lines.join("\n");
    data.push('\n');
    crate::util::write_atomic(path, data.as_bytes())
}

pub struct MsgLog {
    store: Mutex<Store>,
    swept: std::sync::atomic::AtomicBool,
    pub media: Arc<MediaCache>,
}

type R = Result<Value, String>;

fn arg_ch(args: &Value) -> Result<Sf, String> {
    args.get("channelId").and_then(sf_val).ok_or_else(|| "bad channelId".to_owned())
}

fn arr<'a>(args: &'a Value, k: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    let a = args.get(k).and_then(Value::as_array).ok_or_else(|| format!("missing {k}"))?;
    if a.len() > max {
        return Err(format!("{k}: too many"));
    }
    Ok(a)
}

fn ms_arg(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).filter(|&t| t < 1 << 50).unwrap_or_else(now_ms)
}

fn record_json(d: &Deleted) -> Value {
    json!({"message": d.msg, "deletedAt": d.at, "offline": d.offline})
}

fn edits_json(list: &[Edit]) -> Value {
    Value::Array(list.iter().map(|e| json!({"content": e.content, "replacedAt": e.at})).collect())
}

impl MsgLog {
    /// `dir` is `$XDG_CACHE_HOME/corvid/message-log`.
    pub fn new(dir: PathBuf, proxy: &str) -> Self {
        let media = Arc::new(MediaCache::new(dir.clone(), proxy));
        Self::with(dir, media, TEXT_CAP)
    }

    fn with(dir: PathBuf, media: Arc<MediaCache>, text_cap: u64) -> Self {
        let cfg = Cfg { persist: true, seen_days: 7, text_cap };
        Self { store: Mutex::new(Store { dir, cfg, chans: HashMap::new(), tick: 0 }), swept: Default::default(), media }
    }

    /// Clean exit: drop the session video cache.
    pub fn shutdown(&self) {
        self.media.wipe_session();
    }

    fn seen_ops(&self, msgs: &[Value]) -> HashMap<Sf, Vec<Value>> {
        let t = now_ms() / 1000;
        let mut by: HashMap<Sf, Vec<Value>> = HashMap::new();
        for m in msgs {
            let Some(s) = slim(m) else { continue };
            // Ephemeral messages never come back in history: they'd look deleted.
            if s["flags"].as_u64().unwrap_or(0) & 64 != 0 {
                continue;
            }
            let ch = sf_val(&s["channel_id"]).unwrap();
            by.entry(ch).or_default().push(s);
        }
        let mut st = self.store.lock().unwrap();
        let mut out = HashMap::new();
        for (ch, list) in by {
            let c = st.chan(ch);
            let mut ops = Vec::new();
            for s in list {
                let id = msg_id(&s).unwrap();
                if c.deleted.contains_key(&id) {
                    continue;
                }
                // Unchanged and recently refreshed: no write.
                if let Some(old) = c.seen.get(&id)
                    && *old.raw == *s.to_string()
                    && t.saturating_sub(old.last) < SEEN_REFRESH_SECS
                {
                    continue;
                }
                ops.push(json!({"s": s, "t": t}));
            }
            out.insert(ch, ops);
        }
        out
    }

    fn record_seen(&self, msgs: &[Value]) {
        let ops = self.seen_ops(msgs);
        let mut st = self.store.lock().unwrap();
        for (ch, o) in ops {
            st.write(ch, &o);
        }
        drop(st);
        for m in msgs {
            if let Some(s) = slim(m) {
                self.media.consider(&s);
            }
        }
    }

    /// Handle `msglog.<sub>`.
    pub fn invoke(&self, sub: &str, args: &Value) -> R {
        match sub {
            "init" => {
                let mut st = self.store.lock().unwrap();
                let persist = args.get("persist").and_then(Value::as_bool).unwrap_or(true);
                if persist != st.cfg.persist {
                    st.chans.clear();
                }
                st.cfg.persist = persist;
                st.cfg.seen_days = args.get("seenDays").and_then(Value::as_u64).unwrap_or(7).clamp(0, 3650);
                drop(st);
                let mb = |k: &str, d: u64| args.get(k).and_then(Value::as_u64).unwrap_or(d).clamp(1, 4096) << 20;
                self.media.configure(MediaConfig {
                    audio: persist && args.get("downloadAudio").and_then(Value::as_bool).unwrap_or(true),
                    audio_max: mb("maxAudioMB", 50),
                    video: args.get("cacheVideos").and_then(Value::as_bool).unwrap_or(true),
                    video_max: mb("maxVideoMB", 100),
                });
                Ok(Value::Null)
            }
            "seen" => {
                let items = arr(args, "messages", MAX_BATCH)?;
                self.record_seen(items);
                Ok(Value::Null)
            }
            "page" => self.page(args),
            "lookup" => {
                let ch = arg_ch(args)?;
                let ids = arr(args, "ids", MAX_IDS)?;
                let mut st = self.store.lock().unwrap();
                let c = st.chan(ch);
                let out: Vec<Value> = ids.iter().filter_map(sf_val).filter_map(|id| c.seen.get(&id).map(Seen::msg)).collect();
                Ok(Value::Array(out))
            }
            "delete" => {
                let ch = arg_ch(args)?;
                let items = arr(args, "items", MAX_IDS)?;
                let mut ops = Vec::new();
                let mut st = self.store.lock().unwrap();
                let c = st.chan(ch);
                let mut stored = Vec::new();
                for it in items {
                    let Some(id) = it.get("id").and_then(sf_val) else { continue };
                    let msg = match it.get("message").and_then(slim) {
                        Some(m) if msg_id(&m) == Some(id) && sf_val(&m["channel_id"]) == Some(ch) => m,
                        _ => match c.seen.get(&id) {
                            Some(s) => s.msg(),
                            None => continue,
                        },
                    };
                    let at = ms_arg(it.get("at"));
                    let off = it.get("offline").and_then(Value::as_bool).unwrap_or(false);
                    stored.push(msg.clone());
                    ops.push(json!({"d": msg, "at": at, "off": off}));
                }
                st.write(ch, &ops);
                drop(st);
                for m in &stored {
                    self.media.mark_deleted(m, true);
                }
                Ok(Value::Array(ops.iter().map(|o| json!({"message": o["d"], "deletedAt": o["at"], "offline": o["off"]})).collect()))
            }
            "forget" => {
                let ch = arg_ch(args)?;
                let ids = arr(args, "ids", MAX_IDS)?;
                let ops: Vec<Value> = ids.iter().filter_map(sf_val).map(|id| json!({"u": id.to_string()})).collect();
                self.store.lock().unwrap().write(ch, &ops);
                Ok(Value::Null)
            }
            "edit" => {
                let ch = arg_ch(args)?;
                let id = args.get("id").and_then(sf_val).ok_or("bad id")?;
                let content = args.get("content").and_then(Value::as_str).ok_or("missing content")?;
                let max = args.get("max").and_then(Value::as_u64).unwrap_or(30).clamp(1, MAX_EDITS_HARD as u64);
                let op = json!({"e": id.to_string(), "c": trunc(content, MAX_CONTENT), "at": ms_arg(args.get("at")), "max": max});
                let mut st = self.store.lock().unwrap();
                st.write(ch, &[op]);
                let list = st.chan(ch).edits.get(&id).cloned().unwrap_or_default();
                Ok(edits_json(&list))
            }
            "remove" => {
                let ch = arg_ch(args)?;
                let id = args.get("id").and_then(sf_val).ok_or("bad id")?;
                let mut st = self.store.lock().unwrap();
                let msg = st.chan(ch).deleted.get(&id).map(|d| d.msg.clone());
                st.write(ch, &[json!({"x": id.to_string()})]);
                drop(st);
                if let Some(m) = msg {
                    self.media.forget_message(&m);
                }
                Ok(Value::Null)
            }
            "clearChannel" => {
                let ch = arg_ch(args)?;
                let mut st = self.store.lock().unwrap();
                let c = st.chan(ch);
                let msgs: Vec<Value> = c.deleted.values().map(|d| d.msg.clone()).collect();
                let ids: HashSet<Sf> = c.deleted.keys().chain(c.edits.keys()).copied().collect();
                let ops: Vec<Value> = ids.iter().map(|id| json!({"x": id.to_string()})).collect();
                st.write(ch, &ops);
                drop(st);
                for m in &msgs {
                    self.media.forget_message(m);
                }
                Ok(json!(ids.len()))
            }
            "clearAll" => {
                let mut st = self.store.lock().unwrap();
                st.chans.clear();
                let _ = fs::remove_dir_all(st.ch_dir());
                drop(st);
                self.media.clear_all();
                Ok(Value::Null)
            }
            "stats" => Ok(self.stats()),
            "sweep" => {
                self.sweep(true);
                self.media.enforce_caps();
                Ok(Value::Null)
            }
            _ => Err(format!("unknown command msglog.{sub}")),
        }
    }

    /// Run `sweep` on a background thread (startup).
    pub fn sweep_in_background(self: &Arc<Self>) {
        if self.swept.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        let me = self.clone();
        let _ = std::thread::Builder::new().name("corvid-msglog-sweep".into()).spawn(move || {
            me.sweep(false);
            me.media.enforce_caps();
        });
    }

    /// Expire old seen records everywhere and keep the text store under the
    /// cap. Files are read and parsed WITHOUT the store lock (that's nearly all
    /// the work: ~1.9 s for a 280 MB store, during which every channel open
    /// used to wait); the lock is only taken to rewrite one file, and only if
    /// nothing was appended to it meanwhile (else it's left for next time).
    /// The expiry pass runs at most every `SWEEP_EVERY` unless `force`d; the
    /// cap check only stats files unless the store is over the cap.
    fn sweep(&self, force: bool) {
        let (files, cutoff, cap, dir) = {
            let st = self.store.lock().unwrap();
            if !st.cfg.persist {
                return;
            }
            (st.channel_files(), st.seen_cutoff(), st.cfg.text_cap, st.dir.clone())
        };
        let stamp = dir.join("swept");
        let recent = !force
            && fs::metadata(&stamp).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e < SWEEP_EVERY);
        if !recent {
            for (ch, _, _) in &files {
                self.sweep_file(*ch, cutoff, |c| c.lines != c.live());
            }
            let _ = fs::write(&stamp, b"");
        }
        let mut files = self.store.lock().unwrap().channel_files();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= cap {
            return;
        }
        // Oldest channels (by last write) lose their seen records first, then
        // their whole history.
        files.sort_by_key(|f| f.2);
        for pass in 0..2 {
            for (ch, len, _) in &files {
                if total <= cap {
                    return;
                }
                let now = self.sweep_file(*ch, cutoff, |c| {
                    c.seen.clear();
                    if pass == 1 {
                        c.deleted.clear();
                        c.edits.clear();
                    }
                    true
                });
                if let Some(now) = now {
                    total = total.saturating_sub(len.saturating_sub(now));
                }
            }
            files = self.store.lock().unwrap().channel_files();
            files.sort_by_key(|f| f.2);
            total = files.iter().map(|f| f.1).sum();
        }
    }

    /// Read one channel file without the lock, let `edit` change it, and
    /// rewrite it under the lock if `edit` says so and the file is unchanged
    /// since it was read. Returns the new file size when rewritten.
    fn sweep_file(&self, ch: Sf, cutoff: u64, edit: impl FnOnce(&mut Chan) -> bool) -> Option<u64> {
        let path = self.store.lock().unwrap().file(ch);
        let stamp = |p: &Path| fs::metadata(p).ok().map(|m| (m.len(), m.modified().ok()));
        let before = stamp(&path)?;
        let mut c = Store::read_file(&path, cutoff);
        if !edit(&mut c) {
            return None;
        }
        let mut st = self.store.lock().unwrap();
        if stamp(&path) != Some(before) {
            return None;
        }
        st.rewrite(ch, c);
        Some(fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
    }

    /// A contiguous page of a channel's history was loaded. Returns what to
    /// restore into it, candidates for deletes/edits that happened while we
    /// weren't connected, and records the page as seen.
    fn page(&self, args: &Value) -> R {
        let ch = arg_ch(args)?;
        let msgs = arr(args, "messages", MAX_BATCH)?;
        let detect = args.get("detect").and_then(Value::as_bool).unwrap_or(false);
        let open_before = args.get("openBefore").and_then(Value::as_bool).unwrap_or(false);
        let open_after = args.get("openAfter").and_then(Value::as_bool).unwrap_or(false);
        let page: Vec<Value> = msgs.iter().filter_map(slim).filter(|m| sf_val(&m["channel_id"]) == Some(ch)).collect();
        let ids: HashSet<Sf> = page.iter().filter_map(msg_id).collect();
        let (lo, hi) = (ids.iter().min().copied(), ids.iter().max().copied());
        let mut st = self.store.lock().unwrap();
        let c = st.chan(ch);
        let (from, to) = match (lo, hi) {
            (Some(lo), Some(hi)) => (if open_before { 0 } else { lo }, if open_after { Sf::MAX } else { hi }),
            // An empty page is the whole (empty) channel only when both ends are open.
            _ if open_before && open_after => (0, Sf::MAX),
            _ => (1, 0),
        };
        let deleted: Vec<Value> =
            if from <= to { c.deleted.range(from..=to).filter(|(id, _)| !ids.contains(id)).map(|(_, d)| record_json(d)).collect() } else { vec![] };
        let mut edits = Map::new();
        for id in &ids {
            if let Some(l) = c.edits.get(id) {
                edits.insert(id.to_string(), edits_json(l));
            }
        }
        if from <= to {
            for (id, _) in c.deleted.range(from..=to) {
                if let Some(l) = c.edits.get(id) {
                    edits.insert(id.to_string(), edits_json(l));
                }
            }
        }
        let mut offline = Vec::new();
        let mut changed = Map::new();
        if detect && let (Some(lo), Some(hi)) = (lo, hi) {
            offline = offline_deleted(c, &ids, lo, hi);
            for m in &page {
                let id = msg_id(m).unwrap();
                if let Some(s) = c.seen.get(&id)
                    && let Some(old) = edited_since(&s.msg(), m)
                {
                    changed.insert(id.to_string(), json!({"content": old, "editedTimestamp": m["edited_timestamp"]}));
                }
            }
        }
        drop(st);
        self.record_seen(&page);
        Ok(json!({"deleted": deleted, "edits": edits, "offline": offline, "changed": changed}))
    }

    fn stats(&self) -> Value {
        let mut st = self.store.lock().unwrap();
        let cutoff = st.seen_cutoff();
        let (mut seen, mut deleted, mut edited, mut versions, mut bytes) = (0, 0, 0, 0, 0u64);
        let files = st.channel_files();
        let mut done = HashSet::new();
        for (ch, len, _) in &files {
            bytes += len;
            done.insert(*ch);
            let tmp;
            let c = match st.chans.get(ch) {
                Some(c) => c,
                None => {
                    tmp = Store::read_file(&st.file(*ch), cutoff);
                    &tmp
                }
            };
            seen += c.seen.len();
            deleted += c.deleted.len();
            edited += c.edits.len();
            versions += c.edits.values().map(Vec::len).sum::<usize>();
        }
        // In-memory-only channels (persist off).
        for (ch, c) in st.chans.iter_mut() {
            if !done.contains(ch) {
                seen += c.seen.len();
                deleted += c.deleted.len();
                edited += c.edits.len();
                versions += c.edits.values().map(Vec::len).sum::<usize>();
            }
        }
        let m = self.media.stats();
        json!({
            "records": seen + deleted + versions,
            "seen": seen, "deleted": deleted, "edited": edited, "editVersions": versions,
            "textBytes": bytes,
            "audioBytes": m.audio_bytes, "audioFiles": m.audio_files,
            "videoBytes": m.video_bytes, "videoFiles": m.video_files,
        })
    }
}

/// Seen messages strictly inside (lo, hi) that the page doesn't contain.
fn offline_deleted(c: &Chan, page: &HashSet<Sf>, lo: Sf, hi: Sf) -> Vec<Value> {
    if hi <= lo + 1 {
        return vec![];
    }
    c.seen
        .range(lo + 1..hi)
        .filter(|(id, _)| !page.contains(id) && !c.deleted.contains_key(id))
        .map(|(_, s)| s.msg())
        .collect()
}

/// Old content if `new` is an edit of the seen `old` made after we saw it.
fn edited_since(old: &Value, new: &Value) -> Option<String> {
    let (oc, nc) = (old["content"].as_str()?, new["content"].as_str()?);
    if oc == nc {
        return None;
    }
    let ne = new["edited_timestamp"].as_str()?;
    let newer = match old["edited_timestamp"].as_str() {
        None => true,
        Some(oe) => ts_ms(ne)? > ts_ms(oe)?,
    };
    newer.then(|| oc.to_owned())
}

/// Milliseconds from an RFC 3339 timestamp like Discord's
/// "2026-11-27T10:00:00.123000+00:00". Enough for ordering.
pub fn ts_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut rest = &s[19..];
    let mut frac = 0i64;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(char::is_ascii_digit).collect();
        frac = format!("{:0<3}", &digits[..digits.len().min(3)]).parse().unwrap_or(0);
        rest = &r[digits.len()..];
    }
    let off = match rest {
        "" | "Z" => 0,
        r if r.len() == 6 => {
            let sign = if r.starts_with('-') { -1 } else { 1 };
            sign * (r.get(1..3)?.parse::<i64>().ok()? * 60 + r.get(4..6)?.parse::<i64>().ok()?) * 60_000
        }
        _ => return None,
    };
    Some(((days * 86400 + h * 3600 + mi * 60 + se) * 1000 + frac) - off)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("corvid-msglog-{name}-{}-{}", std::process::id(), rand::random::<u32>()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn log_at(d: &Path, cap: u64) -> MsgLog {
        MsgLog::with(d.to_path_buf(), Arc::new(MediaCache::new(d.to_path_buf(), "")), cap)
    }

    fn msg(id: u64, ch: u64, content: &str) -> Value {
        json!({"id": id.to_string(), "channel_id": ch.to_string(), "content": content,
               "timestamp": "2026-11-27T10:00:00.000000+00:00", "edited_timestamp": null,
               "author": {"id": "5", "username": "u", "email": "x@y"}, "member": {"roles": []}})
    }

    #[test]
    fn snowflakes() {
        assert_eq!(sf("1"), Some(1));
        assert_eq!(sf("1234567890123456789"), Some(1234567890123456789));
        for bad in ["", "01", "-1", "1a", "../1", "12345678901234567890123456", " 1"] {
            assert_eq!(sf(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn slim_whitelists_and_validates() {
        let s = slim(&msg(10, 2, "hi")).unwrap();
        assert!(s.get("member").is_none());
        assert!(s["author"].get("email").is_none());
        assert_eq!(s["author"]["id"], "5");
        assert!(slim(&json!({"id": "../x", "channel_id": "1"})).is_none());
        assert!(slim(&json!({"id": "1", "channel_id": "1/2"})).is_none());
        assert!(slim(&json!("str")).is_none());
        let big = json!({"id": "1", "channel_id": "2", "content": "x".repeat(100_000)});
        assert_eq!(slim(&big).unwrap()["content"].as_str().unwrap().len(), MAX_CONTENT);
        let mut m = msg(1, 2, "");
        m["mentions"] = json!([{"id": "7", "username": "a"}, "8", {"id": "bad"}]);
        assert_eq!(slim(&m).unwrap()["mentions"], json!(["7", "8"]));
    }

    #[test]
    fn delete_edit_roundtrip_survives_reload() {
        let d = tmp("rt");
        let l = log_at(&d, TEXT_CAP);
        l.invoke("seen", &json!({"messages": [msg(10, 2, "a"), msg(11, 2, "b")]})).unwrap();
        // delete of a message the page no longer has: comes from the seen cache
        let r = l.invoke("delete", &json!({"channelId": "2", "items": [{"id": "10", "at": 5}]})).unwrap();
        assert_eq!(r[0]["message"]["content"], "a");
        l.invoke("edit", &json!({"channelId": "2", "id": "11", "content": "b0", "at": 7})).unwrap();
        let h = l.invoke("edit", &json!({"channelId": "2", "id": "11", "content": "b1", "at": 8, "max": 1})).unwrap();
        assert_eq!(h, json!([{"content": "b1", "replacedAt": 8}]));
        drop(l);
        let l = log_at(&d, TEXT_CAP);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(9, 2, "z"), msg(11, 2, "b2")]})).unwrap();
        assert_eq!(p["deleted"][0]["message"]["id"], "10");
        assert_eq!(p["deleted"][0]["deletedAt"], 5);
        assert_eq!(p["edits"]["11"][0]["content"], "b1");
        // remove → gone after reload too
        l.invoke("remove", &json!({"channelId": "2", "id": "10"})).unwrap();
        drop(l);
        let l = log_at(&d, TEXT_CAP);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(9, 2, "z"), msg(11, 2, "b2")]})).unwrap();
        assert_eq!(p["deleted"], json!([]));
        l.invoke("clearChannel", &json!({"channelId": "2"})).unwrap();
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(9, 2, "z"), msg(11, 2, "b2")]})).unwrap();
        assert_eq!(p["edits"], json!({}));
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn rejects_untrusted_args() {
        let d = tmp("bad");
        let l = log_at(&d, TEXT_CAP);
        for (cmd, a) in [
            ("delete", json!({"channelId": "../../etc", "items": []})),
            ("delete", json!({"channelId": "1/2", "items": []})),
            ("edit", json!({"channelId": "1", "id": "x", "content": "a"})),
            ("seen", json!({"messages": vec![json!({}); MAX_BATCH + 1]})),
            ("lookup", json!({"channelId": "1"})),
            ("nope", json!({})),
        ] {
            assert!(l.invoke(cmd, &a).is_err(), "{cmd} {a}");
        }
        // a delete carrying a message for another channel/id falls back to the seen cache (none here)
        let r = l.invoke("delete", &json!({"channelId": "1", "items": [{"id": "3", "message": msg(4, 1, "x")}]})).unwrap();
        assert_eq!(r, json!([]));
        // nothing outside the log dir
        assert!(!d.join("../etc").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn offline_detection_only_inside_page() {
        let d = tmp("off");
        let l = log_at(&d, TEXT_CAP);
        let seen: Vec<Value> = (10..=20).map(|i| msg(i, 2, "c")).collect();
        l.invoke("seen", &json!({"messages": seen})).unwrap();
        // ephemeral messages are never recorded (never in history)
        let mut eph = msg(15, 3, "e");
        eph["flags"] = json!(64);
        l.invoke("seen", &json!({"messages": [eph]})).unwrap();
        // page has 12..=18 except 14 and 16; 10, 11, 19, 20 are outside it
        let page: Vec<Value> = [12, 13, 15, 17, 18].iter().map(|&i| msg(i, 2, "c")).collect();
        let p = l.invoke("page", &json!({"channelId": "2", "messages": page, "detect": true})).unwrap();
        let ids: Vec<&str> = p["offline"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["14", "16"]);
        // detect off → nothing
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(12, 2, "c"), msg(18, 2, "c")]})).unwrap();
        assert_eq!(p["offline"], json!([]));
        // single-message page has no inside
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(12, 2, "c")], "detect": true})).unwrap();
        assert_eq!(p["offline"], json!([]));
        // page messages from another channel are ignored entirely
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [msg(10, 9, "c"), msg(20, 9, "c")], "detect": true})).unwrap();
        assert_eq!(p["offline"], json!([]));
        // ephemeral one in channel 3 isn't flagged
        let p = l.invoke("page", &json!({"channelId": "3", "messages": [msg(14, 3, "c"), msg(16, 3, "c")], "detect": true})).unwrap();
        assert_eq!(p["offline"], json!([]));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn offline_edit_needs_newer_edited_timestamp() {
        let d = tmp("edit");
        let l = log_at(&d, TEXT_CAP);
        l.invoke("seen", &json!({"messages": [msg(10, 2, "old"), msg(11, 2, "same")]})).unwrap();
        let mut e = msg(10, 2, "new");
        e["edited_timestamp"] = json!("2026-11-27T11:00:00.000000+00:00");
        let mut noedit = msg(11, 2, "other");
        noedit["edited_timestamp"] = Value::Null;
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [e, noedit], "detect": true})).unwrap();
        assert_eq!(p["changed"]["10"]["content"], "old");
        assert!(p["changed"].get("11").is_none());
        // seen now holds the new content: no second report
        let mut e2 = msg(10, 2, "new");
        e2["edited_timestamp"] = json!("2026-11-27T11:00:00.000000+00:00");
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [e2], "detect": true})).unwrap();
        assert_eq!(p["changed"], json!({}));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn restore_range_respects_open_ends() {
        let d = tmp("range");
        let l = log_at(&d, TEXT_CAP);
        l.invoke("seen", &json!({"messages": [msg(5, 2, "a"), msg(15, 2, "b"), msg(25, 2, "c")]})).unwrap();
        l.invoke("delete", &json!({"channelId": "2", "items": [{"id": "5"}, {"id": "15"}, {"id": "25"}]})).unwrap();
        let page = json!([msg(10, 2, "x"), msg(20, 2, "y")]);
        let ids = |p: &Value| -> Vec<String> { p["deleted"].as_array().unwrap().iter().map(|r| r["message"]["id"].as_str().unwrap().to_owned()).collect() };
        let p = l.invoke("page", &json!({"channelId": "2", "messages": page})).unwrap();
        assert_eq!(ids(&p), ["15"]);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": page, "openAfter": true})).unwrap();
        assert_eq!(ids(&p), ["15", "25"]);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": page, "openBefore": true, "openAfter": true})).unwrap();
        assert_eq!(ids(&p), ["5", "15", "25"]);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": [], "openBefore": true, "openAfter": true})).unwrap();
        assert_eq!(ids(&p).len(), 3);
        let p = l.invoke("page", &json!({"channelId": "2", "messages": []})).unwrap();
        assert_eq!(ids(&p).len(), 0);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn compaction_and_seen_expiry() {
        let d = tmp("compact");
        let l = log_at(&d, TEXT_CAP);
        for i in 0..400 {
            l.invoke("seen", &json!({"messages": [msg(10, 2, &format!("v{i}"))]})).unwrap();
        }
        let lines = fs::read_to_string(d.join("ch/2.jsonl")).unwrap().lines().count();
        assert!(lines < 250, "{lines} lines");
        // expiry: seenDays 0 drops records older than now; craft an old line
        fs::write(d.join("ch/3.jsonl"), format!("{}\n", json!({"s": slim(&msg(1, 3, "old")).unwrap(), "t": 1}))).unwrap();
        l.invoke("sweep", &json!({})).unwrap();
        assert!(!d.join("ch/3.jsonl").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn startup_sweep_is_rate_limited_and_skips_changed_files() {
        let d = tmp("sweepgate");
        let old_line = |ch: u64| format!("{}\n", json!({"s": slim(&msg(1, ch, "old")).unwrap(), "t": 1}));
        let l = log_at(&d, TEXT_CAP);
        fs::create_dir_all(d.join("ch")).unwrap();
        fs::write(d.join("ch/3.jsonl"), old_line(3)).unwrap();
        l.sweep(false);
        assert!(!d.join("ch/3.jsonl").exists(), "first startup sweep expires");
        assert!(d.join("swept").exists());
        // within SWEEP_EVERY: a startup sweep leaves files alone, a forced one doesn't
        fs::write(d.join("ch/4.jsonl"), old_line(4)).unwrap();
        l.sweep(false);
        assert!(d.join("ch/4.jsonl").exists());
        l.invoke("sweep", &json!({})).unwrap();
        assert!(!d.join("ch/4.jsonl").exists());
        // a file appended to between the unlocked read and the rewrite is left alone
        fs::write(d.join("ch/5.jsonl"), old_line(5)).unwrap();
        let r = l.sweep_file(5, now_ms() / 1000, |_| {
            fs::OpenOptions::new().append(true).open(d.join("ch/5.jsonl")).unwrap().write_all(old_line(5).as_bytes()).unwrap();
            true
        });
        assert_eq!(r, None);
        assert_eq!(fs::read_to_string(d.join("ch/5.jsonl")).unwrap().lines().count(), 2);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn text_cap_evicts_seen_before_history() {
        let d = tmp("cap");
        let l = log_at(&d, 6000);
        let big = "x".repeat(1000);
        // channel 2: old, only seen; channel 3: newer, one deleted + seen
        let seen2: Vec<Value> = (1..=4).map(|i| msg(i, 2, &big)).collect();
        l.invoke("seen", &json!({"messages": seen2})).unwrap();
        let old = SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::File::options().append(true).open(d.join("ch/2.jsonl")).unwrap().set_modified(old).unwrap();
        let seen3: Vec<Value> = (1..=4).map(|i| msg(i, 3, &big)).collect();
        l.invoke("seen", &json!({"messages": seen3})).unwrap();
        l.invoke("delete", &json!({"channelId": "3", "items": [{"id": "1"}]})).unwrap();
        l.invoke("sweep", &json!({})).unwrap();
        // channel 2 (oldest) lost its seen records; channel 3's history is intact
        assert!(!d.join("ch/2.jsonl").exists());
        let l2 = log_at(&d, 6000);
        let p = l2.invoke("page", &json!({"channelId": "3", "messages": [], "openBefore": true, "openAfter": true})).unwrap();
        assert_eq!(p["deleted"].as_array().unwrap().len(), 1);
        let total: u64 = fs::read_dir(d.join("ch")).unwrap().flatten().map(|e| e.metadata().unwrap().len()).sum();
        assert!(total <= 6000, "{total}");
        // a tighter cap then removes history too
        let l3 = log_at(&d, 100);
        l3.invoke("sweep", &json!({})).unwrap();
        assert!(!d.join("ch/3.jsonl").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn persist_off_writes_nothing() {
        let d = tmp("mem");
        let l = log_at(&d, TEXT_CAP);
        l.invoke("init", &json!({"persist": false})).unwrap();
        l.invoke("seen", &json!({"messages": [msg(10, 2, "a")]})).unwrap();
        let r = l.invoke("delete", &json!({"channelId": "2", "items": [{"id": "10"}]})).unwrap();
        assert_eq!(r.as_array().unwrap().len(), 1);
        assert!(!d.join("ch").exists());
        let s = l.invoke("stats", &json!({})).unwrap();
        assert_eq!(s["deleted"], 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn timestamps() {
        assert_eq!(ts_ms("1970-01-01T00:00:00+00:00"), Some(0));
        assert_eq!(ts_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(ts_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert!(ts_ms("2026-11-27T11:00:00.000000+00:00") > ts_ms("2026-11-27T10:59:59.999+00:00"));
        assert_eq!(ts_ms("garbage"), None);
    }

    /// Channel-open latency against a week-sized store. Not a unit test:
    ///   cargo test --release -p corvid-core bench_msglog -- --ignored --nocapture
    /// Env: BENCH_CH (channels, default 150), BENCH_PER (messages each, 2000).
    #[test]
    #[ignore]
    fn bench_msglog() {
        use std::time::{Duration, Instant};
        let env = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (n_ch, per) = (env("BENCH_CH", 150), env("BENCH_PER", 2000));
        let body = "lorem ipsum dolor sit amet ".repeat(8);
        let t = now_ms() / 1000;
        let fill = |d: &Path| {
            let _ = fs::remove_dir_all(d);
            fs::create_dir_all(d.join("ch")).unwrap();
            for ch in 1..=n_ch {
                let mut buf = String::new();
                for i in 0..per {
                    let s = slim(&msg(ch * 1_000_000 + i, ch, &body)).unwrap();
                    // seen twice (12 h refresh): files are never compact
                    for _ in 0..2 {
                        buf.push_str(&json!({"s": s, "t": t}).to_string());
                        buf.push('\n');
                    }
                }
                fs::write(d.join(format!("ch/{ch}.jsonl")), buf).unwrap();
            }
        };
        let page = |ch: u64, from: u64| {
            let msgs: Vec<Value> = (from..from + 50).map(|i| msg(ch * 1_000_000 + i, ch, &body)).collect();
            json!({"channelId": ch.to_string(), "messages": msgs, "detect": true})
        };
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
        let d = tmp("bench");
        fill(&d);
        let size: u64 = fs::read_dir(d.join("ch")).unwrap().flatten().map(|e| e.metadata().unwrap().len()).sum();
        eprintln!("store: {n_ch} channels x {per} msgs, {} MB", size >> 20);

        // 1. startup: sweep runs in the background, the first channel opens right away
        let l = Arc::new(log_at(&d, TEXT_CAP));
        let t0 = Instant::now();
        l.sweep_in_background();
        std::thread::sleep(Duration::from_millis(5));
        let t1 = Instant::now();
        l.invoke("page", &page(7, 100)).unwrap();
        eprintln!("first page during startup sweep: {:.1} ms", ms(t1));
        // wait for the sweep to finish
        while !d.join("swept").exists() { std::thread::sleep(Duration::from_millis(2)); }
        drop(l.store.lock().unwrap());
        eprintln!("(sweep done after {:.1} ms)", ms(t0));

        // 2. steady state (compact files): cold channel, then the same channel again
        let l = log_at(&d, TEXT_CAP);
        let t1 = Instant::now();
        l.invoke("page", &page(9, 300)).unwrap();
        eprintln!("cold page: {:.2} ms", ms(t1));
        let mut warm = Vec::new();
        for k in 0..20 {
            let t1 = Instant::now();
            l.invoke("page", &page(9, 400 + k * 50)).unwrap();
            warm.push(ms(t1));
        }
        warm.sort_by(|a, b| a.partial_cmp(b).unwrap());
        eprintln!("warm page: median {:.3} ms, max {:.3} ms", warm[10], warm[19]);
        // 3. a full seen batch (400 new messages) in a loaded channel
        let msgs: Vec<Value> = (0..400).map(|i| msg(9 * 1_000_000 + per + i, 9, &body)).collect();
        let t1 = Instant::now();
        l.invoke("seen", &json!({"messages": msgs})).unwrap();
        eprintln!("seen batch of 400: {:.2} ms", ms(t1));
        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod bench_mem {
    use super::*;

    fn rss_kb() -> u64 {
        fs::read_to_string("/proc/self/status").unwrap().lines()
            .find_map(|l| l.strip_prefix("VmRSS:")).and_then(|v| v.trim().trim_end_matches(" kB").trim().parse().ok()).unwrap_or(0)
    }

    /// Resident memory of MAX_LOADED channels loaded with seen records:
    ///   cargo test --release -p corvid-core bench_msglog_mem -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_msglog_mem() {
        let per: u64 = std::env::var("BENCH_PER").ok().and_then(|v| v.parse().ok()).unwrap_or(2000);
        let d = std::env::temp_dir().join(format!("corvid-msglog-mem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("ch")).unwrap();
        let body = "lorem ipsum dolor sit amet ".repeat(8);
        let t = now_ms() / 1000;
        for ch in 1..=MAX_LOADED as u64 {
            let mut buf = String::new();
            for i in 0..per {
                let m = json!({"id": (ch * 1_000_000 + i).to_string(), "channel_id": ch.to_string(), "content": body,
                    "timestamp": "2026-11-27T10:00:00.000000+00:00", "edited_timestamp": null,
                    "author": {"id": "5", "username": "someone", "global_name": "Someone", "avatar": "0123456789abcdef0123456789abcdef"},
                    "attachments": [], "embeds": [], "flags": 0, "type": 0});
                buf.push_str(&json!({"s": slim(&m).unwrap(), "t": t}).to_string());
                buf.push('\n');
            }
            fs::write(d.join(format!("ch/{ch}.jsonl")), buf).unwrap();
        }
        let disk: u64 = fs::read_dir(d.join("ch")).unwrap().flatten().map(|e| e.metadata().unwrap().len()).sum();
        let l = MsgLog::with(d.clone(), Arc::new(crate::msgmedia::MediaCache::new(d.clone(), "")), TEXT_CAP);
        let before = rss_kb();
        for ch in 1..=MAX_LOADED as u64 {
            l.invoke("lookup", &json!({"channelId": ch.to_string(), "ids": []})).unwrap();
        }
        let after = rss_kb();
        eprintln!("{} channels x {per} seen: disk {} MB, RSS +{} MB", MAX_LOADED, disk >> 20, (after - before) >> 10);
        let _ = fs::remove_dir_all(&d);
    }
}
