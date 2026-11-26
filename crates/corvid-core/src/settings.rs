//! settings.json. The page owns `plugins`; the host owns `themes` and reads
//! `host` (options that need a restart).

use std::{fs, io, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::util::{to_json_4, write_atomic};

/// Host options (`settings.host`). Every field has a privacy/perf-first default.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HostOptions {
    /// Answer Discord analytics/metrics/Sentry requests locally (204).
    pub block_telemetry: bool,
    /// WebRTC only offers the default public interface (no LAN/VPN IPs).
    pub hide_local_ips: bool,
    /// Chromium downloads spellcheck dictionaries from Google.
    pub spellcheck: bool,
    pub gpu: bool,
    /// Fetch theme @import/url() assets in the host and inline them.
    pub remote_theme_assets: bool,
    /// Chromium proxy, e.g. "socks5://127.0.0.1:9050". Empty = system/direct.
    pub proxy: String,
    /// V8 --optimize-for-size: ~115 MB (13%) less PSS for ~0.2 s
    /// slower startup (measured 2026-11-24 on Discord idle).
    pub compact_heap: bool,
    /// Fewer processes and smaller caches at some cost in isolation/speed.
    pub low_memory: bool,
    /// Play H.264/HEVC/AAC videos and GIFs (the bundled Chromium has no such
    /// decoders) by converting them to WebM with ffmpeg. See media.rs.
    pub transcode_media: bool,
    /// Window background before Discord paints (ARGB), avoids a white flash.
    pub background: u32,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            block_telemetry: true,
            hide_local_ips: true,
            spellcheck: false,
            gpu: true,
            remote_theme_assets: true,
            proxy: String::new(),
            compact_heap: true,
            low_memory: false,
            transcode_media: true,
            background: 0xFF31_3338,
        }
    }
}

pub fn load(path: &Path) -> Value {
    let v = match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            log::error!("{}: {e}; starting with defaults", path.display());
            // keep the broken file for the user
            let _ = fs::copy(path, path.with_extension("json.broken"));
            Value::Null
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Value::Null,
        Err(e) => {
            log::error!("{}: {e}", path.display());
            Value::Null
        }
    };
    match v {
        Value::Object(_) => v,
        _ => Value::Object(Map::new()),
    }
}

pub fn save(path: &Path, v: &Value) -> io::Result<()> {
    write_atomic(path, &to_json_4(v))
}

pub fn host_options(settings: &Value) -> HostOptions {
    settings
        .get("host")
        .and_then(|h| serde_json::from_value(h.clone()).ok())
        .unwrap_or_default()
}

pub fn enabled_themes(settings: &Value) -> Vec<String> {
    settings
        .pointer("/themes/enabled")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

pub fn set_enabled_themes(settings: &mut Value, list: &[String]) {
    let obj = settings.as_object_mut().expect("settings is an object");
    let themes = obj.entry("themes").or_insert_with(|| Value::Object(Map::new()));
    if !themes.is_object() {
        *themes = Value::Object(Map::new());
    }
    themes["enabled"] = Value::from(list.to_vec());
}

/// Merge a page-sent settings object: everything but `themes` comes from the
/// page (the host is authoritative for themes).
pub fn merge_from_page(current: &Value, mut incoming: Value) -> Option<Value> {
    let obj = incoming.as_object_mut()?;
    match current.get("themes") {
        Some(t) => obj.insert("themes".into(), t.clone()),
        None => obj.remove("themes"),
    };
    Some(incoming)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn host_defaults_and_partial() {
        assert_eq!(host_options(&json!({})), HostOptions::default());
        let o = host_options(&json!({"host": {"gpu": false, "proxy": "socks5://x"}}));
        assert!(!o.gpu && o.block_telemetry && o.proxy == "socks5://x");
        // wrong types fall back to defaults instead of failing
        assert_eq!(host_options(&json!({"host": {"gpu": "no"}})), HostOptions::default());
    }

    #[test]
    fn page_cannot_overwrite_themes() {
        let cur = json!({"themes": {"enabled": ["a.css"]}, "plugins": {}});
        let page = json!({"themes": {"enabled": ["evil.css"]}, "plugins": {"X": {"enabled": true}}});
        let m = merge_from_page(&cur, page).unwrap();
        assert_eq!(enabled_themes(&m), vec!["a.css"]);
        assert_eq!(m["plugins"]["X"]["enabled"], true);
        assert!(merge_from_page(&cur, json!([1])).is_none());
    }

    #[test]
    fn set_themes() {
        let mut s = json!({});
        set_enabled_themes(&mut s, &["x.css".into()]);
        assert_eq!(enabled_themes(&s), vec!["x.css"]);
    }
}
