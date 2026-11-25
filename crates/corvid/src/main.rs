//! corvid: a lean, private Discord client — Discord's web app in a Rust/CEF
//! host with corvid's own mod layer (js/).
// SPDX-License-Identifier: MIT

mod cef_backend;
mod single_instance;

use std::{path::PathBuf, sync::OnceLock, time::Instant};

pub static START: OnceLock<Instant> = OnceLock::new();

/// Milliseconds since process start, for startup timing logs.
pub fn ms() -> u128 {
    START.get().map(|s| s.elapsed().as_millis()).unwrap_or(0)
}

/// Directory of the running binary (symlinks resolved).
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.canonicalize().ok()?.parent().map(PathBuf::from)
}

pub struct Options {
    pub url: String,
    pub no_sandbox: bool,
    pub remote_debugging_port: Option<u16>,
    pub smoke_js: Option<String>,
    pub new_instance: bool,
}

const USAGE: &str = "usage: corvid [OPTIONS]

  --url=URL                  start page (default https://discord.com/app)
  --remote-debugging-port=N  Chrome DevTools on localhost:N
  --no-sandbox               disable the Chromium sandbox (not recommended)
  --smoke-js=FILE            run FILE (an async function body) in the page once
                             loaded, print its result and exit (tests)
  --new-instance             don't hand off to an already running corvid

Data: $CORVID_DATA_DIR, else $XDG_CONFIG_HOME/corvid, else ~/.config/corvid
Plugin JS from disk instead of the embedded copy: CORVID_JS_DIR=<repo>/js
Other --switches are passed through to Chromium.";

fn parse_args() -> Result<Options, String> {
    let mut o = Options {
        url: "https://discord.com/app".to_owned(),
        no_sandbox: false,
        remote_debugging_port: None,
        smoke_js: None,
        new_instance: false,
    };
    let mut args = std::env::args().skip(1).peekable();
    while let Some(a) = args.next() {
        let (key, inline) = match a.split_once('=') {
            Some((k, v)) => (k.to_owned(), Some(v.to_owned())),
            None => (a.clone(), None),
        };
        let mut val = || inline.clone().or_else(|| args.next()).ok_or_else(|| format!("{key} needs a value"));
        match key.as_str() {
            "--url" => o.url = val()?,
            "--no-sandbox" => o.no_sandbox = true,
            "--new-instance" => o.new_instance = true,
            "--remote-debugging-port" => {
                o.remote_debugging_port = Some(val()?.parse().map_err(|_| "bad --remote-debugging-port")?)
            }
            "--smoke-js" => {
                let f = val()?;
                o.smoke_js = Some(std::fs::read_to_string(&f).map_err(|e| format!("{f}: {e}"))?);
                o.new_instance = true;
            }
            "-h" | "--help" => return Err(USAGE.into()),
            k if k.starts_with("--") => {} // Chromium switch
            other => return Err(format!("unexpected argument {other}\n\n{USAGE}")),
        }
    }
    Ok(o)
}

fn main() {
    START.get_or_init(Instant::now);
    // CEF re-executes this binary for its subprocesses; hand those off first.
    if let Some(code) = cef_backend::run_subprocess_if_needed() {
        std::process::exit(code);
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let opts = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let paths = corvid_core::Paths::from_env();
    // Second launch: focus the running window instead of starting CEF again.
    let listener = if opts.new_instance {
        None
    } else {
        match single_instance::claim(&paths.data_dir) {
            single_instance::Claim::Forwarded => {
                log::info!("corvid is already running; focused it");
                return;
            }
            single_instance::Claim::Owner(l) => l,
        }
    };
    let relaunch = match cef_backend::run(opts, paths, listener) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("corvid: {e}");
            std::process::exit(1);
        }
    };
    if relaunch && let Ok(exe) = std::env::current_exe() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Err(e) = std::process::Command::new(exe).args(args).spawn() {
            eprintln!("corvid: relaunch failed: {e}");
        }
    }
}
