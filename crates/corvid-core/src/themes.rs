//! User theme listing and BetterDiscord-style meta header parsing.
//! Ported from BetterDiscord's addon meta parser (Apache-2.0, via Vencord
//! src/main/themes/index.ts). SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, fs, path::Path};

use serde::Serialize;

use crate::util::safe_child;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserThemeHeader {
    pub file_name: String,
    pub name: String,
    pub author: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite: Option<String>,
}

pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Upstream splits the meta block with
/// `/[^\S\r\n]*?\r?(?:\r\n|\n)[^\S\r\n]*?\*[^\S\r\n]?/`: a newline, then
/// optional horizontal space, a `*`, and at most one horizontal space.
/// Lines without the leading `*` are NOT split points.
fn split_meta_lines(block: &str) -> Vec<String> {
    let hspace = |c: char| c.is_whitespace() && c != '\r' && c != '\n';
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = block.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // try to match a separator starting at i (after trimming trailing hspace of cur)
        let mut j = i;
        if chars[j] == '\r' {
            j += 1;
        }
        let nl = if j + 1 < chars.len() && chars[j] == '\r' && chars[j + 1] == '\n' {
            Some(j + 2)
        } else if j < chars.len() && chars[j] == '\n' {
            Some(j + 1)
        } else {
            None
        };
        if let Some(mut k) = nl {
            while k < chars.len() && hspace(chars[k]) {
                k += 1;
            }
            if k < chars.len() && chars[k] == '*' {
                k += 1;
                if k < chars.len() && hspace(chars[k]) {
                    k += 1;
                }
                // the leading `[^\S\r\n]*?` eats trailing horizontal space of cur
                let trimmed = cur.trim_end_matches(hspace).len();
                cur.truncate(trimmed);
                out.push(std::mem::take(&mut cur));
                i = k;
                continue;
            }
        }
        cur.push(chars[i]);
        i += 1;
    }
    out.push(cur);
    out
}

pub fn theme_info(css: &str, file_name: &str) -> UserThemeHeader {
    let block = css
        .split_once("/**")
        .map(|(_, rest)| rest.split_once("*/").map_or(rest, |(b, _)| b));

    // field -> value; presence (even with "") matters for upstream's `??` defaults
    let mut fields: HashMap<String, String> = HashMap::new();
    if let Some(block) = block.filter(|b| !b.is_empty()) {
        let mut field = String::new();
        let mut accum = String::new();
        for line in split_meta_lines(block) {
            if line.is_empty() {
                continue;
            }
            let mut cs = line.chars();
            if cs.next() == Some('@') && cs.next() != Some(' ') {
                fields.insert(std::mem::take(&mut field), accum.trim().to_owned());
                // upstream: substring(1, indexOf(" ")) / substring(l + 1); with no
                // space indexOf is -1, giving field "" and the whole line as value.
                match line.find(' ') {
                    Some(l) => {
                        field = line[1..l].to_owned();
                        accum = line[l + 1..].to_owned();
                    }
                    None => accum = line.clone(),
                }
            } else {
                accum.push(' ');
                let mut l = line.replacen("\\n", "\n", 1);
                if l.starts_with("\\@") {
                    l.replace_range(0..2, "@");
                }
                accum.push_str(&l);
            }
        }
        fields.insert(field, accum.trim().to_owned());
    }

    let n = file_name.len();
    let stem = if n >= 4 && file_name.is_char_boundary(n - 4) && file_name[n - 4..].eq_ignore_ascii_case(".css") {
        &file_name[..n - 4]
    } else {
        file_name
    };
    let mut take = |k: &str| fields.remove(k);
    UserThemeHeader {
        file_name: file_name.to_owned(),
        name: take("name").unwrap_or_else(|| stem.to_owned()),
        author: take("author").unwrap_or_else(|| "Unknown Author".into()),
        description: take("description").unwrap_or_else(|| "A Discord Theme.".into()),
        version: take("version"),
        license: take("license"),
        source: take("source"),
        website: take("website"),
        invite: take("invite"),
    }
}

pub fn list(themes_dir: &Path) -> Vec<UserThemeHeader> {
    let Ok(rd) = fs::read_dir(themes_dir) else { return vec![] };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".css"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|n| {
            let data = read(themes_dir, &n).ok()?;
            Some(theme_info(strip_bom(&data), &n))
        })
        .collect()
}

/// Upstream strips a `?v=<digits>` cache-buster before resolving.
pub fn read(themes_dir: &Path, file_name: &str) -> Result<String, String> {
    let name = match file_name.rsplit_once("?v=") {
        Some((n, v)) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => n,
        _ => file_name,
    };
    let p = safe_child(themes_dir, name).ok_or_else(|| format!("Unsafe path {file_name}"))?;
    fs::read_to_string(&p).map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bd_header() {
        let css = "/**\n * @name Mocha\n * @author someone\n * @description A theme\n *   continued\n * @version 1.2\n */\n:root{}";
        let h = theme_info(css, "mocha.theme.css");
        assert_eq!(h.name, "Mocha");
        assert_eq!(h.author, "someone");
        // upstream keeps inner spacing: only one space after `*` is eaten
        assert_eq!(h.description, "A theme   continued");
        assert_eq!(h.version.as_deref(), Some("1.2"));
    }

    #[test]
    fn defaults_without_header() {
        let h = theme_info(":root{}", "plain.css");
        assert_eq!((h.name.as_str(), h.author.as_str()), ("plain", "Unknown Author"));
        assert_eq!(h.description, "A Discord Theme.");
    }

    #[test]
    fn escaped_at_is_unescaped() {
        let css = "/**\n * @description uses\n * \\@media queries\n */";
        assert_eq!(theme_info(css, "x.css").description, "uses @media queries");
    }

    #[test]
    fn read_strips_cache_buster_and_blocks_traversal() {
        let d = std::env::temp_dir().join(format!("corvid-themes-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("a.css"), "x").unwrap();
        assert_eq!(read(&d, "a.css?v=123").unwrap(), "x");
        assert!(read(&d, "../a.css").is_err());
    }
}
