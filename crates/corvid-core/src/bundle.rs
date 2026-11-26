//! The script injected into Discord's main frame at document start:
//! config + js/core.js + js/plugins/*.js. Embedded at build time; set
//! `CORVID_JS_DIR=<repo>/js` to load from disk instead (no rebuild while
//! hacking on plugins).

use std::{fs, path::Path};

use serde_json::Value;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_js.rs"));
}

pub struct Sources {
    pub core: String,
    pub plugins: Vec<(String, String)>,
}

impl Sources {
    pub fn load() -> Self {
        if let Some(dir) = std::env::var_os("CORVID_JS_DIR") {
            match Self::from_dir(Path::new(&dir)) {
                Ok(s) => return s,
                Err(e) => log::error!("CORVID_JS_DIR: {e}; using embedded JS"),
            }
        }
        Self {
            core: embedded::CORE_JS.to_owned(),
            plugins: embedded::PLUGINS_JS.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect(),
        }
    }

    fn from_dir(dir: &Path) -> std::io::Result<Self> {
        let core = fs::read_to_string(dir.join("core.js"))?;
        let mut plugins: Vec<(String, String)> = fs::read_dir(dir.join("plugins"))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "js"))
            .filter_map(|e| Some((e.file_name().into_string().ok()?, fs::read_to_string(e.path()).ok()?)))
            .collect();
        plugins.sort();
        Ok(Self { core, plugins })
    }
}

/// `config` must serialize to an object; it becomes `CORVID_CFG`.
pub fn assemble(config: &Value, src: &Sources) -> String {
    with_config(&config.to_string(), &body(src))
}

/// Prefix a bundle body with its config (a JSON object literal). The block
/// keeps `CORVID_CFG` (settings, callback token) out of the page's global
/// lexical scope, where Discord's own scripts could read it.
/// It goes in as `JSON.parse("…")`: plain data (a `"__proto__"` key in
/// settings.json stays a key instead of setting a prototype), and V8 parses
/// JSON faster than an object literal of the same size.
pub fn with_config(config_json: &str, body: &str) -> String {
    let lit = serde_json::to_string(config_json).expect("string serializes");
    format!("{{ const CORVID_CFG = JSON.parse({lit});\n{body}\n}}\n")
}

/// core.js + plugins, without the config line.
pub fn body(src: &Sources) -> String {
    let mut s = String::with_capacity(src.core.len() + src.plugins.iter().map(|p| p.1.len() + 128).sum::<usize>() + 256);
    s.push_str(&src.core);
    s.push_str("\n;(corvid => {\n");
    for (name, body) in &src.plugins {
        // Each plugin in its own scope; one broken plugin doesn't stop the rest.
        s.push_str("try { (() => {\n");
        s.push_str(body);
        s.push_str(&format!(
            "\n}})(); }} catch (e) {{ console.error(\"[corvid] plugin file {} failed\", e); }}\n",
            name.escape_default()
        ));
    }
    s.push_str("})(globalThis.__corvidDefine);\ndelete globalThis.__corvidDefine;\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_core_present() {
        let s = Sources::load();
        assert!(s.core.contains("webpackChunkdiscord_app"));
        let out = assemble(&serde_json::json!({"token": "t"}), &s);
        assert!(out.starts_with(r#"{ const CORVID_CFG = JSON.parse("{\"token\":\"t\"}");"#));
        assert!(out.trim_end().trim_end_matches('}').trim_end().ends_with("delete globalThis.__corvidDefine;"));
    }
}
