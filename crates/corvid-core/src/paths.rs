use std::{env, path::PathBuf};

/// On-disk layout below the corvid data dir.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    /// settings.json: plugin settings (owned by the page) + host options.
    pub settings_file: PathBuf,
    pub themes_dir: PathBuf,
    pub quick_css: PathBuf,
    /// Chromium profile (cookies = your Discord login, cache). Kept apart from settings.
    pub profile_dir: PathBuf,
    /// Cached remote theme assets ($XDG_CACHE_HOME/corvid/theme-assets).
    pub asset_cache: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            settings_file: data_dir.join("settings.json"),
            themes_dir: data_dir.join("themes"),
            quick_css: data_dir.join("quick.css"),
            profile_dir: data_dir.join("profile"),
            asset_cache: cache_dir.join("theme-assets"),
            data_dir,
        }
    }

    /// `$CORVID_DATA_DIR`, else `$XDG_CONFIG_HOME/corvid`, else `~/.config/corvid`.
    pub fn from_env() -> Self {
        let home = env::var_os("HOME").map(PathBuf::from);
        let dir = env::var_os("CORVID_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| env::var_os("XDG_CONFIG_HOME").map(|d| PathBuf::from(d).join("corvid")))
            .or_else(|| home.as_ref().map(|h| h.join(".config/corvid")))
            .expect("neither CORVID_DATA_DIR, XDG_CONFIG_HOME nor HOME is set");
        let cache = env::var_os("XDG_CACHE_HOME")
            .map(|d| PathBuf::from(d).join("corvid"))
            .or_else(|| home.map(|h| h.join(".cache/corvid")))
            .unwrap_or_else(|| dir.join("cache"));
        Self::new(dir, cache)
    }

    pub fn create_dirs(&self) -> std::io::Result<()> {
        for d in [&self.data_dir, &self.themes_dir, &self.profile_dir] {
            std::fs::create_dir_all(d)?;
        }
        // Equicord-era quick CSS, if any, becomes the new quick.css once.
        let old = self.data_dir.join("settings/quickCss.css");
        if !self.quick_css.exists() && old.exists() {
            let _ = std::fs::copy(&old, &self.quick_css);
        }
        Ok(())
    }
}
