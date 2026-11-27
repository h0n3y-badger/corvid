//! Engine-independent host: settings, themes + quick CSS (compiled, watched,
//! pushed live), and the small command surface the page may call.
//!
//! The page is Discord's web app, so treat every command as untrusted input:
//! nothing here reads arbitrary files, runs commands or opens non-web URLs.

use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{Value, json};

use crate::{
    Paths,
    assets::{self, AssetCache},
    settings::{self, HostOptions},
    themes,
    util::{safe_child, write_atomic},
};

/// What the engine backend provides.
pub trait Ui: Send + Sync + 'static {
    /// Replace (or with `None`, remove) a stylesheet in the page.
    fn set_css(&self, id: &str, css: Option<&str>);
    /// Fire `corvid.on(name)` listeners in the page.
    fn emit(&self, name: &str, payload: Value);
    fn open_external(&self, target: &str);
    fn relaunch(&self);
    fn versions(&self) -> Value;
}

pub struct Host {
    pub paths: Paths,
    pub options: HostOptions,
    /// MessageLogger store (msglog.* commands, cached media lookups).
    pub msglog: Arc<crate::msglog::MsgLog>,
    settings: Mutex<Value>,
    cache: AssetCache,
    /// Compiled CSS by sheet id, as last pushed.
    sheets: Mutex<HashMap<String, String>>,
    ui: Mutex<Option<Arc<dyn Ui>>>,
    fetching: Mutex<std::collections::HashSet<String>>,
    /// Last page-requested open.external (rate limit).
    last_open: Mutex<Option<std::time::Instant>>,
}

/// Page-sent quick CSS / settings bigger than this are refused (settings.json
/// is read at every start and copied into every document).
const MAX_QUICKCSS: usize = 1 << 20;
const MAX_SETTINGS: usize = 2 << 20;

pub type CmdResult = Result<Value, String>;

const QUICKCSS_ID: &str = "quickcss";
fn theme_id(file: &str) -> String {
    format!("theme:{file}")
}

impl Host {
    pub fn new(paths: Paths) -> std::io::Result<Arc<Self>> {
        paths.create_dirs()?;
        let s = settings::load(&paths.settings_file);
        let options = settings::host_options(&s);
        let cache = AssetCache::new(paths.asset_cache.clone(), options.remote_theme_assets, &options.proxy);
        let msglog = Arc::new(crate::msglog::MsgLog::new(paths.msglog_dir.clone(), &options.proxy));
        Ok(Arc::new(Self {
            paths,
            msglog,
            options,
            settings: Mutex::new(s),
            cache,
            sheets: Mutex::new(HashMap::new()),
            ui: Mutex::new(None),
            fetching: Mutex::new(Default::default()),
            last_open: Mutex::new(None),
        }))
    }

    pub fn set_ui(&self, ui: Arc<dyn Ui>) {
        *self.ui.lock().unwrap() = Some(ui);
    }

    fn ui(&self) -> Option<Arc<dyn Ui>> {
        self.ui.lock().unwrap().clone()
    }

    pub fn settings(&self) -> Value {
        self.settings.lock().unwrap().clone()
    }

    /// Initial sheets for the injected config: `[[id, css], ...]`. Reads only
    /// local files and the asset cache; missing remote assets are fetched in
    /// the background and pushed when they arrive.
    pub fn initial_css(self: &Arc<Self>) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for file in settings::enabled_themes(&self.settings.lock().unwrap()) {
            if let Some(css) = self.compile_theme(&file) {
                out.push((theme_id(&file), css));
            }
        }
        if let Some(css) = self.compile_file(&self.paths.quick_css, QUICKCSS_ID) {
            out.push((QUICKCSS_ID.into(), css));
        }
        let mut sheets = self.sheets.lock().unwrap();
        for (id, css) in &out {
            sheets.insert(id.clone(), css.clone());
        }
        out
    }

    /// The sheets as last compiled/pushed, in `initial_css` order, without
    /// touching disk. Kept current by `refresh_sheet` (watcher, theme toggles,
    /// quick CSS edits, finished asset fetches).
    pub fn css_snapshot(&self) -> Vec<(String, String)> {
        let mut ids: Vec<String> = settings::enabled_themes(&self.settings.lock().unwrap()).iter().map(|f| theme_id(f)).collect();
        ids.push(QUICKCSS_ID.into());
        let sheets = self.sheets.lock().unwrap();
        ids.into_iter().filter_map(|id| sheets.get(&id).map(|c| (id, c.clone()))).collect()
    }

    fn compile_theme(self: &Arc<Self>, file: &str) -> Option<String> {
        let path = safe_child(&self.paths.themes_dir, file)?;
        self.compile_file(&path, &theme_id(file))
    }

    fn compile_file(self: &Arc<Self>, path: &Path, id: &str) -> Option<String> {
        let raw = fs::read_to_string(path).ok()?;
        let c = assets::compile(themes::strip_bom(&raw), None, &self.cache);
        if !c.fetch.is_empty() {
            self.fetch_then_recompile(c.fetch, id.to_owned());
        }
        Some(c.css)
    }

    fn fetch_then_recompile(self: &Arc<Self>, urls: Vec<String>, id: String) {
        if !self.cache.allow_remote {
            return;
        }
        let urls: Vec<String> = {
            let mut f = self.fetching.lock().unwrap();
            urls.into_iter().filter(|u| f.insert(u.clone())).collect()
        };
        if urls.is_empty() {
            return;
        }
        let host = self.clone();
        std::thread::spawn(move || {
            let mut any = false;
            for u in &urls {
                match host.cache.fetch(u) {
                    Ok(()) => any = true,
                    Err(e) => log::warn!("theme asset: {e}"),
                }
            }
            // Leave failed URLs in `fetching` so a broken link isn't retried in a loop.
            if any {
                host.refresh_sheet(&id);
            }
        });
    }

    /// Recompile one sheet from disk and push it if it changed.
    pub fn refresh_sheet(self: &Arc<Self>, id: &str) {
        let css = if id == QUICKCSS_ID {
            self.compile_file(&self.paths.quick_css, id)
        } else if let Some(file) = id.strip_prefix("theme:") {
            let enabled = settings::enabled_themes(&self.settings.lock().unwrap()).iter().any(|f| f == file);
            if enabled { self.compile_theme(file) } else { None }
        } else {
            return;
        };
        let mut sheets = self.sheets.lock().unwrap();
        let changed = match &css {
            Some(c) => sheets.get(id) != Some(c),
            None => sheets.contains_key(id),
        };
        if !changed {
            return;
        }
        match &css {
            Some(c) => sheets.insert(id.to_owned(), c.clone()),
            None => sheets.remove(id),
        };
        drop(sheets);
        if let Some(ui) = self.ui() {
            ui.set_css(id, css.as_deref());
        }
    }

    fn theme_list(&self) -> Value {
        let enabled = settings::enabled_themes(&self.settings.lock().unwrap());
        let list: Vec<Value> = themes::list(&self.paths.themes_dir)
            .into_iter()
            .map(|h| {
                let mut v = serde_json::to_value(&h).unwrap_or_default();
                v["enabled"] = Value::Bool(enabled.contains(&h.file_name));
                v
            })
            .collect();
        Value::Array(list)
    }

    fn save_settings(&self, s: &Value) -> Result<(), String> {
        settings::save(&self.paths.settings_file, s).map_err(|e| e.to_string())
    }

    /// Handle a page command. `args` is untrusted JSON.
    pub fn invoke(self: &Arc<Self>, cmd: &str, args: &Value) -> CmdResult {
        let str_arg = |k: &str| args.get(k).and_then(Value::as_str).ok_or_else(|| format!("{cmd}: missing {k}"));
        match cmd {
            "settings.save" => {
                if args.to_string().len() > MAX_SETTINGS {
                    return Err("settings too large".into());
                }
                let mut cur = self.settings.lock().unwrap();
                let merged = settings::merge_from_page(&cur, args.clone()).ok_or("settings must be an object")?;
                self.save_settings(&merged)?;
                *cur = merged;
                Ok(Value::Null)
            }
            "themes.list" => Ok(self.theme_list()),
            "themes.setEnabled" => {
                let file = str_arg("fileName")?.to_owned();
                safe_child(&self.paths.themes_dir, &file).ok_or("bad theme file name")?;
                let on = args.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                {
                    let mut cur = self.settings.lock().unwrap();
                    let mut list = settings::enabled_themes(&cur);
                    list.retain(|f| f != &file);
                    if on {
                        list.push(file.clone());
                    }
                    settings::set_enabled_themes(&mut cur, &list);
                    self.save_settings(&cur)?;
                }
                self.refresh_sheet(&theme_id(&file));
                Ok(Value::Null)
            }
            "themes.openDir" => {
                if let Some(ui) = self.ui() {
                    ui.open_external(&self.paths.themes_dir.to_string_lossy());
                }
                Ok(Value::Null)
            }
            "quickcss.get" => Ok(Value::String(fs::read_to_string(&self.paths.quick_css).unwrap_or_default())),
            "quickcss.set" => {
                let css = str_arg("css")?;
                if css.len() > MAX_QUICKCSS {
                    return Err("quick CSS too large".into());
                }
                write_atomic(&self.paths.quick_css, css.as_bytes()).map_err(|e| e.to_string())?;
                // The watcher would catch it too; push now for snappy live preview.
                self.refresh_sheet(QUICKCSS_ID);
                Ok(Value::Null)
            }
            "quickcss.openEditor" => {
                if !self.paths.quick_css.exists() {
                    let _ = write_atomic(&self.paths.quick_css, b"/* corvid quick CSS */\n");
                }
                if let Some(ui) = self.ui() {
                    ui.open_external(&self.paths.quick_css.to_string_lossy());
                }
                Ok(Value::Null)
            }
            "open.external" => {
                let url = url::Url::parse(str_arg("url")?)
                    .ok()
                    .filter(|u| matches!(u.scheme(), "https" | "http"))
                    .ok_or("only http(s) links can be opened")?;
                // No click is involved here: don't let the page flood the
                // desktop browser with tabs.
                {
                    let mut last = self.last_open.lock().unwrap();
                    if last.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
                        return Err("open.external: too many requests".into());
                    }
                    *last = Some(std::time::Instant::now());
                }
                if let Some(ui) = self.ui() {
                    // The parsed form: what was checked is what xdg-open gets.
                    ui.open_external(url.as_str());
                }
                Ok(Value::Null)
            }
            c if c.starts_with("msglog.") => {
                let r = self.msglog.invoke(&c["msglog.".len()..], args);
                // The plugin has sent its settings (seen-record lifetime): expire and cap, off this thread.
                if c == "msglog.init" {
                    self.msglog.sweep_in_background();
                }
                r
            }
            "app.relaunch" => {
                if let Some(ui) = self.ui() {
                    ui.relaunch();
                }
                Ok(Value::Null)
            }
            "app.info" => {
                let mut v = self.ui().map(|u| u.versions()).unwrap_or_else(|| json!({}));
                // ~ instead of /home/<user>: the page doesn't need the name.
                let dir = self.paths.data_dir.to_string_lossy().into_owned();
                let home = std::env::var("HOME").unwrap_or_default();
                let dir = match dir.strip_prefix(&home) {
                    Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
                    _ => dir,
                };
                v["dataDir"] = Value::String(dir);
                Ok(v)
            }
            _ => Err(format!("unknown command {cmd}")),
        }
    }

    /// Watch the themes dir and quick.css; push changes live.
    pub fn watch(self: &Arc<Self>) -> notify::Result<notify::RecommendedWatcher> {
        use notify::{RecursiveMode, Watcher};
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let mut w = notify::recommended_watcher(tx)?;
        w.watch(&self.paths.themes_dir, RecursiveMode::NonRecursive)?;
        w.watch(&self.paths.data_dir, RecursiveMode::NonRecursive)?;
        let host = self.clone();
        std::thread::Builder::new()
            .name("corvid-watch".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    // Editors write in bursts (tmp file, rename, chmod): coalesce.
                    let mut events = vec![first];
                    while let Ok(e) = rx.recv_timeout(Duration::from_millis(40)) {
                        events.push(e);
                    }
                    let mut quick = false;
                    let mut themes_changed = false;
                    let mut files = std::collections::BTreeSet::new();
                    for ev in events.into_iter().flatten() {
                        if matches!(ev.kind, notify::EventKind::Access(_)) {
                            continue;
                        }
                        for p in ev.paths {
                            if p == host.paths.quick_css {
                                quick = true;
                            } else if p.parent() == Some(host.paths.themes_dir.as_path())
                                && p.extension().is_some_and(|e| e == "css")
                                && let Some(n) = p.file_name().and_then(|n| n.to_str())
                            {
                                themes_changed = true;
                                files.insert(n.to_owned());
                            }
                        }
                    }
                    if quick {
                        host.refresh_sheet(QUICKCSS_ID);
                    }
                    for f in &files {
                        host.refresh_sheet(&theme_id(f));
                    }
                    if themes_changed && let Some(ui) = host.ui() {
                        ui.emit("themes.changed", host.theme_list());
                    }
                }
            })
            .map_err(|e| notify::Error::generic(&e.to_string()))?;
        Ok(w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct TestUi {
        css: Mutex<Vec<(String, Option<String>)>>,
        opened: Mutex<Vec<String>>,
    }
    impl Ui for TestUi {
        fn set_css(&self, id: &str, css: Option<&str>) {
            self.css.lock().unwrap().push((id.into(), css.map(Into::into)));
        }
        fn emit(&self, _: &str, _: Value) {}
        fn open_external(&self, t: &str) {
            self.opened.lock().unwrap().push(t.into());
        }
        fn relaunch(&self) {}
        fn versions(&self) -> Value {
            json!({"corvid": "test"})
        }
    }

    fn host() -> (Arc<Host>, Arc<TestUi>, std::path::PathBuf) {
        let d = std::env::temp_dir().join(format!("corvid-host-{}-{}", std::process::id(), rand::random::<u32>()));
        let mut p = Paths::new(d.join("data"), d.join("cache"));
        p.asset_cache = d.join("cache/assets");
        let h = Host::new(p).unwrap();
        let ui = Arc::new(TestUi::default());
        h.set_ui(ui.clone());
        (h, ui, d)
    }

    #[test]
    fn theme_toggle_pushes_css_and_persists() {
        let (h, ui, _) = host();
        fs::write(h.paths.themes_dir.join("a.css"), "/**\n * @name A\n */\n.a{}").unwrap();
        h.invoke("themes.setEnabled", &json!({"fileName": "a.css", "enabled": true})).unwrap();
        assert_eq!(ui.css.lock().unwrap().last().unwrap().0, "theme:a.css");
        let list = h.invoke("themes.list", &Value::Null).unwrap();
        assert_eq!(list[0]["enabled"], true);
        assert_eq!(list[0]["name"], "A");
        h.invoke("themes.setEnabled", &json!({"fileName": "a.css", "enabled": false})).unwrap();
        assert_eq!(ui.css.lock().unwrap().last().unwrap(), &("theme:a.css".into(), None));
        // persisted
        let s = settings::load(&h.paths.settings_file);
        assert!(settings::enabled_themes(&s).is_empty());
    }

    #[test]
    fn rejects_bad_input() {
        let (h, ui, _) = host();
        assert!(h.invoke("themes.setEnabled", &json!({"fileName": "../x.css", "enabled": true})).is_err());
        assert!(h.invoke("open.external", &json!({"url": "file:///etc/passwd"})).is_err());
        assert!(h.invoke("open.external", &json!({"url": "javascript:alert(1)"})).is_err());
        assert!(h.invoke("settings.save", &json!("nope")).is_err());
        assert!(h.invoke("nope", &Value::Null).is_err());
        assert!(ui.opened.lock().unwrap().is_empty());
        h.invoke("open.external", &json!({"url": "https://example.com"})).unwrap();
        assert_eq!(ui.opened.lock().unwrap().len(), 1);
    }

    #[test]
    fn quickcss_roundtrip_and_initial() {
        let (h, ui, _) = host();
        h.invoke("quickcss.set", &json!({"css": ".q{color:red}"})).unwrap();
        assert_eq!(h.invoke("quickcss.get", &Value::Null).unwrap(), ".q{color:red}");
        assert_eq!(ui.css.lock().unwrap().last().unwrap().1.as_deref(), Some(".q{color:red}"));
        let init = h.initial_css();
        assert!(init.iter().any(|(id, c)| id == "quickcss" && c == ".q{color:red}"));
        assert_eq!(h.css_snapshot(), init);
    }

    #[test]
    fn snapshot_tracks_toggles_in_order() {
        let (h, _, _) = host();
        fs::write(h.paths.themes_dir.join("b.css"), ".b{}").unwrap();
        fs::write(h.paths.themes_dir.join("a.css"), ".a{}").unwrap();
        h.invoke("quickcss.set", &json!({"css": ".q{}"})).unwrap();
        h.invoke("themes.setEnabled", &json!({"fileName": "b.css", "enabled": true})).unwrap();
        h.invoke("themes.setEnabled", &json!({"fileName": "a.css", "enabled": true})).unwrap();
        assert_eq!(h.css_snapshot(), h.initial_css());
        let ids: Vec<String> = h.css_snapshot().into_iter().map(|(i, _)| i).collect();
        assert_eq!(ids, ["theme:b.css", "theme:a.css", "quickcss"]);
        h.invoke("themes.setEnabled", &json!({"fileName": "b.css", "enabled": false})).unwrap();
        assert_eq!(h.css_snapshot(), vec![("theme:a.css".into(), ".a{}".into()), ("quickcss".into(), ".q{}".into())]);
    }

    #[test]
    fn page_settings_save_keeps_host_themes() {
        let (h, _, _) = host();
        fs::write(h.paths.themes_dir.join("t.css"), ".t{}").unwrap();
        h.invoke("themes.setEnabled", &json!({"fileName": "t.css", "enabled": true})).unwrap();
        h.invoke("settings.save", &json!({"plugins": {"X": {"enabled": true}}})).unwrap();
        let s = h.settings();
        assert_eq!(settings::enabled_themes(&s), vec!["t.css"]);
        assert_eq!(s["plugins"]["X"]["enabled"], true);
    }
}
