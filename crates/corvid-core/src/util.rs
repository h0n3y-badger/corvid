use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

/// Write via a temp file + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

/// Mirror of Equicord's `ensureSafePath`: `name` must resolve to a direct
/// child of `base` (no separators, no `..`, not empty).
pub fn safe_child(base: &Path, name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    let mut comps = p.components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(c)), None) if !c.is_empty() => Some(base.join(c)),
        _ => None,
    }
}

/// JSON pretty-printed with 4-space indents, like `JSON.stringify(x, null, 4)`.
pub fn to_json_4(v: &serde_json::Value) -> Vec<u8> {
    use serde::Serialize;
    let mut out = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut out, fmt);
    v.serialize(&mut ser).expect("serializing a Value cannot fail");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_child_rejects_traversal() {
        let b = Path::new("/base");
        assert_eq!(safe_child(b, "a.css"), Some(PathBuf::from("/base/a.css")));
        for bad in ["", "..", "../x.css", "a/b.css", "/etc/passwd", "."] {
            assert_eq!(safe_child(b, bad), None, "{bad:?}");
        }
    }
}
