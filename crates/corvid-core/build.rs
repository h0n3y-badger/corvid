// Embed js/core.js and every js/plugins/*.js (sorted) into the binary.
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let js = manifest.join("../../js").canonicalize().expect("js/ dir");
    let plugins_dir = js.join("plugins");
    println!("cargo::rerun-if-changed={}", js.join("core.js").display());
    println!("cargo::rerun-if-changed={}", plugins_dir.display());
    let mut files: Vec<PathBuf> = fs::read_dir(&plugins_dir)
        .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().is_some_and(|e| e == "js"));
    files.sort();
    let mut out = String::new();
    out.push_str(&format!("pub const CORE_JS: &str = include_str!({:?});\n", js.join("core.js")));
    out.push_str("pub const PLUGINS_JS: &[(&str, &str)] = &[\n");
    for f in &files {
        println!("cargo::rerun-if-changed={}", f.display());
        let name = f.file_name().unwrap().to_string_lossy();
        out.push_str(&format!("    ({name:?}, include_str!({f:?})),\n"));
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("embedded_js.rs"), out).unwrap();
}
